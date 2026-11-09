#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),Database=require('better-sqlite3');
const {execFileSync}=require('child_process');const {normPhone,normEmail}=require('../lib/crm/text');
const APPLE=978307200;
function normal(v){return String(v).includes('@')?normEmail(v):normPhone(v);}
function readBatch(db,cursor=0,t=Math.floor(Date.now()/1000)){
 const rows=db.prepare(`SELECT m.ROWID row_id,m.guid id,m.text,m.attributedBody,m.date,m.is_from_me,m.cache_has_attachments,
 h.id sender,c.guid chat_id,c.ROWID chat_row FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID JOIN chat c ON c.ROWID=j.chat_id
 LEFT JOIN handle h ON h.ROWID=m.handle_id WHERE m.ROWID>? AND m.date>? AND m.is_system_message=0 AND m.associated_message_type=0
 ORDER BY m.ROWID LIMIT 200`).all(cursor,(t-7*86400-APPLE)*1e9);
 return rows.map(r=>({...r,participants:db.prepare('SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID=j.handle_id WHERE j.chat_id=?').all(r.chat_row).map(x=>x.id),sent_at:Math.floor(r.date/1e9)+APPLE}));
}
function privateValues(data){const result=new Set();const walk=v=>{if(typeof v==='string'||typeof v==='number'){result.add(normal(String(v)));}else if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')Object.values(v).forEach(walk);};walk(data.contacts||[]);return result;}
function eligible(row,heartbeat,privateSet){
 const participants=row.participants.map(normal).filter(v=>v&&!heartbeat.self.includes(v));
 if(!participants.length||participants.some(v=>privateSet.has(v))||privateSet.has(normal(row.sender||'')))return false;
 const known=participants.map(v=>heartbeat.identifiers.find(i=>i.value===v));return known.every(Boolean)&&new Set(known.map(i=>i.space)).size===1;
}
async function once({root=path.join(os.homedir(),'.hermes','hub-capture'),http=fetch,dbPath=path.join(os.homedir(),'Library','Messages','chat.db')}={}){
 const config=JSON.parse(fs.readFileSync(path.join(root,'hub-tap.json'),'utf8'));
 const post=async(route,body)=>{const r=await http(`${config.url.replace(/\/$/,'')}/api/crm/imessage/${route}`,{method:'POST',headers:{Authorization:`Bearer ${config.secret}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok)throw new Error(data.error||`Hub ${r.status}`);return data;};
 const stateFile=path.join(root,'imessage-state.json');let state={cursor:0,sent:0,skipped:0,error:''};try{state={...state,...JSON.parse(fs.readFileSync(stateFile,'utf8'))};}catch{}
 const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});let db;
 try{
  const heartbeat=await post('heartbeat',state);db=new Database(dbPath,{readonly:true,fileMustExist:true});
  const privateFile=path.join(root,'private-contacts.json');const privateSet=fs.existsSync(privateFile)?privateValues(JSON.parse(fs.readFileSync(privateFile,'utf8'))):new Set();
  if(heartbeat.paused){state.cursor=db.prepare('SELECT MAX(ROWID) n FROM message').get().n||state.cursor;state.error='';save();return state;}
  const rows=readBatch(db,state.cursor);const selected=rows.filter(r=>eligible(r,heartbeat,privateSet));
  const encoded=selected.filter(r=>!r.text&&r.attributedBody);
  let decoded=[];
  if(encoded.length){decoded=JSON.parse(execFileSync(path.join(__dirname,'..','.tools','imessage-text'),[],{input:JSON.stringify(encoded.map(r=>r.attributedBody.toString('base64'))),timeout:15000,maxBuffer:4*1024*1024}).toString());}
  const bodyById=new Map(encoded.map((r,i)=>[r.id,decoded[i]||'']));
  for(const r of rows){
   state.cursor=Math.max(state.cursor,r.row_id);save();
   if(!selected.includes(r)){state.skipped++;continue;}
   const body=r.text||bodyById.get(r.id)||'';
   await post('message',{id:r.id,chat_id:r.chat_id,participants:r.participants,sender:r.sender||'',from_me:!!r.is_from_me,sent_at:r.sent_at,body,
    reason:r.cache_has_attachments?'Attachment without readable text':'The Mac could not decode this message'});state.sent++;
  }
  state.error='';save();await post('heartbeat',state);return state;
 }catch(e){
  state.error=String(e.message).slice(0,300);
  // A paused or disconnected reader never replays a backlog after it reconnects.
  try{db ||= new Database(dbPath,{readonly:true,fileMustExist:true});state.cursor=db.prepare('SELECT MAX(ROWID) n FROM message').get().n||state.cursor;}catch{}
  save();await post('heartbeat',state).catch(()=>{});throw e;
 }finally{db?.close();}
}
if(require.main===module&&process.env.HUB_DISABLE_JOBS!=='1')once().then(s=>console.log(JSON.stringify({sent:s.sent,skipped:s.skipped,error:s.error}))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={readBatch,eligible,privateValues,once};
