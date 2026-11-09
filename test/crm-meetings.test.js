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
