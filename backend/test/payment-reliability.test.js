'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
Object.assign(process.env,{NODE_ENV:'test',ADMIN_PASSWORD:'test-admin-password',DATABASE_URL:'postgres://test:test@127.0.0.1/test',JWT_SECRET:'test-only-jwt-secret-that-is-longer-than-forty-eight-characters',RAZORPAY_KEY_ID:'rzp_test_dummy',RAZORPAY_KEY_SECRET:'test-secret'});
let payment,providerSubscription;
const provider={payments:{fetch:async()=>payment},subscriptions:{fetch:async()=>providerSubscription}};
const rp=require.resolve('razorpay');require.cache[rp]={id:rp,filename:rp,loaded:true,exports:class{constructor(){return provider}}};
const express=require('express'),db=require('../src/db'),{signToken}=require('../src/auth');
const user={id:'customer-1',role:'customer',name:'Customer',status:'active',auth_version:0};
let balance=600,credits=0,listenerCredits=0;
let order={id:'local-order',razorpay_order_id:'order_test123',customer_id:user.id,amount_paise:50000,currency:'INR',status:'created',seconds:3600,plan_name:'60 minutes'};
let membership={id:'local-sub',customer_id:user.id,employee_id:'listener-1',razorpay_subscription_id:'sub_test123',razorpay_plan_id:'plan_test123',access_source:'razorpay',status:'created',paid_count:0};
const receipts=new Map(),compact=s=>String(s).replace(/\s+/g,' ').trim(),rows=(...items)=>({rows:items});
db.query=async(sql,args=[])=>{const s=compact(sql);if(s.includes('FROM users WHERE id=$1'))return rows(user);if(s.includes('FROM razorpay_orders'))return args[1]===user.id?rows({...order}):rows();if(s.includes('FROM listener_subscriptions s'))return rows({...membership,name:'Listener'});throw Error('Unexpected query '+s)};
db.transaction=async cb=>cb({query:async(sql,a=[])=>{
 const s=compact(sql);
 if(s.includes('pg_advisory_xact_lock'))return rows();
 if(s.includes('SELECT * FROM razorpay_orders'))return rows({...order});
 if(s.includes('SELECT balance_seconds'))return rows({balance_seconds:balance});
 if(s.includes('SELECT id,customer_id FROM razorpay_orders'))return rows();
 if(s.startsWith('UPDATE razorpay_orders')){order.status='paid';order.razorpay_payment_id=a[1];return rows({...order});}
 if(s.startsWith('UPDATE users')){balance+=a[1];credits++;return rows({balance_seconds:balance});}
 if(s.startsWith('SELECT * FROM listener_subscriptions'))return rows({...membership});
 if(s.startsWith('UPDATE listener_subscriptions SET status=$2,current_period_start')){Object.assign(membership,{status:a[1],current_period_start:a[2],current_period_end:a[3],paid_count:a[5]});return rows({...membership});}
 if(s.startsWith('UPDATE listener_subscriptions SET status=$2,')){Object.assign(membership,{status:a[1],current_period_end:a[3],paid_count:1});return rows({...membership});}
 if(s.startsWith('UPDATE listener_subscriptions SET last_payment_id')){membership.last_payment_id=a[1];return rows();}
 if(s.startsWith('INSERT INTO listener_subscription_payments')){const r=receipts.get(a[3])||{id:'receipt-1',listener_credited_at:null};r.status=a[6];receipts.set(a[3],r);return rows({...r});}
 if(s.startsWith('UPDATE listener_subscription_payments')){for(const r of receipts.values())r.listener_credited_at=new Date();return rows();}
 if(s.startsWith('INSERT INTO listener_wallet_transactions')){listenerCredits++;return rows();}
 if(s.startsWith('INSERT INTO wallet_transactions')||s.startsWith('INSERT INTO notifications'))return rows();
 throw Error('Unexpected transaction '+s);
}});
const app=express();app.use(express.json());app.locals.notifyUser=async()=>{throw Error('Simulated push outage')};app.use('/api',require('../src/routes/razorpay'));app.use('/api/subscriptions',require('../src/routes/subscriptions').router);app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
const sig=s=>crypto.createHmac('sha256','test-secret').update(s).digest('hex');
test('wallet and Exclusive verify capture, reject tampering, and credit once despite notification failures',async t=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const token=signToken(user),post=async(endpoint,body)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,data:await res.json()}};
 const wallet={razorpay_order_id:'order_test123',razorpay_payment_id:'pay_test123',razorpay_signature:sig('order_test123|pay_test123')};
 payment={id:'pay_test123',order_id:'order_test123',amount:50000,currency:'INR',status:'authorized'};
 assert.equal((await post('/api/verify-payment',wallet)).status,425);assert.equal(credits,0);
 payment.status='captured';payment.amount=100;assert.equal((await post('/api/verify-payment',wallet)).status,400);assert.equal(credits,0);
 payment.amount=50000;assert.equal((await post('/api/verify-payment',{...wallet,razorpay_signature:'0'.repeat(64)})).status,400);
 let res=await post('/api/verify-payment',wallet);assert.equal(res.status,200,JSON.stringify(res));assert.equal(res.data.balance_seconds,4200);
 res=await post('/api/verify-payment',wallet);assert.equal(res.status,200);assert.equal(res.data.already_processed,true);assert.equal(credits,1);
 const exclusive={razorpay_payment_id:'pay_sub123',razorpay_subscription_id:'sub_test123',razorpay_signature:sig('pay_sub123|sub_test123')};
 payment={id:'pay_sub123',subscription_id:'sub_test123',amount:39900,currency:'INR',status:'captured',created_at:Math.floor(Date.now()/1000)};providerSubscription={id:'sub_test123',plan_id:'plan_test123',status:'authenticated',paid_count:0};
 assert.equal((await post('/api/subscriptions/verify',{...exclusive,razorpay_signature:'0'.repeat(64)})).status,400);assert.equal(listenerCredits,0);
 res=await post('/api/subscriptions/verify',exclusive);assert.equal(res.status,200,JSON.stringify(res));assert.equal(res.data.success,true);assert.equal(membership.status,'active');assert.ok(new Date(membership.current_period_end)>new Date());
 res=await post('/api/subscriptions/verify',exclusive);assert.equal(res.status,200);assert.equal(listenerCredits,1);
 payment.subscription_id='sub_wrong123';assert.equal((await post('/api/subscriptions/verify',exclusive)).status,400);assert.equal(listenerCredits,1);
});
