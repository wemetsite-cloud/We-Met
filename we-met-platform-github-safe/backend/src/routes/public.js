const express = require('express');
const db = require('../db');
const config = require('../config');
const { asyncHandler } = require('../middleware');

const router = express.Router();

router.get('/plans', asyncHandler(async (_req, res) => {
  const result = await db.query(
    `SELECT id,name,price_paise,seconds,popular
     FROM plans WHERE active=true ORDER BY sort_order,price_paise`,
  );
  res.json({ plans: result.rows });
}));

router.get('/config', (_req, res) => res.json({
  appName: config.appName,
  supportEmail: config.supportEmail,
  paymentGatewayMode: config.paymentGatewayMode,
  razorpayEnabled: config.paymentGatewayMode === 'razorpay',
  directUpiEnabled: config.paymentGatewayMode === 'upi_direct',
  pushEnabled: config.webPush.enabled,
  vapidPublicKey: config.webPush.enabled ? config.webPush.publicKey : '',
  paymentPayeeName: config.paymentPayeeName,
  iceServers: config.iceServers,
  minimumStartSeconds: config.minimumStartSeconds,
  ringSeconds: config.ringSeconds,
  callingLanguage: 'Malayalam',
}));

router.get('/legal/:type', (req, res) => {
  const documents = {
    terms: `Last updated: 8 August 2026\n\nWe Met is an online conversation service for adults aged 18 or above. Customers purchase prepaid talk-time and may use it for one-to-one browser audio calls and in-session text chat with available Malayalam listeners. We Met does not arrange offline meetings and does not provide escort, sexual, medical, counselling or emergency services.\n\nBy creating an account, you confirm that you are at least 18 and agree to use the service lawfully and respectfully. Sexual requests, harassment, threats, fraud, impersonation, attempts to exchange private contact details, requests for passwords, OTPs or banking credentials, and illegal activity are prohibited.\n\nTalk-time is billed only while a live audio connection is active. Pack prices and included minutes are shown before checkout. The administrator may restrict, suspend or close accounts for safety, fraud prevention, policy violations or legal requirements.`,
    privacy: `Last updated: 8 August 2026\n\nWe Met processes the information required to operate the service, including account details, contact information, wallet balance, call status and duration, in-session text messages, payment references and status, direct-UPI payment evidence when that method is enabled, reports, notifications and support messages.\n\nCustomer phone numbers and email addresses are not displayed to listeners. Voice audio is not recorded by this version of We Met. We Met does not store UPI PINs, card numbers or payment OTPs. Payment providers process payment credentials under their own privacy and security terms.\n\nInformation may be processed by infrastructure, database and payment service providers only as required to deliver, secure and support the service. Customers may contact support to request account assistance or deletion, subject to records that must be retained for legal, fraud-prevention, payment or dispute purposes.`,
    refund: `Last updated: 8 August 2026\n\nCustomers should verify the pack, minutes and amount before payment. Failed, cancelled, incomplete, declined or duplicate payment attempts do not receive talk-time. For direct UPI, talk-time is credited only after the submitted UTR and payment proof are verified. For a payment gateway, talk-time is credited after the gateway confirms successful capture.\n\nIf a successful payment is not credited, is duplicated, or a verified technical error prevents delivery of the purchased talk-time, contact wemetsite@gmail.com with the payment reference. Eligible refunds are returned to the original payment method where possible. We Met aims to initiate an approved refund within 5 business days; the final bank or payment-provider credit time may take longer.\n\nUsed talk-time is normally non-refundable because the digital service has already been consumed, except where required by applicable law or where We Met confirms a service or billing error. Cancellation of an uncompleted checkout creates no charge and no talk-time.`,
    safety: `Last updated: 8 August 2026\n\nWe Met is for respectful adult conversations. Do not share phone numbers, email addresses, social-media handles, passwords, OTPs, bank details, payment credentials or private images during calls or chats. Sexual services or requests, harassment, threats, fraud, hate, illegal activity and attempts to move a transaction off-platform are prohibited.\n\nEnd and report any conversation that feels unsafe. Reports may be reviewed by the administrator, who may warn, restrict, suspend or block an account. Voice audio is not recorded by We Met.`,
    delivery: `Last updated: 8 August 2026\n\nWe Met sells a digital service only; no physical goods are shipped. Talk-time is delivered to the customer's wallet after payment verification. Gateway payments can be credited after successful capture. Direct-UPI payments are credited after administrator verification of the submitted UTR and payment proof.\n\nOnce credited, talk-time is available for use when a listener is online. Billing begins only after the live audio connection is established and stops when the connected call ends.`,
  };
  const body = documents[req.params.type];
  if (!body) return res.status(404).json({ error: 'Document not found.' });
  res.json({ type: req.params.type, body, draft: false });
});

module.exports = router;
