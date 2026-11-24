const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync(require('path').join(__dirname,'../index.html'),'utf8');
for(const [,script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if(!script.includes("import ")) new vm.Script(script);
const fn=html.slice(html.indexOf('function fingerprintMatches('),html.indexOf('function renderFingerprints('));
const ctx={};vm.createContext(ctx);vm.runInContext(fn,ctx);
const rows=Array.from({length:1600},(_,i)=>({time:1700000000000+i*15000,Spread:Math.sin(i/30)*.08}));
const matches=ctx.fingerprintMatches(rows,'Spread',rows.at(-1).time,900000);
assert(matches.length>0);
for(const m of matches){assert(m.end.time<=rows.at(-1).time-600000);assert(m.end.time-m.row.time>=900000);}
for(let i=0;i<matches.length;i++)for(let j=i+1;j<matches.length;j++)assert(Math.abs(matches[i].row.time-matches[j].row.time)>=900000);
assert.equal(ctx.fingerprintMatches(rows.slice(0,10),'Spread',rows[9].time,900000).length,0);
assert.equal(ctx.fingerprintMatches(rows,'Spread',rows.at(-1).time,86400000).length,0);
const gaps=rows.filter((_,i)=>i%2===0).map((r,i)=>({...r,time:1700000000000+i*60000}));
assert.equal(ctx.fingerprintMatches(gaps,'Spread',gaps.at(-1).time,900000).length,0);
console.log('Passed: scripts parse, real completed outcomes, separated matches, insufficient history and gap exclusion.');
