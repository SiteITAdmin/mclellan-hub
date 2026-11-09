'use strict';
const {crm,now,setting,setSetting}=require('./db');const identity=require('./identity');const {normEmail,normPhone}=require('./text');
function address(v){return String(v||'').includes('@')?{kind:'email',value:normEmail(v)}:{kind:'phone',value:normPhone(v)};}
function resolve(values){
 const all=[...new Set(values.map(String))].filter(v=>!identity.isSelf(v));
 if(!all.length)return null;
 const people=all.map(v=>{const a=address(v);return identity.personForAddress(a.kind,a.value);});
 if(people.some(p=>!p)||new Set(people.map(p=>p.space)).size!==1)return null;
 return {space:people[0].space,people,addresses:all};
}
function heartbeat(body={}){
 setSetting('imessage_heartbeat',JSON.stringify({at:now(),sent:Number(body.sent)||0,skipped:Number(body.skipped)||0,error:String(body.error||'').slice(0,300)}));
 const paused=setting('imessage_paused')==='1';
 const identifiers=paused?[]:crm().prepare("SELECT i.kind,i.value,p.space FROM identifiers i JOIN people p ON p.id=i.person_id WHERE i.status='linked'").all();
 return {paused,identifiers,self:require('./config').personalAddresses().concat(require('./config').workAddresses())};
}
function receive(m,t=now()){
 if(setting('imessage_paused')==='1')throw Object.assign(new Error('iMessage capture is paused'),{status:409});
 if(!m.id||!m.chat_id||!Array.isArray(m.participants)||m.participants.length>50)throw Object.assign(new Error('Invalid message'),{status:400});
 const people=resolve(m.participants);if(!people)return{skipped:'unknown or mixed-space participants'};
 const sent=Math.floor(Number(m.sent_at));if(!Number.isFinite(sent)||sent>t+300||sent<t-7*86400)return{skipped:'outside capture window'};
 if(!m.from_me&&!people.addresses.some(v=>{const a=address(v),b=address(m.sender);return a.kind===b.kind&&a.value===b.value;}))return{skipped:'unknown sender'};
 const ids=people.addresses.map((v,i)=>({...address(v),name:people.people[i].name}));
 const body=String(m.body||'').trim().slice(0,20000);
 const added=crm().prepare(`INSERT OR IGNORE INTO imessage_messages(id,chat_id,space,participants,sender,from_me,body,sent_at,received_at) VALUES(?,?,?,?,?,?,?,?,?)`)
 .run(String(m.id).slice(0,200),String(m.chat_id).slice(0,200),people.space,JSON.stringify(ids),String(m.sender||'').slice(0,200),m.from_me?1:0,body,sent,t).changes;
 if(added&&!body){const s=require('./sources').admitSource({space:people.space,kind:'imessage',origin:'imessage',externalId:m.id,title:'iMessage without readable text',occurredAt:sent,text:'',readable:false,unreadableReason:String(m.reason||'No text; attachment or unsupported message').slice(0,300),isHistory:true}).source;
 crm().prepare('UPDATE imessage_messages SET source_id=? WHERE id=?').run(s.id,m.id);}
 return{captured:!!added};
}
function settle(t=now()){
 if(setting('imessage_paused')==='1')return{paused:true};
 const chats=crm().prepare('SELECT chat_id,space,MAX(received_at) latest FROM imessage_messages WHERE source_id IS NULL GROUP BY chat_id,space HAVING MAX(received_at)<=?').all(t-300);let count=0;
 for(const c of chats){
  const messages=crm().prepare('SELECT * FROM imessage_messages WHERE chat_id=? AND space=? AND source_id IS NULL ORDER BY sent_at,id LIMIT 50').all(c.chat_id,c.space);
  const previous=crm().prepare('SELECT * FROM imessage_messages WHERE chat_id=? AND space=? AND source_id IS NOT NULL AND sent_at<=? ORDER BY sent_at DESC LIMIT 15').all(c.chat_id,c.space,messages[0].sent_at).reverse();
  const line=m=>{const who=m.from_me?'Douglas':JSON.parse(m.participants).find(x=>x.value===address(m.sender).value)?.name||m.sender;return`[${new Date(m.sent_at*1000).toISOString()}] ${who}: ${m.body}`;};
  const fresh=messages.map(line).join('\n');const text=fresh+(previous.length?'\n\nEarlier in this chat (context only):\n'+previous.map(line).join('\n'):'');
  const participants=[...new Map(messages.flatMap(m=>JSON.parse(m.participants)).map(a=>[a.kind+':'+a.value,a])).values()].map(a=>({role:'from',name:a.name,...(a.kind==='email'?{email:a.value}:{phone:a.value})}));
  crm().transaction(()=>{
   const s=require('./sources').admitSource({space:c.space,kind:'imessage',origin:'imessage',externalId:`burst:${messages[0].id}`,title:`iMessage · ${participants.map(p=>p.name).join(', ')}`,occurredAt:messages[0].sent_at,text,fresh,participants,direction:messages.every(m=>m.from_me)?'out':null}).source;
   for(const m of messages)crm().prepare('UPDATE imessage_messages SET source_id=? WHERE id=?').run(s.id,m.id);
  })();count++;
 }
 return{sources:count};
}
function status(){let heartbeat=null;try{heartbeat=JSON.parse(setting('imessage_heartbeat')||'null');}catch{}return{paused:setting('imessage_paused')==='1',heartbeat};}
function health(){const s=status();return s.paused?[{level:'warn',text:'iMessage capture is paused',href:'/crm/messages'}]:!s.heartbeat||s.heartbeat.at<now()-1800?[{level:'bad',text:'The iMessage reader has not checked in for 30 minutes',href:'/crm/messages'}]:s.heartbeat.error?[{level:'bad',text:`iMessage: ${s.heartbeat.error}`,href:'/crm/messages'}]:[];}
module.exports={address,resolve,heartbeat,receive,settle,status,health};
