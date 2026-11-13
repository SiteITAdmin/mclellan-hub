'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-reports-'));
process.env.CRM_DB_PATH = path.join(tmp,'crm.db'); process.env.HUB_DB_PATH = path.join(tmp,'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db'), reports = require('../lib/crm/reports'), atoms = require('../lib/crm/atoms');
const sources = require('../lib/crm/sources'), review = require('../lib/crm/review'), tasks = require('../lib/crm/tasks');
const T = Date.parse('2026-11-13T12:00:00Z')/1000;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH,{force:true}); });
after(() => { db._reset(); fs.rmSync(tmp,{recursive:true,force:true}); });
function queue() {
 const q = { sent:[], job:{status:'pending'} };
 q.enqueue = j => { q.sent.push(j); return {jobId:'job-'+q.sent.length}; };
 q.getJob = () => q.job;
 q.reply = result => { q.job = {status:'completed',result:{output:JSON.stringify(result)}}; };
 return q;
}
function fact(project, text, date, {space='work', status='done'}={}) {
 const source = sources.admitSource({space,kind:'note',origin:'report-test',externalId:text,title:text,text,occurredAt:Date.parse(date)/1000}).source;
 atoms.applyAtoms(source.id,[{statement:text,kind:'fact',quote:text,confidence:'high'}]);
 db.crm().prepare('UPDATE sources SET atomise_status=? WHERE id=?').run(status,source.id);
 const atom = db.crm().prepare('SELECT a.* FROM atoms a JOIN atom_sources x ON x.atom_id=a.id WHERE x.source_id=?').get(source.id);
 if(project) db.crm().prepare('INSERT INTO atom_projects(atom_id,project_id) VALUES(?,?)').run(atom.id,project.id);
 return {source,atom};
}
function fixture() {
 const p = review.createProject('work','Roster access');
 db.crm().prepare('UPDATE projects SET about=? WHERE id=?').run('SharePoint roster access',p.id);
 const f = fact(p,'Roster access was approved on Tuesday.','2026-11-10T10:00:00Z');
 fact(p,'Roster access still needed approval in October.','2026-10-05T10:00:00Z');
 fact(p,'Future roster announcement','2026-12-01T10:00:00Z');
 fact(p,'HELD roster secret','2026-11-11T10:00:00Z',{status:'held'});
 fact(null,'Unrelated payroll decision','2026-11-11T10:00:00Z');
 fact(null,'PRIVATE roster decision','2026-11-11T10:00:00Z',{space:'personal'});
 return {p,...f};
}
const reply = key => ({sections:[{heading:'Progress',paragraphs:[{text:'Roster access was approved.',kind:'evidence',refs:[key]}]}],gaps:['The records do not give an implementation date.']});

test('calendar periods have Monday weeks, leap months, year boundaries and calendar quarters', () => {
 assert.deepEqual(reports.period('weekly','2026-11-15'),{from:'2026-11-09',to:'2026-11-15'});
 assert.deepEqual(reports.period('monthly','2024-02-20'),{from:'2024-02-01',to:'2024-02-29'});
 assert.deepEqual(reports.period('quarterly','2026-12-31'),{from:'2026-10-01',to:'2026-12-31'});
 assert.deepEqual(reports.period('weekly','2027-01-01'),{from:'2026-12-28',to:'2027-01-03'});
 assert.throws(()=>reports.period('monthly','2026-02-30'),/valid date/);
 assert.throws(()=>reports.options('work',{kind:'topic',question:'x',from:'2026-11-12',to:'2026-11-01'},T),/end date/);
 assert.throws(()=>reports.options('work',{kind:'topic',question:'x',from:'2027-01-01'},T),/end date|already started/);
});

