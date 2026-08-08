const fs=require('fs'),p=require('path'),R='/Users/longfloat/deletelater/jobs';
const {chromium}=require('playwright');
const pick=[];
for(const L of 'abcdefghijklmnopqrstuvwxyz'.split('')){
  const f=p.join(R,L,'results.json'); if(!fs.existsSync(f))continue;
  let d; try{d=JSON.parse(fs.readFileSync(f,'utf8'))}catch{continue}
  for(const x of d) if(!(x.jobs||[]).length && x.careers && /lists-no-openings|no-job-data-found/.test(x.error||'')) pick.push(x);
}
// spread across letters, prefer recognisable employers
const seen={},s=[];
for(const x of pick){const k=x.company[0].toLowerCase();if((seen[k]=(seen[k]||0)+1)<=1&&s.length<14)s.push(x);}
(async()=>{
  const b=await chromium.launch({headless:true});
  const ctx=await b.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',viewport:{width:1440,height:900}});
  for(const c of s){
    const pg=await ctx.newPage();
    let info={frames:0,iframeSrcs:[],txt:0,jobLinks:0,noOpen:false,err:''};
    try{
      await pg.goto(c.careers,{waitUntil:'domcontentloaded',timeout:25000});
      await pg.waitForTimeout(3000);
      await pg.waitForLoadState('networkidle',{timeout:6000}).catch(()=>{});
      const fr=pg.frames();
      info.frames=fr.length;
      info.iframeSrcs=fr.slice(1).map(f=>f.url()).filter(u=>u&&u!=='about:blank').slice(0,3);
      const t=await pg.evaluate(()=>document.body?document.body.innerText:'');
      info.txt=t.length;
      info.noOpen=/no (current |open )?(openings|vacanc|positions|jobs)|no results|check back|currently.*no.*opening/i.test(t);
      info.jobLinks=await pg.evaluate(()=>[...document.querySelectorAll('a[href]')].filter(a=>/job|career|position|opening|vacanc|requisition/i.test(a.href)).length);
    }catch(e){info.err=String(e.message).slice(0,40)}
    await pg.close().catch(()=>{});
    console.log(c.company.slice(0,26).padEnd(27)+'frames='+String(info.frames).padStart(2)+' txt='+String(info.txt).padStart(6)+' jobLinks='+String(info.jobLinks).padStart(4)+' noOpenMsg='+(info.noOpen?'Y':'.')+(info.iframeSrcs.length?'  IFRAME: '+info.iframeSrcs.map(u=>u.slice(0,58)).join(' | '):'')+(info.err?'  ERR '+info.err:''));
  }
  await b.close();
})();
