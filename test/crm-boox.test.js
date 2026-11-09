'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-boox-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db'), boox = require('../lib/crm/boox'), atoms = require('../lib/crm/atoms');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const T = Math.floor(Date.now()/1000), DAY=86400;
beforeEach(()=>{ db._reset(); fs.rmSync(process.env.CRM_DB_PATH,{force:true}); });
after(()=>{db._reset();fs.rmSync(tmp,{recursive:true,force:true});});
async function pdf(lines) { const d=await PDFDocument.create({updateMetadata:false}); const font=await d.embedFont(StandardFonts.Helvetica); for(const s of lines) d.addPage([400,200]).drawText(s,{x:10,y:100,size:12,font}); return Buffer.from(await d.save()); }
function notebook(id='n', kind='todos') { db.crm().prepare('INSERT INTO notebooks(id,name,created_at,modified_at,space,kind,baseline_at) VALUES(?,?,?,?,?,?,?)').run(id,'Notebook.pdf',T-30*DAY,T-10*DAY,'work',kind,T); return db.crm().prepare('SELECT * FROM notebooks WHERE id=?').get(id); }

test('old pages are history, identical exports deduplicate, and only appended fresh pages can create actions',async()=>{
  const n=notebook(); const file=await pdf(['Old promise to send a report']);
  assert.equal(await boox.capture(n,file,T),1);
  assert.equal(await boox.capture(db.crm().prepare('SELECT * FROM notebooks').get(),file,T),0);
  db.crm().prepare('UPDATE notebooks SET modified_at=?').run(T);
  assert.equal(await boox.capture(db.crm().prepare('SELECT * FROM notebooks').get(),await pdf(['Old promise to send a report','New promise to call Jane']),T),1);
  assert.deepEqual(db.crm().prepare('SELECT page_no,is_history FROM notebook_pages ORDER BY page_no').all(),[{page_no:1,is_history:1},{page_no:2,is_history:0}]);
});

test('Claude gets one PDF page, uncertain names wait for correction, and only confirmed text enters knowledge',async()=>{
  await boox.capture(notebook(),await pdf(['Call A?ec about the report']),T);
  let job={status:'pending'}; const queued=[]; const jobs={enqueue:x=>{queued.push(x);return{jobId:'j'};},getJob:()=>job};
  assert.equal(boox.enqueueNext(jobs),true); assert.equal(queued[0].feature,'crm_boox_read');
  const message=JSON.parse(require('../lib/subscription-agent').documentInput('read',queued[0].payload.documents));
  assert.equal(message.message.content[1].source.media_type,'application/pdf');
  boox.collect(jobs); assert.ok(boox.writing());
  job={status:'completed',result:{output:JSON.stringify({text:'Call [unclear] about the report',uncertain:true,reason:'Name is unclear'})}};
  boox.collect(jobs); assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM sources').get().n,0);
  const p=db.crm().prepare('SELECT * FROM notebook_pages').get(); assert.equal(p.status,'review');
  const source=boox.confirm(p.id,'Call Alec about the report'); assert.equal(source.text,'Call Alec about the report'); assert.equal(source.is_history,1);
  assert.throws(()=>boox.confirm(p.id,'changed'),/not waiting/);
});

test('journal pages never create promises even if the reader calls one a promise; lane errors are visible',async()=>{
  await boox.capture(notebook('journal','journal'),await pdf(['I will send the annual report to Jane']),T);
  let job={status:'failed',error:'usage_limit_reached'};const jobs={enqueue:()=>({jobId:'j'}),getJob:()=>job};
  boox.enqueueNext(jobs); assert.equal(boox.collect(jobs).retrying,true);
  boox.enqueueNext(jobs);job={status:'completed',result:{output:JSON.stringify({text:'I will send the annual report to Jane',uncertain:false,reason:''})}};boox.collect(jobs);
  const s=db.crm().prepare('SELECT * FROM sources').get(); assert.equal(s.kind,'journal');assert.equal(s.is_history,1);
  atoms.applyAtoms(s.id,[{statement:s.text,quote:s.text,kind:'promise',confidence:'high',promise:{direction:'mine',certainty:'clear',action:'send the annual report'}}]);
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM promises').get().n,0);
});

test('discovery paginates and only admits PDF notebooks; unknown classification is never guessed',async()=>{
  const calls=[];const drive={files:{list:async q=>{calls.push(q);return{data:q.pageToken?{files:[{id:'note',name:'Notes.pdf',mimeType:'application/pdf',createdTime:new Date((T-DAY)*1000).toISOString(),modifiedTime:new Date(T*1000).toISOString()}]}:{files:[{id:'other',name:'other.txt',mimeType:'text/plain'}],nextPageToken:'next'}};}}};
  assert.equal(await boox.discover(drive,T),1);assert.equal(calls.length,2);assert.equal(boox.list()[0].space,null);
  assert.throws(()=>boox.configure('note','maybe','journal'),/Choose/);
  boox.configure('note','personal','journal');assert.equal(boox.list()[0].space,'personal');
  assert.throws(()=>boox.configure('note','work','journal'),/already classified/);
});
