const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync(require('path').join(__dirname,'../index.html'),'utf8');
const context={};vm.createContext(context);vm.runInContext(html.slice(html.indexOf(' function outcome('),html.indexOf(' function render() {',html.indexOf(' function outcome('))),context);
for(const entry of [-4.99,-1,0,1.27,4.99])for(const contracts of [1,7,10000])for(const final of [-5,-.5,0,2.73,5]){
 const long=context.outcome(entry,contracts,final,0,true),short=context.outcome(entry,contracts,final,0,false);
 assert(Math.abs(long.payout+short.payout-100*contracts)<1e-8);
 assert(Math.abs(long.collateral+short.collateral-100*contracts)<1e-8);
 assert(Math.abs(long.net+short.net)<1e-8);
 assert.equal(long.breakEven,entry);assert.equal(short.breakEven,entry);
 assert(long.payout>=0&&short.payout>=0);
}
const result=context.outcome(1,2,1.5,1,true);assert.equal(result.collateral,120);assert.equal(result.payout,130);assert.equal(result.net,9);assert.equal(result.breakEven,1.05);assert.equal(result.maxLoss,121);
console.log('Stress test: program-equivalent centi-pp math, conservation, endpoints, costs and break-even passed.');
