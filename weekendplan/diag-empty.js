const fs=require('fs'),p=require('path'),R=p.dirname(__dirname);
const {chromium}=require('playwright');
const pick=[];
for(const L of 'abcdefghijklmnopqrstuvwxyz'.split('')){
  const f=p.join(R,L,'results.json'); if(!fs.existsSync(f))continue;
  let d;try{d=JSON.parse(fs.readFileSync(f,'utf8'))}catch{continue}
  for(const x of d) if(!(x.jobs||[]).length && x.careers && x.source!=='rendered') pick.push(x);
}
const seen={},s=[];
for(const x of pick){const k=x.company[0].toLowerCase();if((seen[k]=(seen[k]||0)+1)<=1&&s.length<10)s.push(x);}
(async()=>{
  const b=await chromium.launch({headless:true});
  const ctx=await b.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'});
  for(const c of s){
    const pg=await ctx.newPage();let v={};
    try{
      await pg.goto(c.careers,{waitUntil:'domcontentloaded',timeout:20000});
      await pg.waitForTimeout(3000);
      v=await pg.evaluate(()=>{
        const t=(document.body&&document.body.innerText)||'';
        return {len:t.length,
          noOpen:/no (current |open )?(opening|vacanc|position|job)|not hiring|check back|no results found|0 (jobs|openings|results)/i.test(t),
          login:/sign in|log in|create an account|register to apply/i.test(t),
          jobWords:(t.match(/\b(engineer|developer|manager|analyst)\b/gi)||[]).length};
      });
    }catch(e){v={err:String(e.message).slice(0,28)}}
    await pg.close().catch(()=>{});
    console.log(c.company.slice(0,24).padEnd(25)+'txt='+String(v.len||0).padStart(6)+' roleWords='+String(v.jobWords||0).padStart(4)+' noOpenMsg='+(v.noOpen?'Y':'.')+' login='+(v.login?'Y':'.')+(v.err?'  ERR '+v.err:''));
  }
  await b.close();
})();
