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
    require(signer.is_signer && market.owner == program && market.data_len() == SIZE)?;
    let now = Clock::get()?.unix_timestamp;
    let mut state = market.try_borrow_mut_data()?;

    // An authority-created, rent-exempt state account defines one bilateral contract.
    // Its vault authority is the PDA derived from this account's address.
    if action == 0 {
        require(
            args.len() == 24
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

    require(state[0] == 1)?;
    let expiry = integer(&state[4..12]);
    let strike = integer(&state[12..20]);
    let contracts = integer(&state[20..28]);

    if action == 3 {
        require(
            args.len() == 8
                && signer.key == &AUTHORITY
                && now >= expiry
                && now < expiry + TIMEOUT
                && state[1] == 3
                && state[2] == 0,
        )?;
        state[28..36].copy_from_slice(&integer(args).clamp(-BAND, BAND).to_le_bytes());
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
        require(now < expiry && state[1] & mask == 0)?;
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
        return Ok(());
    }

    let long = state[1] & 1 != 0 && &state[36..68] == signer.key.as_ref() && state[3] & 1 == 0;
    let short = state[1] & 2 != 0 && &state[68..100] == signer.key.as_ref() && state[3] & 2 == 0;
    require(long || short)?;
    require(state[2] == 1 || now >= expiry + TIMEOUT || (now >= expiry && state[1] != 3))?;
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
