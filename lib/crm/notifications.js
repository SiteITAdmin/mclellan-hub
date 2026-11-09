'use strict';
const {crm,now,setting,setSetting}=require('./db');const {uuid}=require('../id');const planner=require('./planner');
function keys(){let stored=setting('push_vapid');if(!stored){stored=JSON.stringify(require('web-push').generateVAPIDKeys());setSetting('push_vapid',stored);}return JSON.parse(stored);}
function subscribe(subscription,spaces){
 const url=new URL(subscription?.endpoint);
 const allowed=url.hostname==='fcm.googleapis.com'||url.hostname.endsWith('.push.services.mozilla.com')||url.hostname==='updates.push.services.mozilla.com'||url.hostname==='web.push.apple.com'||url.hostname.endsWith('.notify.windows.com');
 if(url.protocol!=='https:'||url.port||url.username||url.password||!allowed)throw new Error('Unsupported browser push service');
 if(!subscription.keys||!/^[-_A-Za-z0-9]{80,100}$/.test(subscription.keys.p256dh)||!/^[-_A-Za-z0-9]{20,30}$/.test(subscription.keys.auth))throw new Error('Invalid browser subscription');
 const selected=[...new Set(Array.isArray(spaces)?spaces:[])].filter(s=>['work','personal'].includes(s));if(!selected.length)throw new Error('Choose at least one space');
 const id=uuid();crm().prepare(`INSERT INTO push_subscriptions(id,endpoint,subscription,spaces,created_at) VALUES(?,?,?,?,?)
 ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription,spaces=excluded.spaces,error=''`).run(id,url.href,JSON.stringify(subscription),JSON.stringify(selected),now());
 return crm().prepare('SELECT id FROM push_subscriptions WHERE endpoint=?').get(url.href).id;
}
function remove(endpoint){crm().prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(String(endpoint||''));}
function candidates(space,t=now()){
 const date=planner.local(t).date;const out=[];
 for(const e of require('./meetings').today(space,t))if(e.start_at>t&&e.start_at<=t+1800&&e.lines.length)out.push({key:`meeting:${e.id}:${e.start_at}`,title:'Meeting in 30 minutes',body:e.title,url:`/crm/${space}/meetings`,ttl:e.start_at-t});
 if(planner.local(t).minutes>=7*60&&planner.local(t).minutes<22*60){
  for(const p of require('./promises').ledger(space).mine)if(p.due===date)out.push({key:`promise:${p.atom_id}:${date}`,title:`${space==='work'?'Work':'Personal'} promise due today`,body:p.action,url:`/crm/${space}/promises`,ttl:3600});
 }
 return out;
}
async function deliver(sub,item,send,t){
 const key=`${sub.id}:${item.key}`;if(crm().prepare("SELECT 1 FROM effects WHERE module='crm_push' AND entity_id=?").get(key))return false;
 const receipt=uuid();crm().prepare("INSERT INTO effects(id,module,entity_id,operation,request,status) VALUES(?,'crm_push',?,'push.send',?,'started')").run(receipt,key,JSON.stringify({url:item.url,title:item.title}));
 try{await send(JSON.parse(sub.subscription),JSON.stringify({title:item.title,body:item.body,url:item.url,tag:item.key}),{TTL:Math.max(1,Math.min(3600,item.ttl)),urgency:'normal',timeout:15000});
  crm().prepare("UPDATE effects SET status='done',finished_at=? WHERE id=?").run(t,receipt);crm().prepare("UPDATE push_subscriptions SET last_sent=?,error='' WHERE id=?").run(t,sub.id);return true;
 }catch(e){const error=String(e.message).slice(0,300);crm().prepare("UPDATE effects SET status='uncertain',result=?,finished_at=? WHERE id=?").run(error,t,receipt);
  if([404,410].includes(e.statusCode))remove(sub.endpoint);else crm().prepare('UPDATE push_subscriptions SET error=? WHERE id=?').run(error,sub.id);return false;}
}
async function run({send,t=now()}={}){
 return require('./runs').track('push_notifications',async()=>{
  const subs=crm().prepare('SELECT * FROM push_subscriptions').all();if(!subs.length)return{devices:0,sent:0};
  if(!send){const webpush=require('web-push'),k=keys();webpush.setVapidDetails('mailto:douglas@mclellan.scot',k.publicKey,k.privateKey);send=webpush.sendNotification.bind(webpush);}
  let sent=0;for(const sub of subs)for(const space of JSON.parse(sub.spaces))for(const item of candidates(space,t))if(await deliver(sub,item,send,t))sent++;
  return{devices:subs.length,sent};
 });
}
function list(){return crm().prepare('SELECT id,spaces,created_at,last_sent,error FROM push_subscriptions ORDER BY created_at DESC').all();}
module.exports={keys,subscribe,remove,candidates,deliver,run,list};
