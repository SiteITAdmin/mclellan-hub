'use strict';
const { crm, now, setting, setSetting } = require('./db');
const { uuid } = require('../id');
const { createHash } = require('crypto');
const identity = require('./identity');
const { normEmail, normPhone } = require('./text');
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function identifiers(data) {
  return [...(data.emails || []).map(value=>({kind:'email',value:normEmail(value)})), ...(data.phones || []).map(value=>({kind:'phone',value:normPhone(value)}))].filter(x=>x.value);
}
function matched(data) {
  return [...new Map(identifiers(data).map(x=>identity.personForAddress(x.kind,x.value)).filter(Boolean).map(p=>[p.id,p])).values()];
}
function evidence(row, person) {
  const d=JSON.parse(row.data), ids=identifiers(d);
  const text=[`Contact: ${d.name}`,d.company&&`Organisation: ${d.company}`,d.position&&`Role: ${d.position}`,d.birthday&&`Birthday (yearly): ${d.birthday}`,
    d.connected&&`LinkedIn connection since: ${d.connected}`,...ids.map(x=>`${x.kind}: ${x.value}`),d.url&&`Profile: ${d.url}`].filter(Boolean).join('\n');
  require('./sources').admitSource({space:person.space,kind:'contact',origin:row.provider,externalId:`${row.external_id}:${row.fingerprint}:${person.id}`,
    title:`${d.name} · ${row.provider}`,text,fresh:text,occurredAt:row.seen_at,isHistory:true,rawRef:d.url||'',
    participants:ids.map(x=>({role:'from',...(x.kind==='email'?{email:x.value}:{phone:x.value}),name:person.name}))});
}
function link(row, person) {
  const data=JSON.parse(row.data), ids=identifiers(data);
  const owners=matched(data);
  if(owners.some(p=>p.id!==person.id)) throw new Error('These identifiers belong to different people; resolve the identity conflict first');
  if(ids.some(x=>identity.isIgnored(x.kind,x.value))) throw new Error('An identifier was marked not a person; review it before importing');
  crm().transaction(()=>{
    for(const x of ids) if(!identity.personForAddress(x.kind,x.value)) identity.linkIdentifier(person.id,x.kind,x.value,row.provider);
    crm().prepare("UPDATE identity_imports SET status='linked',person_id=?,error='' WHERE id=?").run(person.id,row.id);
    evidence(row,person);
  })();
}
function admit(provider, externalId, data, t=now()) {
  const fp=hash(data); const old=crm().prepare('SELECT * FROM identity_imports WHERE provider=? AND external_id=?').get(provider,externalId);
  crm().prepare(`INSERT INTO identity_imports(id,provider,external_id,data,seen_at,fingerprint) VALUES(?,?,?,?,?,?)
    ON CONFLICT(provider,external_id) DO UPDATE SET data=excluded.data,seen_at=excluded.seen_at,fingerprint=excluded.fingerprint`)
    .run(uuid(),provider,externalId,JSON.stringify(data),t,fp);
  const row=crm().prepare('SELECT * FROM identity_imports WHERE provider=? AND external_id=?').get(provider,externalId);
  if(row.status==='ignored')return row;
  try {
    const matches=matched(data);
    const bound=row.person_id && crm().prepare('SELECT * FROM people WHERE id=?').get(row.person_id);
    if(matches.length>1 || (bound && matches.some(p=>p.id!==bound.id)))throw new Error('This contact has identifiers for more than one person');
    const person=bound||matches[0];
    if(person && (!old || old.fingerprint!==fp || row.status!=='linked'))link(row,person);
    else if(!person)crm().prepare("UPDATE identity_imports SET status='pending',person_id=NULL,error='' WHERE id=?").run(row.id);
  }catch(e){crm().prepare("UPDATE identity_imports SET status='conflict',error=? WHERE id=?").run(String(e.message).slice(0,300),row.id);}
  return crm().prepare('SELECT * FROM identity_imports WHERE id=?').get(row.id);
}
function decide(id,{action,personId,space,name}) {
  const row=crm().prepare('SELECT * FROM identity_imports WHERE id=?').get(id);if(!row)throw new Error('Import not found');
  if(action==='ignore'){crm().prepare("UPDATE identity_imports SET status='ignored' WHERE id=?").run(id);return;}
  if(!['add','link'].includes(action))throw new Error('Choose an import action');
  const d=JSON.parse(row.data);
  crm().transaction(()=>{
    const person=action==='add'?identity.createPerson({space,name:name||d.name}):crm().prepare('SELECT * FROM people WHERE id=?').get(personId);
    if(!person)throw new Error('Choose a person');link(row,person);
  })();
}
function linkedin(buffer) {
  const XLSX=require('xlsx');const book=XLSX.read(buffer,{type:'buffer',raw:true});
  const rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:'',raw:false});
  const at=rows.findIndex(r=>r.includes('First Name')&&r.includes('Last Name')&&r.includes('Company'));
  if(at<0)throw new Error('Choose the LinkedIn Connections.csv export');
  const headers=rows[at];let count=0;
  for(const r of rows.slice(at+1)) {
    const v=Object.fromEntries(headers.map((h,i)=>[h,String(r[i]||'').trim()]));
    const name=[v['First Name'],v['Last Name']].filter(Boolean).join(' ');if(!name)continue;
    const email=normEmail(v['Email Address']), url=v.URL||'';
    const data={name,emails:email?[email]:[],phones:[],company:v.Company,position:v.Position,connected:v['Connected On'],url};
    admit('linkedin',url||email||hash(data),data);if(++count>10000)throw new Error('Import is larger than 10,000 connections');
  }
  return count;
}
function contactData(c) {
  const b=(c.birthdays||[]).find(x=>x.date?.month&&x.date?.day)?.date;
  const o=(c.organizations||[]).find(x=>x.metadata?.primary)||(c.organizations||[])[0];
  return {name:(c.names||[]).find(x=>x.metadata?.primary)?.displayName||c.names?.[0]?.displayName||'',
    emails:(c.emailAddresses||[]).map(x=>x.value),phones:(c.phoneNumbers||[]).map(x=>x.canonicalForm||x.value),company:o?.name||'',position:o?.title||'',
    birthday:b?`${b.year||new Date().getFullYear()}-${String(b.month).padStart(2,'0')}-${String(b.day).padStart(2,'0')}`:'',url:''};
}
function connected(){return !!setting('contacts_auth');}
async function run({api,t=now()}={}){
  return require('./runs').track('contacts_sync',async()=>{
    if(!api&&!connected())return{needsConnection:true};
    if(!api){const {google}=require('googleapis');const auth=new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID,process.env.GOOGLE_OAUTH_CLIENT_SECRET);auth.setCredentials(JSON.parse(setting('contacts_auth')));auth.on('tokens',tokens=>setSetting('contacts_auth',JSON.stringify({...JSON.parse(setting('contacts_auth')), ...tokens})));api=google.people({version:'v1',auth});}
    let pageToken,count=0;
    do{const {data}=await api.people.connections.list({resourceName:'people/me',personFields:'names,emailAddresses,phoneNumbers,organizations,birthdays',pageSize:100,pageToken},{timeout:30000});
      for(const c of data.connections||[]){if(c.metadata?.deleted)continue;admit('contacts',c.resourceName,contactData(c),t);count++;}pageToken=data.nextPageToken;
    }while(pageToken);
    return{count};
  });
}
function list(){return crm().prepare("SELECT * FROM identity_imports WHERE status IN ('pending','conflict') ORDER BY seen_at DESC LIMIT 100").all().map(r=>({...r,data:JSON.parse(r.data),matches:matched(JSON.parse(r.data))}));}
module.exports={admit,decide,linkedin,contactData,run,list,connected,matched};
