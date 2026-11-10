'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krisp-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db'), krisp = require('../lib/crm/krisp');
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });
test('HTTP holding intake and signed-in classification keep evidence out of sources until choice', async () => {
 const express = require('express'), app = express();
 app.set('view engine','ejs'); app.set('views',path.join(__dirname,'..','views'));
 app.use(express.json({limit:'10mb'})); app.use(express.urlencoded({extended:false}));
 app.use(require('../routes/krisp-capture'));
 app.use((req,res,next)=>{req.portfolioUser='douglas';req.session={adminUser:req.headers['x-no-auth'] ? null : 'douglas'};next();});
 app.use(require('../routes/crm'));
 const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=async(payload,token='dummy',suffix='')=>{const r=await fetch(base+'/api/krisp/webhook'+suffix,{method:'POST',headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},body:JSON.stringify(payload)});return {...await r.json(),status:r.status};};
 const formFor = id => { const r=krisp.list().find(x=>x.id===id)?.review; return r?.speakers.length ? {revision:r.revision, names:r.speakers.map((x,i)=>'Person '+i)} : {}; };
 const choose=async(id,choice,extra={})=>fetch(base+`/crm/krisp/${id}/classify`,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base,...extra},body:(()=>{const f=formFor(id), b=new URLSearchParams({choice,revision:f.revision||''}); for(const n of f.names||[]) b.append('names',n); return b;})()});
 try {
  delete process.env.KRISP_WEBHOOK_SECRET; assert.equal((await post({})).status,503);
  process.env.KRISP_WEBHOOK_SECRET='dummy';
  assert.equal((await post({},'')).status,401); assert.equal((await post({},'wrong')).status,401);
  assert.equal((await post({space:'work',transcript:'Hello'})).status,400);
  for (const id of ['note-attempt-1','note-attempt-2','note-attempt-3']) {
    const note=await post({id,event:'note_generated',data:{meeting:{id:'synthetic-meeting'},sections:{action_items:null,key_points:null,outline:null},raw_content:''}});
    assert.equal(note.status,200); assert.equal(note.ignored,true); assert.equal(note.created,false);
  }
  assert.equal(db.crm().prepare('SELECT count(*) n FROM krisp_intake').get().n,0);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources').get().n,0);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources_fts').get().n,0);
  for (const event of ['transcript_created','future_unknown_event']) {
    const failed=await post({event,data:{meeting:{id:'failure-'+event}}}); assert.equal(failed.readable,false); assert.equal(failed.created,true);
  }
  assert.equal(krisp.list().filter(x=>x.status==='pending'&&!x.readable).length,2);
  db.crm().prepare('DELETE FROM krisp_intake').run();
  const segments = [{speaker:'Speaker 1',speakerIndex:1,text:'  Synthetic opening.\nSecond line.  '},{speaker:'Alex Example',speakerIndex:2,text:'Yes.'},{speakerIndex:7,text:'Unknown speaker.\n' + 'Evidence. '.repeat(5000)}];
  const actual = {id:'synthetic-event',event:'transcript_created',data:{meeting:{id:'synthetic-meeting',title:'Synthetic mobile recording',duration:2835,owner:{id:'synthetic-owner'},calendar_event_id:null,participants:[],speakers:[{index:1},{index:2,email:'alex@example.invalid',first_name:'Alex',last_name:'Example'},{index:7,email:'unknown@noemail.krisp.ai'}],start_date:'2026-11-10T12:00:00.000Z',end_date:'2026-11-10T12:47:15.000Z',url:'https://example.invalid/meeting'},content:segments}};
  const expected = segments.map(x=>`${x.speaker || 'Speaker '+x.speakerIndex}: ${x.text}`).join('\n\n');
  const delivered = await post(actual); assert.equal(delivered.readable,true);
  assert.equal(krisp.list().find(x=>x.id===delivered.id).transcript,expected);
  // Simulate the exact pre-fix raw-based identity and unreadable state.
  const oldId = require('crypto').createHash('sha256').update(JSON.stringify(['synthetic-meeting',JSON.stringify(actual)])).digest('hex');
  db.crm().prepare('UPDATE krisp_intake SET id=?, transcript=?, readable=0 WHERE id=?').run(oldId,'',delivered.id);
  const before = db.crm().prepare('SELECT * FROM krisp_intake WHERE id=?').get(oldId);
  await fetch(base+'/crm/work/meetings');
  const recovered = db.crm().prepare('SELECT * FROM krisp_intake WHERE id=?').get(oldId);
  assert.deepEqual(recovered,{...before,transcript:expected,readable:1});
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources').get().n,0);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources_fts').get().n,0);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM review_items').get().n,0);
  const resend = await post({...actual,id:'synthetic-retry'}); assert.equal(resend.id,oldId); assert.equal(resend.created,false);
  const reviewHtml=await (await fetch(base+'/crm/work/meetings')).text();
  assert.ok(reviewHtml.includes('Synthetic opening.'));
  assert.ok(reviewHtml.includes('Name for Speaker 1'));
  assert.ok(reviewHtml.includes('Release to Work'));
  const revision=/name="revision" value="([a-f0-9]+)"/.exec(reviewHtml)[1];
  const submit=async body=>fetch(base+`/crm/krisp/${oldId}/classify`,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body});
  for(const body of [new URLSearchParams({choice:'work'}),new URLSearchParams({choice:'work',revision:'stale',names:'Alex'}),new URLSearchParams({choice:'work',revision,names:'Alex'})]) assert.equal((await submit(body)).status,400);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources').get().n,0);
  const filled=new URLSearchParams({choice:'work',revision});
  for(let i=0;i<3;i++) filled.append('names','Person '+i);
  assert.equal((await submit(filled)).status,302);
  assert.equal((await submit(filled)).status,302);

  const receiptMapping=JSON.parse(db.crm().prepare('SELECT speaker_review FROM krisp_intake WHERE id=?').get(oldId).speaker_review);
  assert.equal(receiptMapping.mapping.length,3); assert.equal(receiptMapping.revision,revision);
  const recoveredIds = JSON.parse(db.crm().prepare('SELECT source_ids FROM krisp_intake WHERE id=?').get(oldId).source_ids);
  const recoveredSources = recoveredIds.map(id=>db.crm().prepare('SELECT * FROM sources WHERE id=?').get(id));
  assert.equal(recoveredSources.map(x=>x.text).join(''),segments.map((x,i)=>`Person ${i}: ${x.text}`).join('\n\n'));
  for (const source of recoveredSources) { assert.equal(source.occurred_at,1794312000); assert.equal(krisp.rawForSource(source),JSON.stringify(actual)); }
  assert.equal((await post({...actual,id:'synthetic-retry-2'})).id,oldId);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources').get().n,recoveredIds.length);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM review_items').get().n,0);
  for (const content of [[segments[0],{speaker:'Bad',text:42}], [segments[0],null], [], [{text:'Missing label'}]]) {
    const bad = await post({...actual,data:{...actual.data,content}}); assert.equal(bad.readable,false);
    assert.equal(krisp.list().find(x=>x.id===bad.id).transcript,'');
  }
  // Archived unreadable records must never be recovered by later reads.
  const archived = await post({...actual,data:{...actual.data,meeting:{id:'synthetic-archive'}}});
  krisp.classify(archived.id,'ignore');
  const ignoredRetry = await post({...actual,id:'synthetic-ignore-retry',data:{...actual.data,meeting:{id:'synthetic-archive'}}});
  assert.equal(ignoredRetry.id,archived.id); assert.equal(ignoredRetry.created,false); assert.equal(krisp.list().find(x=>x.id===archived.id).status,'ignored');
  db.crm().prepare('UPDATE krisp_intake SET readable=0, transcript=? WHERE id=?').run('',archived.id);
  krisp.list(); assert.equal(db.crm().prepare('SELECT readable FROM krisp_intake WHERE id=?').get(archived.id).readable,0);
  const decidedResend=await post({...actual,id:'synthetic-decided-retry',data:{...actual.data,meeting:{id:'synthetic-archive'}}}); assert.equal(decidedResend.id,archived.id); assert.equal(decidedResend.created,false);
  db.crm().prepare("UPDATE krisp_intake SET status='classified' WHERE id=?").run(archived.id);
  krisp.list(); assert.equal(db.crm().prepare('SELECT readable FROM krisp_intake WHERE id=?').get(archived.id).readable,0);
  const classifiedResend=await post({...actual,id:'synthetic-classified-retry',data:{...actual.data,meeting:{id:'synthetic-archive'}}}); assert.equal(classifiedResend.id,archived.id); assert.equal(classifiedResend.created,false);
  // Isolate the existing legacy HTTP assertions below.
  db.crm().prepare('DELETE FROM sources_fts').run(); db.crm().prepare('DELETE FROM sources').run(); db.crm().prepare('DELETE FROM krisp_intake').run();
  const payload={meeting:{id:'today',title:'<script>unsafe</script>',started_at:1794301200},transcript:'Alex: Yes, agreed.'};
  const r=await post(payload,'dummy','/'); assert.equal(r.status,200); assert.equal(r.created,true);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources').get().n,0);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources_fts').get().n,0);
  const legacy=await fetch(base+'/crm/krisp',{redirect:'manual'}); assert.equal(legacy.headers.get('location'),'/crm/work/meetings');
  const html=await (await fetch(base+'/crm/work/meetings')).text(); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('value="personal"'));
  assert.equal((await fetch(base+'/crm/krisp',{headers:{'x-no-auth':'1'},redirect:'manual'})).status,302);
  assert.equal((await choose(r.id,'work',{'x-no-auth':'1'})).status,302);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM sources').get().n,0);
  assert.equal((await choose(r.id,'bad')).status,400);
  assert.equal((await choose(r.id,'personal',{Origin:'https://evil.invalid'})).status,403);
  const chosen=await choose(r.id,'personal'); assert.equal(chosen.status,302); assert.equal(chosen.headers.get('location'),'/crm/work/meetings');
  const personal=await (await fetch(base+'/crm/personal/meetings')).text(); assert.ok(personal.includes('&lt;script&gt;unsafe'));
  const work=await (await fetch(base+'/crm/work/meetings')).text(); assert.ok(!work.includes('&lt;script&gt;unsafe'));
  assert.equal((await choose(r.id,'work')).status,409);
  assert.equal((await post({...payload,event_id:'retry'})).created,false);
  const s=db.crm().prepare('SELECT * FROM sources').get(); assert.equal(s.space,'personal'); assert.equal(s.occurred_at,1794301200); assert.equal(krisp.rawForSource(s),JSON.stringify(payload));
  assert.equal(krisp.rawForSource({...s,id:'spoof'}),null);
  assert.equal((await fetch(base+`/crm/personal/sources/${s.id}`)).status,200);
  require('../lib/crm/atoms').applyAtoms(s.id,[{statement:'Agreement',quote:'Yes, agreed.',kind:'fact'}]);
  const plain=await fetch(base+'/api/krisp/webhook',{method:'POST',headers:{Authorization:'Bearer dummy','Content-Type':'text/plain'},body:'not json'}); assert.equal(plain.status,415);
  require('../lib/crm/spaces').moveSource(s.id,'work','you','test');
  const moved=db.crm().prepare('SELECT * FROM sources WHERE id=?').get(s.id); assert.equal(krisp.rawForSource(moved),JSON.stringify(payload));
  const decided=await (await fetch(base+'/crm/krisp')).text(); assert.ok(decided.includes(`/crm/work/sources/${s.id}`)); assert.ok(!decided.includes(payload.transcript));
  const undated=await post({meeting:{id:'undated'},created_at:1e30,transcript:'Alex: Receipt time test'});
  const receipt=db.crm().prepare('SELECT received_at FROM krisp_intake WHERE id=?').get(undated.id).received_at;
  db.crm().prepare('UPDATE krisp_intake SET received_at=? WHERE id=?').run(receipt-100,undated.id);
  const undatedIds=krisp.classify(undated.id,'personal',formFor(undated.id)); assert.equal(db.crm().prepare('SELECT occurred_at FROM sources WHERE id=?').get(undatedIds[0]).occurred_at,receipt-100);
  const returnTest=await post({meeting:{id:'personal-return'},transcript:'Personal return'});
  const returnResult=await fetch(base+`/crm/krisp/${returnTest.id}/classify`,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({choice:'ignore',returnSpace:'personal'})}); assert.equal(returnResult.headers.get('location'),'/crm/personal/meetings');
  const unlabelled=await post({meeting:{id:'unlabelled'},transcript:'No identifiable speaker'});
  assert.equal((await choose(unlabelled.id,'work')).status,400);
  assert.equal(krisp.list().find(x=>x.id===unlabelled.id).status,'pending');
  assert.equal((await choose(unlabelled.id,'ignore')).status,302);
  const empty=await post({notes:'no transcript'}); krisp.classify(empty.id,'ignore'); assert.equal((await post({notes:'no transcript'})).status,200); assert.equal(krisp.list().find(x=>x.id===empty.id).status,'ignored');
  const long=await post({meeting:{id:'long',started_at:1794301200000},transcript:'Alex: '+ 'A long transcript. '.repeat(110000)});
  const ids=krisp.classify(long.id,'work',formFor(long.id)); assert.ok(ids.length>2);
  for(const id of ids) { const part=db.crm().prepare('SELECT * FROM sources WHERE id=?').get(id); assert.ok(part.raw_ref.length<100); assert.equal(part.occurred_at,1794301200); }
 } finally {await new Promise(r=>server.close(r));}
});
