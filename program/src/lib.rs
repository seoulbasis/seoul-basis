use solana_program::program_pack::Pack;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::{pubkey, Pubkey},
    sysvar::Sysvar,
};
use spl_token::{instruction::transfer_checked, state::Account};

solana_program::entrypoint!(process_instruction);

const AUTHORITY: Pubkey = pubkey!("GphtoNwxwkbKdjLmnMrUDs24zuXmyw2ScmZ2DM81RpFr");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SIZE: usize = 100;
const LOCK_SIZE: usize = 148;
const MAX_READING_AGE: i64 = 90;
const BAND: i64 = 500;
const TIMEOUT: i64 = 86400;

fn require(condition: bool) -> ProgramResult {
    if condition {
        Ok(())
    } else {
        Err(ProgramError::InvalidArgument)
    }
}

fn integer(bytes: &[u8]) -> i64 {
    i64::from_le_bytes(bytes.try_into().expect("fixed-width field"))
}

fn process_instruction(program: &Pubkey, accounts: &[AccountInfo], input: &[u8]) -> ProgramResult {
    let (&action, args) = input
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    let mut accounts = accounts.iter();
    let signer = next_account_info(&mut accounts)?;
    let market = next_account_info(&mut accounts)?;
    require(
        signer.is_signer
            && market.owner == program
            && matches!(market.data_len(), SIZE | LOCK_SIZE),
    )?;
    let now = Clock::get()?.unix_timestamp;
    let mut state = market.try_borrow_mut_data()?;

    let lock = state.len() == LOCK_SIZE;
    if lock && action == 5 {
        require(args.len() == 32 && market.is_signer && state.iter().all(|byte| *byte == 0))?;
        let deadline = integer(&args[..8]);
        let expiry = integer(&args[8..16]);
        let target = integer(&args[16..24]);
        let direction = integer(&args[24..]);
        require(
            deadline > now
                && expiry > deadline
                && expiry <= now.saturating_add(30 * TIMEOUT)
                && (-BAND..=BAND).contains(&target)
                && matches!(direction, -1 | 1),
        )?;
        state[0] = 2;
        state[4..12].copy_from_slice(&expiry.to_le_bytes());
        state[20..28].copy_from_slice(&1i64.to_le_bytes());
        state[100..108].copy_from_slice(&deadline.to_le_bytes());
        state[108..116].copy_from_slice(&target.to_le_bytes());
        state[116..124].copy_from_slice(&direction.to_le_bytes());
        return Ok(());
    }

    // An authority-created, rent-exempt state account defines one bilateral contract.
    // Its vault authority is the PDA derived from this account's address.
    if action == 0 {
        require(
            !lock
                && args.len() == 24
                && signer.key == &AUTHORITY
                && market.is_signer
                && state.iter().all(|byte| *byte == 0),
        )?;
        let expiry = integer(&args[..8]);
        let strike = integer(&args[8..16]);
        let contracts = integer(&args[16..24]);
        require(
            expiry > now
                && expiry <= i64::MAX - TIMEOUT
                && (-499..=499).contains(&strike)
                && (1..=10_000).contains(&contracts),
        )?;
        state[0] = 1;
        state[4..28].copy_from_slice(args);
        return Ok(());
    }

    require(state[0] == if lock { 2 } else { 1 })?;
    let activated = lock && integer(&state[132..140]) != 0;
    let funding_deadline = if lock {
        integer(&state[100..108])
    } else {
        integer(&state[4..12])
    };
    if lock && action == 6 {
        require(
            args.len() == 16
                && signer.key == &AUTHORITY
                && state[1] == 3
                && !activated
                && now < funding_deadline,
        )?;
        let observed = integer(&args[..8]);
        let timestamp = integer(&args[8..]);
        let target = integer(&state[108..116]);
        let direction = integer(&state[116..124]);
        require(
            timestamp <= now
                && timestamp >= now.saturating_sub(MAX_READING_AGE)
                && timestamp > integer(&state[140..148])
                && (-BAND..=BAND).contains(&observed)
                && if direction == 1 {
                    observed >= target
                } else {
                    observed <= target
                },
        )?;
        state[124..140].copy_from_slice(args);
        return Ok(());
    }

    let expiry = integer(&state[4..12]);
    let strike = integer(&state[12..20]);
    let contracts = integer(&state[20..28]);

    if action == 3 {
        require(
            args.len() == if lock { 16 } else { 8 }
                && signer.key == &AUTHORITY
                && now >= expiry
                && now < expiry + TIMEOUT
                && state[1] == 3
                && state[2] == 0
                && (!lock || activated),
        )?;
        if lock {
            let timestamp = integer(&args[8..]);
            require(
                timestamp >= expiry
                    && timestamp <= now
                    && timestamp >= now.saturating_sub(MAX_READING_AGE),
            )?;
        }
        let final_spread = integer(&args[..8]);
        let payoff = if lock {
            final_spread.saturating_sub(integer(&state[124..132]))
        } else {
            final_spread
        };
        state[28..36].copy_from_slice(&payoff.clamp(-BAND, BAND).to_le_bytes());
        state[2] = 1;
        return Ok(());
    }

    require(args.is_empty() && matches!(action, 1 | 2 | 4))?;
    let user_token = next_account_info(&mut accounts)?;
    let vault = next_account_info(&mut accounts)?;
    let mint = next_account_info(&mut accounts)?;
    let vault_authority = next_account_info(&mut accounts)?;
    let token_program = next_account_info(&mut accounts)?;
    let (authority, bump) = Pubkey::find_program_address(&[b"vault", market.key.as_ref()], program);
    require(
        mint.key == &USDC
            && token_program.key == &spl_token::ID
            && vault_authority.key == &authority,
    )?;
    require(
        vault.owner == &spl_token::ID
            && user_token.owner == &spl_token::ID
            && vault.key != user_token.key,
    )?;
    require(
        vault.key
            == &Pubkey::find_program_address(
                &[authority.as_ref(), spl_token::ID.as_ref(), USDC.as_ref()],
                &pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
            )
            .0,
    )?;
    let vault_data = Account::unpack(&vault.try_borrow_data()?)?;
    let user_data = Account::unpack(&user_token.try_borrow_data()?)?;
    require(
        vault_data.owner == authority
            && vault_data.mint == USDC
            && user_data.owner == *signer.key
            && user_data.mint == USDC,
    )?;
    let amount_for = |value, long| {
        let distance = if long { BAND + value } else { BAND - value };
        (distance * contracts * 100_000) as u64
    };

    if action == 1 || action == 2 {
        let mask = action;
        require(now < funding_deadline && state[1] & mask == 0)?;
        if lock {
            let opposite = if action == 1 {
                &state[68..100]
            } else {
                &state[36..68]
            };
            require(opposite != signer.key.as_ref())?;
        }
        let offset = if action == 1 { 36 } else { 68 };
        let ix = transfer_checked(
            &spl_token::ID,
            user_token.key,
            mint.key,
            vault.key,
            signer.key,
            &[],
            amount_for(strike, action == 1),
            6,
        )?;
        invoke(
            &ix,
            &[
                user_token.clone(),
                mint.clone(),
                vault.clone(),
                signer.clone(),
                token_program.clone(),
            ],
        )?;
        state[offset..offset + 32].copy_from_slice(signer.key.as_ref());
        state[1] |= mask;
        if lock && state[1] == 3 {
            state[140..148].copy_from_slice(&now.to_le_bytes());
        }
        return Ok(());
    }

    let long = state[1] & 1 != 0 && &state[36..68] == signer.key.as_ref() && state[3] & 1 == 0;
    let short = state[1] & 2 != 0 && &state[68..100] == signer.key.as_ref() && state[3] & 2 == 0;
    require(long || short)?;
    let refundable = if lock && !activated {
        now >= funding_deadline
    } else {
        now >= expiry + TIMEOUT || (!lock && now >= expiry && state[1] != 3)
    };
    require(state[2] == 1 || refundable)?;
    let value = if state[2] == 1 {
        integer(&state[28..36])
    } else {
        strike
    };
    let ix = transfer_checked(
        &spl_token::ID,
        vault.key,
        mint.key,
        user_token.key,
        &authority,
        &[],
        amount_for(value, long),
        6,
    )?;
    invoke_signed(
        &ix,
        &[
            vault.clone(),
            mint.clone(),
            user_token.clone(),
            vault_authority.clone(),
            token_program.clone(),
        ],
        &[&[b"vault", market.key.as_ref(), &[bump]]],
    )?;
    state[3] |= if long { 1 } else { 2 };
    Ok(())
}
