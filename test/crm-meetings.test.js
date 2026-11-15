'use strict';
const {test,beforeEach,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'crm-meetings-'));
process.env.CRM_DB_PATH=path.join(tmp,'crm.db');process.env.HUB_DB_PATH=path.join(tmp,'hub.db');process.env.HUB_DISABLE_JOBS='1';
const db=require('../lib/crm/db'),m=require('../lib/crm/meetings'),sources=require('../lib/crm/sources'),atoms=require('../lib/crm/atoms'),identity=require('../lib/crm/identity');
const T=Math.floor(Date.parse('2026-11-10T09:00:00Z')/1000);
beforeEach(()=>{db._reset();fs.rmSync(process.env.CRM_DB_PATH,{force:true});});after(()=>{db._reset();fs.rmSync(tmp,{recursive:true,force:true});});
function fixture(){
 const p=identity.createPerson({space:'work',name:'Jane Whelan'});identity.linkIdentifier(p.id,'email','jane@example.com');
 const text='Jane Whelan is reviewing Purview licensing for the rollout.';
 const s=sources.admitSource({space:'work',kind:'note',origin:'test',externalId:'s',title:'Prior decision',text,occurredAt:T-86400}).source;
 atoms.applyAtoms(s.id,[{statement:text,kind:'decision',quote:text,people:['Jane Whelan'],topics:['Purview'],confidence:'high'}]);
 db.crm().prepare(`INSERT INTO calendar_events(id,calendar_id,space,title,start_at,end_at,attendees,description) VALUES('e','work','work','Purview discussion',?,?,?,?)`)
 .run(T+3600,T+7200,JSON.stringify([{email:'jane@example.com',name:'Jane'}]),'Discuss licence choices.');
 return {person:p,source:s,event:db.crm().prepare('SELECT * FROM calendar_events').get(),fact:db.crm().prepare('SELECT * FROM atoms').get()};
}
test('calendar evidence is immutable, links exact attendees, and prep keeps only cited same-space facts',()=>{
 const f=fixture();const s=m.captureEvent(f.event,T);assert.equal(s.created,true);assert.equal(m.captureEvent(f.event,T).created,false);assert.equal(s.source.is_history,1);
 identity.createPerson({space:'personal',name:'Jane Whelan'});
 assert.deepEqual(m.participants(f.event).map(p=>p.id),[f.person.id]);
 let job={status:'pending'};const queued=[];const jobs={enqueue:q=>{queued.push(q);return{jobId:'job'};},getJob:()=>job};
 assert.equal(m.enqueueNext(jobs,T),true);assert.match(queued[0].payload.userPrompt,/Prior|licensing/);
 job={status:'completed',result:{output:JSON.stringify({lines:[{text:'Jane is reviewing Purview licensing.',facts:[f.fact.id]},{text:'Invented claim',facts:['bad']} ]})}};
 m.collect(jobs,T+5);const shown=m.today('work',T+5)[0];assert.equal(shown.lines.length,1);assert.equal(shown.lines[0].sources[0].id,f.source.id);
 assert.equal(m.today('personal',T).length,0);assert.equal(m.enqueueNext(jobs,T+6),false);
 db.crm().prepare("UPDATE atoms SET status='superseded' WHERE id=?").run(f.fact.id);assert.equal(m.today('work',T+10)[0].lines.length,0);
});
test('a moved or cancelled meeting discards an in-flight prep; failures are visible and retries bounded',()=>{
 fixture();let job={status:'pending'};const jobs={enqueue:()=>({jobId:'j'}),getJob:()=>job};m.enqueueNext(jobs,T);
 db.crm().prepare("UPDATE calendar_events SET title='Different purpose' WHERE id='e'").run();m.collect(jobs,T+10);assert.equal(m.writing(),undefined);
 m.enqueueNext(jobs,T+11);job={status:'failed',error:'usage_limit_reached'};m.collect(jobs,T+12);assert.equal(m.today('work',T+12)[0].error,'usage_limit_reached');
 assert.equal(m.enqueueNext(jobs,T+13),false);
 db.crm().prepare("DELETE FROM calendar_events WHERE id='e'").run();assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM meeting_preps').get().n,0);
 assert.equal(m.enqueueNext(jobs,T+86400),false);
});
test('every meeting has a title: Douglas, then the calendar, then the recording, then who spoke, then the date',()=>{
 const krisp=require('../lib/crm/krisp');process.env.KRISP_WEBHOOK_SECRET='x';
 const start=Math.floor(Date.parse('2026-11-10T15:11:00Z')/1000);
 const got=krisp.receive({event:'transcript_created',meeting:{id:'k1',title:'Mobile recording - November 10, 2026 3:11 p.m.',started_at:start},
  data:{content:[{speakerIndex:0,text:'I will send the folder list.'},{speakerIndex:1,text:'Thanks, I will ask Rob.'}]}});
 const held=krisp.list().find(d=>d.id===got.id);
 assert.equal(m.naming({key:got.id,recorded:held.title,event:null,occurred_at:start,names:[]}).title,'Meeting on Tue 10 Nov');
 krisp.classify(got.id,'work',{revision:held.review.revision,names:['Douglas McLellan','Margaret Callanan']});
 let r=m.recordings('work')[0];
 assert.equal(r.title,'Meeting with Margaret Callanan');assert.equal(r.by,'people');assert.equal(r.recorded,'');
 db.crm().prepare(`INSERT INTO calendar_events(id,calendar_id,space,title,start_at,end_at,attendees,description) VALUES('c1','work','work','',?,?,'[]','')`).run(start-300,start+3300);
 r=m.recordings('work')[0];assert.equal(r.event.id,'c1');assert.equal(r.title,'Meeting with Margaret Callanan');
 db.crm().prepare("UPDATE calendar_events SET title='(No title)' WHERE id='c1'").run();
 r=m.recordings('work')[0];assert.equal(r.title,'Meeting with Margaret Callanan','the sync’s placeholder for an untitled entry is not a title');assert.equal(r.by,'people');
 db.crm().prepare("UPDATE calendar_events SET title='M365 chat' WHERE id='c1'").run();
 r=m.recordings('work')[0];assert.equal(r.title,'M365 chat');assert.equal(r.by,'calendar');
 assert.equal(m.rename(got.id,'  Patient services   drive  '),'Patient services drive');
 r=m.recordings('work')[0];assert.equal(r.title,'Patient services drive');assert.equal(r.by,'you');assert.equal(r.auto,'M365 chat');assert.equal(r.calendar,'M365 chat');
 m.rename(got.id,'Second go');assert.equal(m.recordings('work')[0].title,'Second go');
 m.rename(got.id,'');r=m.recordings('work')[0];assert.equal(r.title,'M365 chat');assert.equal(r.by,'calendar');
 assert.throws(()=>m.rename('nope','x'),/Meeting not found/);assert.throws(()=>m.rename(got.id,'x'.repeat(201)),/under 200/);
 const note=sources.admitSource({space:'work',kind:'meeting',origin:'note',externalId:'n1',title:'Board away day',text:'Jane: we agreed the budget.',occurredAt:start+86400}).source;
 const plain=sources.admitSource({space:'work',kind:'meeting',origin:'note',externalId:'n2',title:'Untitled',text:'Jane: nothing else.',occurredAt:start+2*86400}).source;
 const email=sources.admitSource({space:'work',kind:'note',origin:'test',externalId:'n3',title:'Not a meeting',text:'x',occurredAt:start}).source;
 const all=m.recordings('work');
 assert.deepEqual(all.map(x=>[x.key,x.title,x.by]),[[plain.id,'Meeting on Thu 12 Nov','date'],[note.id,'Board away day','recording'],[got.id,'M365 chat','calendar']]);
 assert.throws(()=>m.rename(email.id,'x'),/Meeting not found/);
 m.rename(plain.id,'Catch-up with Jane');assert.equal(m.recordings('work')[0].title,'Catch-up with Jane');
});
test('the Meetings page gives every meeting a title, keeps finished tasks in their own meeting, and renames from the page',async()=>{
 const krisp=require('../lib/crm/krisp');process.env.KRISP_WEBHOOK_SECRET='x';
 const c=db.crm(),at=iso=>Math.floor(Date.parse(iso)/1000);
 const record=(id,title,start,names)=>{const got=krisp.receive({event:'transcript_created',meeting:{id,title,started_at:start},
   data:{content:names.map((n,i)=>({speakerIndex:i,text:`${n} said something about ${id}.`}))}});
  const held=krisp.list().find(d=>d.id===got.id);krisp.classify(got.id,'work',{revision:held.review.revision,names});return got.id;};
 const m365=record('k1','Mobile recording - November 11, 2026 11:03 a.m.',at('2026-11-11T11:03:00Z'),['Douglas McLellan','Ken Byrne']);
 const drive=record('k2','Mobile recording - November 10, 2026 3:11 p.m.',at('2026-11-10T15:11:00Z'),['Douglas McLellan','Margaret Callanan']);
 c.prepare(`INSERT INTO calendar_events(id,calendar_id,space,title,start_at,end_at,attendees,description) VALUES('c1','work','personal','M365 chat',?,?,'[]','')`).run(at('2026-11-11T11:00:00Z'),at('2026-11-11T12:00:00Z'));
 c.prepare(`INSERT INTO calendar_events(id,calendar_id,space,title,start_at,end_at,attendees,description) VALUES('c2','work','work','(No title)',?,?,'[]','')`).run(at('2026-11-10T15:00:00Z'),at('2026-11-10T16:00:00Z'));
 const src=key=>c.prepare("SELECT id FROM sources WHERE raw_ref=?").get(`krisp-intake:${key}`).id;
 const task=(id,key,title,status)=>c.prepare("INSERT INTO tasks(id,space,title,status,source_id,origin) VALUES(?,?,?,?,?,'test')").run(id,'work',title,status,src(key));
 task('t1',m365,'Build a SharePoint app for on-call and holiday tracking','needsAction');
 task('t2',m365,'Lock down Teams before rollout to prevent uncontrolled team creation','completed');
 task('t3',drive,'Train Margaret Callanan on using Copilot','needsAction');
 krisp.receive({event:'transcript_created',meeting:{id:'k3',title:'Mobile recording - November 14, 2026 9:00 a.m.',started_at:at('2026-11-14T09:00:00Z')},data:{content:[{speakerIndex:0,text:'Hello there.'}]}});
 const waiting=krisp.list().find(d=>d.status==='pending').id;
 const app=require('express')();app.set('view engine','ejs');app.set('views',path.join(__dirname,'..','views'));app.use(require('express').urlencoded({extended:false}));
 const session={adminUser:'douglas'};app.use((req,res,next)=>{req.portfolioUser='douglas';req.session=session;next();});app.use(require('../routes/crm'));
 const server=app.listen(0);const base=`http://127.0.0.1:${server.address().port}`;
 const page=async()=>{const res=await fetch(`${base}/crm/work/meetings`);assert.equal(res.status,200);return res.text();};
 const post=body=>fetch(`${base}/crm/work/meetings/title`,{method:'POST',redirect:'manual',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
 try{
  let html=await page();
  const titles=[...html.matchAll(/<h3 class="meeting-title">([^<]*)<\/h3>/g)].map(x=>x[1]);
  assert.deepEqual(titles,['Meeting on Sat 14 Nov','M365 chat','Meeting with Margaret Callanan']);
  assert.ok(!/\(No title\)/.test(html));assert.ok(!/class="done"/.test(html),'a finished task must not pick up the round tick-button style');
  const card=id=>html.slice(html.indexOf(`id="m-${id}"`),html.indexOf('</article>',html.indexOf(`id="m-${id}"`)));
  assert.match(card(m365),/class="is-done"[^]*Lock down Teams/);assert.match(card(m365),/1 open, 1 done/);assert.ok(!card(drive).includes('Lock down Teams'));
  assert.match(card(drive),/named after who spoke/);assert.match(card(m365),/filed as Personal there/);
  assert.ok(html.indexOf('id="recorders"')>html.indexOf(`id="m-${drive}"`),'recorder connections sit below the meetings');
  assert.match(html.slice(html.indexOf('id="recorders"')),/Krisp[^]*Configured[^]*Wispr Flow/);
  let res=await post({key:m365,title:'M365 rollout with Ken'});assert.equal(res.status,302);assert.equal(res.headers.get('location'),`/crm/work/meetings#m-${m365}`);
  html=await page();assert.match(card(m365),/<h3 class="meeting-title">M365 rollout with Ken<\/h3>/);assert.match(card(m365),/as “M365 chat”/);assert.match(card(m365),/Use the calendar title “M365 chat”/);
  await post({key:m365,title:'ignored',reset:'1'});html=await page();assert.match(card(m365),/<h3 class="meeting-title">M365 chat<\/h3>/);
  await post({key:waiting,title:'Saturday catch-up'});html=await page();assert.match(card(waiting),/<h3 class="meeting-title">Saturday catch-up<\/h3>/);
  const held=krisp.list().find(d=>d.id===waiting);krisp.classify(waiting,'work',{revision:held.review.revision,names:['Douglas McLellan']});
  assert.equal(m.recordings('work')[0].title,'Saturday catch-up','a title given while waiting stays after release');
  res=await post({key:'missing',title:'x'});assert.equal(res.status,302);assert.match(await page(),/Meeting not found/);
  delete process.env.KRISP_WEBHOOK_SECRET;assert.match(await page(),/Krisp intake is not configured[^]*See the connections below/);
 }finally{server.close();}
});
