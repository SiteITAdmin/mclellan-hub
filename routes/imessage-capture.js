'use strict';
const router=require('express').Router();const capture=require('../lib/crm/imessage');const {createRateLimiter}=require('../lib/security');
router.use('/api/crm/imessage',createRateLimiter({windowMs:15*60000,max:3000,keyPrefix:'imessage-reader'}),(req,res,next)=>{
 if(!require('../lib/crm/whatsapp').secretOk(req.headers.authorization))return res.status(401).json({error:'Unauthorized'});next();
});
router.post('/api/crm/imessage/heartbeat',(req,res)=>res.json(capture.heartbeat(req.body)));
router.post('/api/crm/imessage/message',(req,res)=>{try{res.json(capture.receive(req.body));}catch(e){res.status(e.status||500).json({error:e.message});}});
module.exports=router;
