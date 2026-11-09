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
