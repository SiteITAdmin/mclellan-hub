'use strict';
const {crm,now}=require('./db');const {uuid}=require('../id');
function queue(chat,key,body,{questionId=null,t=now(),ttl=1800}={}){
 if(!chat?.is_self||chat.status!=='approved'||require('./whatsapp').isPaused())return false;
 return !!crm().prepare('INSERT OR IGNORE INTO whatsapp_outbox(id,chat_id,item_key,body,question_id,expires_at) VALUES(?,?,?,?,?,?)')
 .run(uuid(),chat.chat_id,key,String(body).slice(0,3500),questionId,t+ttl).changes;
}
function capture(chat,messages,source){
 if(!chat.is_self||source.is_history)return;
 let text=messages.map(m=>m.body).join('\n').trim();let space=chat.space;
 const taskPrefix=text.match(/^(?:(work|personal)\s+)?task:\s*/i);
 if(taskPrefix){
  if(taskPrefix[1])space=taskPrefix[1].toLowerCase();
  const body=text.slice(taskPrefix[0].length).trim();
  if(body){
   const [title,...rest]=body.split('\n');
   const t=require('./tasks').create(space,{title:title.trim().slice(0,1024),notes:rest.join('\n').trim()},'whatsapp');
   require('./calendar').replan();require('./calendar').soon();
   crm().prepare("UPDATE sources SET atomise_status='skipped',unreadable_reason='Added directly as a task' WHERE id=?").run(source.id);
   queue(chat,`task:${source.id}`,`Task added in ${space==='work'?'Work':'Personal'}: ${t.title}\nhttps://douglas.mclellan.scot/crm/${space}/tasks/${t.id}`);
   return;
  }
 }
 const prefix=text.match(/^(work|personal):\s*/i);if(prefix){space=prefix[1].toLowerCase();text=text.slice(prefix[0].length);}
 if(source.space!==space)throw new Error('Self-chat source must use the requested space');
 const ask=require('./ask');
 if(ask.looksLikeQuestion(text)){
  const q=ask.ask(space,text);queue(chat,`question:${source.id}`,'',{questionId:q.id,ttl:3600});
  crm().prepare("UPDATE sources SET atomise_status='skipped',unreadable_reason='Question answered through Search' WHERE id=?").run(source.id);
 }else queue(chat,`note:${source.id}`,`Saved in ${space==='work'?'Work':'Personal'}.\nhttps://douglas.mclellan.scot/crm/${space}/sources/${source.id}`);
}
function tick(t=now()){
 const whatsapp=require('./whatsapp');if(whatsapp.isPaused())return{paused:true};
 crm().prepare("UPDATE whatsapp_outbox SET status='expired' WHERE status='pending' AND expires_at<=?").run(t);
 for(const row of crm().prepare("SELECT * FROM whatsapp_outbox WHERE status='pending' AND question_id IS NOT NULL AND body='' AND expires_at>?").all(t)){
  const ask=require('./ask');const q=ask.shown(ask.collect(ask.get(row.question_id)));
  if(!q||q.status==='waiting')continue;
  const text=q.status==='failed'?'The Hub could not answer this yet.':q.lines.length?q.lines.map(l=>l.text).join('\n'):'Nothing captured answers that yet.';
  crm().prepare('UPDATE whatsapp_outbox SET body=? WHERE id=?').run(`${text}\nhttps://douglas.mclellan.scot/crm/${q.space}/search?ask=${q.id}`.slice(0,3500),row.id);
 }
 const chats=crm().prepare("SELECT * FROM whatsapp_chats WHERE is_self=1 AND status='approved' ORDER BY decided_at LIMIT 1").all();
 for(const chat of chats)for(const space of ['work','personal']){
  // Morning nudges (promises due today, people drifting) are in the one morning email now
  // (lib/crm/digest-narrative.js); only the time-critical meeting reminder still comes here.
  for(const item of require('./notifications').candidates(space,t))if(item.key.startsWith('meeting:'))queue(chat,`reminder:${space}:${item.key}`,`${item.title}: ${item.body}\nhttps://douglas.mclellan.scot${item.url}`,{t,ttl:item.ttl});
 }
 return{waiting:crm().prepare("SELECT COUNT(*) n FROM whatsapp_outbox WHERE status='pending'").get().n};
}
function claim(selfChatIds,t=now()){
 if(require('./whatsapp').isPaused()||!Array.isArray(selfChatIds)||selfChatIds.length>2)return[];
 const rows=crm().prepare(`SELECT o.* FROM whatsapp_outbox o JOIN whatsapp_chats c ON c.chat_id=o.chat_id
 WHERE o.status='pending' AND o.body!='' AND o.expires_at>? AND c.is_self=1 AND c.status='approved' ORDER BY o.created_at LIMIT 10`).all(t).filter(r=>selfChatIds.includes(r.chat_id));
 return crm().transaction(()=>rows.map(row=>{
  const effect=uuid();const changed=crm().prepare("UPDATE whatsapp_outbox SET status='claimed',effect_id=? WHERE id=? AND status='pending'").run(effect,row.id).changes;
  if(!changed)return null;
  crm().prepare("INSERT INTO effects(id,module,entity_id,operation,request,status) VALUES(?,'crm_whatsapp_self',?,'message.send',?,'started')").run(effect,row.id,JSON.stringify({chat:row.chat_id,key:row.item_key}));
  return{id:row.id,chat_id:row.chat_id,body:`[Hub] ${row.body}`};
 }).filter(Boolean))();
}
function complete(id,{ok,error='',messageId=''}){
 const row=crm().prepare("SELECT * FROM whatsapp_outbox WHERE id=? AND status='claimed'").get(id);if(!row)return;
 crm().transaction(()=>{
  crm().prepare('UPDATE whatsapp_outbox SET status=?,error=? WHERE id=?').run(ok?'sent':'failed',String(error).slice(0,300),id);
  crm().prepare('UPDATE effects SET status=?,result=?,finished_at=? WHERE id=?').run(ok?'done':'uncertain',JSON.stringify({messageId,error:String(error).slice(0,300)}),now(),row.effect_id);
 })();
}
function health(){const n=crm().prepare("SELECT COUNT(*) n FROM whatsapp_outbox WHERE status='failed' OR (status='claimed' AND created_at<?)").get(now()-600).n;return n?[{level:'bad',text:`${n} WhatsApp self-chat deliveries failed or have an unknown outcome`,href:'/crm/whatsapp'}]:[];}
module.exports={queue,capture,tick,claim,complete,health};
