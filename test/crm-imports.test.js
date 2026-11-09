'use strict';
const {test,beforeEach,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),os=require('os'),path=require('path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'crm-imports-'));process.env.CRM_DB_PATH=path.join(tmp,'crm.db');process.env.HUB_DB_PATH=path.join(tmp,'hub.db');process.env.HUB_DISABLE_JOBS='1';
const db=require('../lib/crm/db'),imports=require('../lib/crm/imports'),identity=require('../lib/crm/identity'),sources=require('../lib/crm/sources'),atoms=require('../lib/crm/atoms'),connections=require('../lib/crm/connections');
beforeEach(()=>{db._reset();fs.rmSync(process.env.CRM_DB_PATH,{force:true});});after(()=>{db._reset();fs.rmSync(tmp,{recursive:true,force:true});});
function person(name,email,space='work'){const p=identity.createPerson({space,name});identity.linkIdentifier(p.id,'email',email);return p;}
test('Contacts adds identifiers only through an exact match, holds collisions, and never treats an import as contact',()=>{
 const jane=person('Jane Whelan','jane@example.com');const other=person('Alec Smith','alec@example.com');
 const data={name:'Jane Whelan',emails:['jane@example.com'],phones:['+353871234567'],company:'Example',birthday:'1990-01-02'};
 assert.equal(imports.admit('contacts','people/one',data).status,'linked');
 assert.equal(identity.personForAddress('phone','+353871234567').id,jane.id);
 assert.equal(require('../lib/crm/views').lastContact(jane.id,'work'),null);
 assert.equal(require('../lib/crm/keepintouch').usualGap(jane.id,'work'),null);
 imports.admit('contacts','people/one',data);assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM sources').get().n,1);
 const conflict=imports.admit('contacts','people/two',{name:'Mixed up',emails:['jane@example.com','alec@example.com']});
 assert.equal(conflict.status,'conflict');assert.equal(identity.personForAddress('email','alec@example.com').id,other.id);
 const unknown=imports.admit('contacts','people/three',{name:'Jane Whelan',emails:['new@example.com']});assert.equal(unknown.status,'pending');
 imports.decide(unknown.id,{action:'add',space:'personal'});assert.equal(identity.personForAddress('email','new@example.com').space,'personal');
});
test('LinkedIn parses the real export columns after introductory rows and never guesses identity from names',()=>{
 person('Jane Whelan','jane@example.com');
 const csv='Notes:\nYour connections export\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nJane,Whelan,https://www.linkedin.com/in/jane,,"Example, Ltd",Director,01 Nov 2026\n';
 assert.equal(imports.linkedin(Buffer.from(csv)),1);const rows=imports.list();assert.equal(rows.length,1);assert.equal(rows[0].data.company,'Example, Ltd');
 assert.equal(rows[0].status,'pending');assert.equal(imports.linkedin(Buffer.from(csv)),1);assert.equal(imports.list().length,1);
 assert.throws(()=>imports.linkedin(Buffer.from('name,email\nJane,jane@example.com')),/Connections.csv/);
});
test('daily Contacts reads all pages and retains a readable failure',async()=>{
 let n=0;const api={people:{connections:{list:async()=>({data:++n===1?{connections:[{resourceName:'p1',names:[{displayName:'One'}],emailAddresses:[{value:'one@example.com'}]}],nextPageToken:'next'}:{connections:[{resourceName:'p2',names:[{displayName:'Two'}]}]}})}}};
 assert.equal((await imports.run({api})).count,2);assert.equal(n,2);
 await assert.rejects(imports.run({api:{people:{connections:{list:async()=>{throw new Error('Permission denied');}}}}}),/Permission/);
 assert.match(require('../lib/crm/runs').all().contacts_sync.last_error,/Permission/);
});
test('connections require a cited fact mentioning both people, and superseded facts remove them from view',()=>{
 const a=person('Jane Whelan','jane@example.com'),b=person('Alec Smith','alec@example.com');
 const text='Jane Whelan manages Alec Smith in the infrastructure team.';
 const s=sources.admitSource({space:'work',kind:'note',origin:'test',externalId:'one',text}).source;
 atoms.applyAtoms(s.id,[{statement:text,quote:text,people:[a.name,b.name],kind:'fact',confidence:'high'}]);
 let job={status:'pending'};const jobs={enqueue:()=>({jobId:'job'}),getJob:()=>job};const t=db.now()+10;
 assert.equal(connections.enqueueNext(jobs,t),true);const fact=db.crm().prepare('SELECT id FROM atoms').get().id;
 job={status:'completed',result:{output:JSON.stringify({connections:[{a:a.id,b:b.id,text:'Jane manages Alec.',facts:[fact]},{a:a.id,b:'wrong',text:'Invented',facts:[fact]}]})}};
 connections.collect(jobs,t);assert.equal(connections.forPerson(a).length,1);assert.equal(connections.forPerson(b)[0].other.id,a.id);
 db.crm().prepare("UPDATE atoms SET status='superseded' WHERE id=?").run(fact);assert.equal(connections.forPerson(a).length,0);
});
