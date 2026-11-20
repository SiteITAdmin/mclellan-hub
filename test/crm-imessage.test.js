'use strict';
const {test,beforeEach,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),os=require('os'),path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'crm-imessage-'));process.env.CRM_DB_PATH=path.join(tmp,'crm.db');process.env.HUB_DB_PATH=path.join(tmp,'hub.db');process.env.HUB_DISABLE_JOBS='1';
const db=require('../lib/crm/db'),im=require('../lib/crm/imessage'),identity=require('../lib/crm/identity'),worker=require('../scripts/imessage-capture-worker');
const T=db.now();beforeEach(()=>{db._reset();fs.rmSync(process.env.CRM_DB_PATH,{force:true});});after(()=>{db._reset();fs.rmSync(tmp,{recursive:true,force:true});});
function person(name,phone,space='personal'){const p=identity.createPerson({name,space});identity.linkIdentifier(p.id,'phone',phone);return p;}
function msg(extra={}){return{id:'m',chat_id:'c',participants:['+353871234567'],sender:'+353871234567',from_me:false,sent_at:T-10,body:'I will bring the signed report tomorrow.',...extra};}
test('only known same-space participants are captured, duplicates are ignored, and a quiet chat becomes cited source text',()=>{
 person('Jane Whelan','+353871234567');person('Work colleague','+353871234568','work');
 assert.match(im.receive(msg({participants:['+353871234567','+353871234568']}),T).skipped,/mixed-space/);
 assert.match(im.receive(msg({participants:['+353879999999']}),T).skipped,/unknown/);
 assert.equal(im.receive(msg(),T).captured,true);assert.equal(im.receive(msg(),T).captured,false);
 assert.equal(im.settle(T+200).sources,0);assert.equal(im.settle(T+301).sources,1);
 const s=db.crm().prepare('SELECT * FROM sources').get();assert.equal(s.space,'personal');assert.match(s.text,/Jane Whelan: I will bring/);
 assert.equal(require('../lib/crm/sources').sourcePeople(s.id)[0].name,'Jane Whelan');
});
test('pause rejects capture, old messages stay out, unreadable content is visible, and private contacts never leave the Mac',()=>{
 person('Jane Whelan','+353871234567');assert.match(im.receive(msg({sent_at:T-8*86400}),T).skipped,/window/);
 im.receive(msg({body:'',reason:'Attachment without text'}),T);assert.equal(db.crm().prepare('SELECT readable FROM sources').get().readable,0);
 const beat=im.heartbeat({});const row={participants:['+353871234567'],sender:'+353871234567'};
 assert.equal(worker.eligible(row,beat,new Set()),true);assert.equal(worker.eligible(row,beat,worker.privateValues({contacts:[{phone:'+353871234567'}]})),false);
 db.setSetting('imessage_paused','1');assert.throws(()=>im.receive(msg(),T),/paused/);assert.deepEqual(im.heartbeat({}).identifiers,[]);
});
test('the Mac reader reads a nanosecond-dated chat.db with built-in SQLite, keeps only eligible chats and reports to the Hub',async()=>{
 const {DatabaseSync}=require('node:sqlite');const root=fs.mkdtempSync(path.join(tmp,'mac-'));const chat=path.join(root,'chat.db');
 const d=new DatabaseSync(chat);const APPLE=978307200,ns=s=>BigInt(s-APPLE)*1000000000n;
 d.exec(`CREATE TABLE message(ROWID INTEGER PRIMARY KEY,guid TEXT,text TEXT,attributedBody BLOB,date INTEGER,is_from_me INTEGER,cache_has_attachments INTEGER,handle_id INTEGER,is_system_message INTEGER DEFAULT 0,associated_message_type INTEGER DEFAULT 0);
  CREATE TABLE handle(ROWID INTEGER PRIMARY KEY,id TEXT);CREATE TABLE chat(ROWID INTEGER PRIMARY KEY,guid TEXT);
  CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);
  INSERT INTO handle VALUES(1,'+353871234567'),(2,'+353879999999');INSERT INTO chat VALUES(1,'chat-jane'),(2,'chat-stranger');
  INSERT INTO chat_handle_join VALUES(1,1),(2,2);`);
 const now=Math.floor(Date.now()/1000);const add=d.prepare('INSERT INTO message(ROWID,guid,text,date,is_from_me,cache_has_attachments,handle_id) VALUES(?,?,?,?,0,0,?)');
 add.run(1,'old','Ten days ago',ns(now-10*86400),1);add.run(2,'jane','See you at four',ns(now-60),1);add.run(3,'stranger','Hello',ns(now-30),2);
 d.exec('INSERT INTO chat_message_join VALUES(1,1),(1,2),(2,3)');d.close();
 const rows=worker.readBatch(new DatabaseSync(chat,{readOnly:true}),0,now);
 assert.deepEqual(rows.map(r=>r.id),['jane','stranger']);assert.equal(rows[0].sent_at,now-60);assert.deepEqual(rows[0].participants,['+353871234567']);
 fs.writeFileSync(path.join(root,'hub-tap.json'),JSON.stringify({url:'https://hub.test',secret:'s'}));
 const posted=[];const http=async(url,o)=>{const body=JSON.parse(o.body);posted.push([url.split('/').pop(),body]);
  return{ok:true,json:async()=>url.endsWith('heartbeat')?{paused:false,self:[],identifiers:[{value:'+353871234567',space:'personal'}]}:{captured:true}};};
 const state=await worker.once({root,http,dbPath:chat});
 assert.equal(state.error,'');assert.equal(state.sent,1);assert.equal(state.skipped,1);assert.equal(state.cursor,3);
 const sent=posted.filter(p=>p[0]==='message');assert.equal(sent.length,1);assert.equal(sent[0][1].body,'See you at four');assert.equal(sent[0][1].sent_at,now-60);
 await assert.rejects(worker.once({root,http,dbPath:path.join(root,'missing.db')}),/not found/);
});