test('project report uses admitted source-backed facts, labels background and current tasks, and snapshots evidence', () => {
 const f = fixture(), q = queue();
 const task=tasks.create('work',{title:'Review roster access',context:{projectId:f.p.id}});
 db.crm().prepare('UPDATE tasks SET created_at=? WHERE id=?').run(T-60,task.id);
 const input = {kind:'weekly',anchor:'2026-11-13',projectId:f.p.id};
 const r = reports.create('work',input,{jobs:q,t:T});
 const packet = JSON.parse(q.sent[0].payload.userPrompt);
 assert.equal(q.sent[0].feature,'crm_report'); assert.equal(q.sent[0].payload.model,'opus');
 assert.equal(packet.project.about,'SharePoint roster access');
 assert.match(q.sent[0].payload.userPrompt,/older background/);
 assert.doesNotMatch(q.sent[0].payload.userPrompt,/HELD|PRIVATE|Future|payroll/);
 assert.equal(packet.coverage.includedFacts,1); assert.equal(packet.coverage.currentTasks,1);
 assert.equal(packet.coverage.partialPeriod,true);
 const e = packet.evidence.find(e=>e.id===f.atom.id);
 assert.equal(e.sources[0].date,'2026-11-10');
 assert.equal(JSON.parse(r.evidence).find(e=>e.id===f.atom.id).sources[0].id,f.source.id);
 assert.equal(reports.create('work',input,{jobs:q,t:T+1}).id,r.id); assert.equal(q.sent.length,1);
 q.reply(reply(e.key));
 const done = reports.collect(r,{jobs:q,t:T+60});
 assert.equal(done.status,'done');
 assert.equal(reports.shown(done).sections[0].paragraphs[0].citations[0].sources[0].id,f.source.id);
 db.crm().prepare('UPDATE atoms SET statement=? WHERE id=?').run('Changed later',f.atom.id);
 assert.match(reports.text(done),/Roster access was approved/);
 assert.doesNotMatch(reports.text(done),new RegExp(f.source.id));
 assert.equal(reports.get(r.id,'personal'),null);
});

test('historical reports retain superseded assertions without claiming current task completion in that period', () => {
 const f=fixture(), q=queue();
 db.crm().prepare("UPDATE atoms SET status='superseded' WHERE id=?").run(f.atom.id);
 const r=reports.create('work',{kind:'monthly',anchor:'2026-11-01',projectId:f.p.id},{jobs:q,t:T});
 const packet=JSON.parse(q.sent[0].payload.userPrompt);
 assert.equal(packet.evidence.find(e=>e.id===f.atom.id).status,'superseded');
 assert.match(reports.SYSTEM_PROMPT,/Completion dates are unknown/);
 assert.equal(r.status,'waiting');
});

test('topic reports search within one space and optional project; no evidence avoids a model job', () => {
 const f=fixture(), q=queue();
 const r=reports.create('work',{kind:'topic',question:'Roster access',from:'2026-11-09',to:'2026-11-13'},{jobs:q,t:T});
 assert.equal(r.kind,'topic'); assert.doesNotMatch(q.sent[0].payload.userPrompt,/PRIVATE|HELD/);
 const empty=reports.create('work',{kind:'topic',question:'unfindablezebra'},{jobs:q,t:T});
 assert.equal(empty.status,'done'); assert.equal(q.sent.length,1); assert.match(reports.shown(empty).gaps[0],/No eligible evidence/);
 assert.throws(()=>reports.create('personal',{kind:'weekly',projectId:f.p.id},{jobs:q,t:T}),/Project not found/);
 assert.throws(()=>reports.create('work',{kind:'topic',question:''},{jobs:q,t:T}),/Enter the question/);
 assert.throws(()=>reports.create('work',{kind:'weekly'},{jobs:q,t:T}),/Choose a project/);
});

test('malformed replies and invented references fail visibly, failed jobs can retry, waiting jobs stay deduplicated', () => {
 const f=fixture(),q=queue(), input={kind:'weekly',projectId:f.p.id,anchor:'2026-11-13'};
 const r=reports.create('work',input,{jobs:q,t:T});
 assert.equal(reports.collect(r,{jobs:q,t:T+1300}).slow,true);
 q.reply(reply('E999'));
 assert.equal(reports.collect(r,{jobs:q,t:T+1301}).status,'failed');
 const retry=reports.create('work',input,{jobs:q,t:T+1302}); assert.notEqual(retry.id,r.id);
 q.job={status:'failed',error:'No provider capacity'};
 assert.match(reports.collect(retry,{jobs:q,t:T+1400}).error,/capacity/);
 assert.throws(()=>reports.clean({sections:'bad',gaps:[]},[]),/sections/);
 assert.throws(()=>reports.clean(reply('E1'),[]),/valid evidence/);
});

