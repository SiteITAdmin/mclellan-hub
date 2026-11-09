'use strict';
const {google}=require('googleapis');const {oauthClient}=require('../google-auth');const {setting,setSetting}=require('./db');
const PURPOSE='crm-contacts';const CALLBACK='/admin/auth/google/callback';const SCOPE='https://www.googleapis.com/auth/contacts.readonly';
function isMine(req){return req.session?.googleOAuth?.purpose===PURPOSE;}
function start(req,res){
  const state=require('crypto').randomBytes(24).toString('hex');
  req.session.googleOAuth={purpose:PURPOSE,state,user:'douglas'};
  const url=oauthClient(req,CALLBACK).generateAuthUrl({access_type:'offline',prompt:'consent',scope:['openid','email',SCOPE],login_hint:require('./config').personalAddresses()[0],state,include_granted_scopes:false});
  req.session.save(()=>res.redirect(url));
}
async function finish(req,res){
  const saved=req.session.googleOAuth;req.session.googleOAuth=null;
  if(req.session?.adminUser!=='douglas')return res.status(403).send('Sign in to the CRM first');
  if(!saved||saved.state!==req.query.state)return res.status(400).send('Invalid sign-in state');
  try{
    if(req.query.error)throw new Error(`Google said: ${req.query.error}`);
    const client=oauthClient(req,CALLBACK);const {tokens}=await client.getToken(req.query.code);client.setCredentials(tokens);
    if(!String(tokens.scope||'').split(' ').includes(SCOPE))throw new Error('Google Contacts permission was not granted');
    const {data:profile}=await google.oauth2({version:'v2',auth:client}).userinfo.get();
    if(!profile.verified_email||profile.email?.toLowerCase()!==require('./config').personalAddresses()[0])throw new Error('Connect the main Douglas Google account');
    const old=JSON.parse(setting('contacts_auth')||'{}');if(!tokens.refresh_token&&!old.refresh_token)throw new Error('Google did not provide background access; reconnect Contacts');
    setSetting('contacts_auth',JSON.stringify({...old,...tokens}));
    const {scheduleJob,hasPending}=require('../jobs');if(!hasPending('crm_contacts_sync'))scheduleJob('crm_contacts_sync',{},Math.floor(Date.now()/1000),'connect');
    // Bring a previously scheduled daily run forward after the first connection.
    require('../db').hub().prepare("UPDATE system_jobs SET run_at=unixepoch() WHERE type='crm_contacts_sync' AND status='pending'").run();
    req.session.crmFlash={text:'Contacts connected. New people will wait here for review.',level:'ok'};
  }catch(e){req.session.crmFlash={text:e.message,level:'bad'};}
  req.session.save(()=>res.redirect('/crm/imports'));
}
module.exports={isMine,start,finish};
