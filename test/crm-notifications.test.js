'use strict';
const {test,beforeEach,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),os=require('os'),path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'crm-push-'));process.env.CRM_DB_PATH=path.join(tmp,'crm.db');process.env.HUB_DB_PATH=path.join(tmp,'hub.db');process.env.HUB_DISABLE_JOBS='1';
const db=require('../lib/crm/db'),push=require('../lib/crm/notifications');
beforeEach(()=>{db._reset();fs.rmSync(process.env.CRM_DB_PATH,{force:true});});after(()=>{db._reset();fs.rmSync(tmp,{recursive:true,force:true});});
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}};
test('subscriptions validate browser services and spaces; notification receipts prevent duplicates even after a lost reply',async()=>{
 assert.throws(()=>push.subscribe({...subscription,endpoint:'http://127.0.0.1/private'},['work']),/Unsupported/);
 assert.throws(()=>push.subscribe(subscription,[]),/Choose/);
 push.subscribe(subscription,['work']);push.subscribe(subscription,['personal','work']);assert.equal(push.list().length,1);
 const sub=db.crm().prepare('SELECT * FROM push_subscriptions').get();const item={key:'meeting:e:1',title:'Meeting prep',body:'Test',url:'/crm/work/meetings',ttl:60};let sent=0;
 assert.equal(await push.deliver(sub,item,async()=>{sent++;},100),true);
 assert.equal(await push.deliver(sub,item,async()=>{sent++;},110),false);assert.equal(sent,1);
 await push.deliver(sub,{...item,key:'another'},async()=>{throw new Error('Lost response');},120);
 assert.equal(await push.deliver(sub,{...item,key:'another'},async()=>{sent++;},130),false);
 assert.match(push.list()[0].error,/Lost response/);
 assert.equal(db.crm().prepare("SELECT COUNT(*) n FROM effects WHERE module='crm_push'").get().n,2);
});
test('expired subscriptions are retired and unsubscribed devices receive nothing',async()=>{
 push.subscribe(subscription,['work']);const sub=db.crm().prepare('SELECT * FROM push_subscriptions').get();
 await push.deliver(sub,{key:'gone',title:'Test',url:'/crm/work',ttl:60},async()=>{throw Object.assign(new Error('Gone'),{statusCode:410});},100);
 assert.equal(push.list().length,0);assert.deepEqual(await push.run(),{devices:0,sent:0});
});