test('HTTP report screens enforce auth, space and same-origin writes, render escaped narrative and downloadable reports', async () => {
 const f=fixture(),q=queue();
 const r=reports.create('work',{kind:'weekly',projectId:f.p.id,anchor:'2026-11-13'},{jobs:q,t:T});
 const key=JSON.parse(r.evidence)[0].key;
 const answer=reply(key); answer.sections[0].paragraphs[0].text='<script>bad()</script> Access was approved.';
 q.reply(answer); reports.collect(r,{jobs:q,t:T+2});
 const express=require('express'), app=express();
 app.set('view engine','ejs'); app.set('views',path.join(__dirname,'..','views')); app.use(express.urlencoded({extended:true}));
 app.use((req,res,next)=>{req.portfolioUser='douglas';req.session={adminUser:req.headers['x-test-auth']==='no'?'':'douglas'};next();});
 app.use(require('../routes/crm')); const server=app.listen(0),base=`http://127.0.0.1:${server.address().port}`;
 try {
  const url=`/crm/work/reports/${r.id}`;
  assert.equal((await fetch(base+url,{headers:{'x-test-auth':'no'},redirect:'manual'})).status,302);
  assert.equal((await fetch(base+`/crm/personal/reports/${r.id}`)).status,404);
  assert.equal((await fetch(base+'/crm/work/reports',{method:'POST',headers:{origin:'https://evil.test'}})).status,403);
  const form=await fetch(base+`/crm/work/reports?projectId=${f.p.id}`); assert.equal(form.status,200); assert.match(await form.text(),/Quarterly/);
  const html=await (await fetch(base+url)).text(); assert.match(html,/&lt;script&gt;/); assert.doesNotMatch(html,/<script>bad/); assert.match(html,/Download text/); assert.doesNotMatch(html,/\/crm\/work\/(sources|tasks)\//);
  const download=await fetch(base+url+'/download'); assert.match(download.headers.get('content-disposition'),/attachment/); assert.match(await download.text(),/Roster access/);
  const project=await (await fetch(base+`/crm/work/projects/${f.p.id}`)).text(); assert.match(project,/Project reports/);
  const created=await fetch(base+'/crm/work/reports',{method:'POST',redirect:'manual',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:'kind=topic&question=unfindablezebra'}); assert.equal(created.status,302);
  const invalid=await fetch(base+'/crm/work/reports',{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:'kind=topic&question='}); assert.equal(invalid.status,400); assert.match(await invalid.text(),/Enter the question/);
 } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('unfiled tasks remain candidates for synthesis rather than disappearing from project reports', () => {
 const f=fixture(),q=queue();
 const task=tasks.create('work',{title:'Confirm the roster membership'});
 db.crm().prepare('UPDATE tasks SET created_at=? WHERE id=?').run(T-60,task.id);
 const r=reports.create('work',{kind:'weekly',projectId:f.p.id,anchor:'2026-11-13'},{jobs:q,t:T});
 const candidate=JSON.parse(r.evidence).find(e=>e.id===task.id);
 assert.match(candidate.relevance,/candidate only/);
 assert.match(reports.SYSTEM_PROMPT,/may not belong/);
});

test('recording metadata stays internal while reports and downloads use dated narrative attribution', async () => {
 const f=fixture(),q=queue();
 db.crm().prepare("UPDATE sources SET kind='meeting',title='Mobile recording - November 10, 2026 (part 1 of 4)' WHERE id=?").run(f.source.id);
 const r=reports.create('work',{kind:'monthly',projectId:f.p.id,anchor:'2026-11-13'},{jobs:q,t:T});
 const packet=JSON.parse(q.sent[0].payload.userPrompt);
 const source=packet.evidence.find(e=>e.id===f.atom.id).sources[0];
 assert.deepEqual([source.context,source.date],['Meeting','2026-11-10']);
 assert.doesNotMatch(q.sent[0].payload.userPrompt,/Mobile recording|part 1 of 4/);
 assert.match(r.evidence,/Mobile recording/);
 const answer=reply(packet.evidence[0].key);
 answer.sections[0].paragraphs[0].text='At the meeting on 10 November 2026, roster access was approved.';
 q.reply(answer); const done=reports.collect(r,{jobs:q,t:T+1});
 const out=reports.text(done);
 assert.match(out,/At the meeting on 10 November 2026/);
 assert.doesNotMatch(out,/Mobile recording|part 1 of 4|https:\/\/|matching period facts|task candidates/);
 const ejs=require('ejs');
 const html=await ejs.renderFile(path.join(__dirname,'../views/crm/report.ejs'),{report:reports.shown(done),space:'work',page:'reports',title:done.title,flash:null,reviewAll:0,whatsappWaiting:0,icon:require('../lib/crm/icons'),fmt:()=> '13 November'});
 assert.match(html,/At the meeting on 10 November 2026/);
 assert.doesNotMatch(html,/Mobile recording|part 1 of 4|report-citations|\/crm\/work\/sources\//);
 const rewritten=reports.rewrite(done.id,'work',{jobs:q,t:T+2});
 assert.equal(rewritten.id,done.id); assert.equal(rewritten.status,'waiting'); assert.equal(rewritten.evidence,done.evidence);
 assert.equal(reports.rewrite(done.id,'work',{jobs:q,t:T+3}).job_id,rewritten.job_id);
 assert.equal(q.sent.length,2);
 q.reply(answer); assert.equal(reports.collect(rewritten,{jobs:q,t:T+4}).status,'done');
 assert.throws(()=>reports.rewrite(done.id,'personal',{jobs:q,t:T}),/not found/);
});
