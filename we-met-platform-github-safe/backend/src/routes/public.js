const express = require('express');
const config = require('../config');

const router = express.Router();

router.get('/config', (_req, res) => res.json({
  appName: config.appName,
  supportEmail: config.supportEmail,
  directUpiEnabled: true,
  pushEnabled: config.webPush.enabled,
  vapidPublicKey: config.webPush.enabled ? config.webPush.publicKey : '',
  iceServers: config.iceServers,
  minimumStartSeconds: config.minimumStartSeconds,
  ringSeconds: config.ringSeconds,
  callingLanguage: 'Malayalam',
}));

router.get('/legal/:type', (req, res) => {
  const documents = {
    terms: `We Met connects customers with available listeners for respectful, lawful conversation. By creating an account, you confirm that you are legally eligible to use the service and accept these Terms and the Privacy Policy. Malayalam is the default call language, and customers may optionally connect with listeners assigned to other languages. Threats, harassment, explicit requests, fraud, requests for personal contact details, requests for OTPs or financial information, and illegal activity are prohibited. We Met is not an emergency, medical or crisis-response service. The administrator may review account activity metadata, reports and support messages and may restrict, suspend or block accounts when necessary.`,
    privacy: `We Met stores the information required to operate the service: account details, wallet balance, call duration and status, text messages sent during an active call, direct-UPI payment references and verification screenshots, reports, notifications and support messages. Payment screenshots are accessible only to authorised administrators and may be removed after the required record-retention period. We Met does not ask for or store your UPI PIN or OTP. Customer phone numbers and email addresses are not shown to listeners. Voice audio is not recorded by We Met. Service providers may process information only as required to host and operate the platform.`,
    refund: `Talk-time is credited only after an administrator verifies the submitted UPI transaction reference and successful-payment screenshot. Failed, incomplete, declined or duplicate submissions do not receive talk-time. Used talk-time is not refundable or exchangeable for cash, except where required by law. If a successful payment is not reflected in your wallet, contact support with the UPI transaction reference so the payment can be reviewed.`,
    safety: `Keep phone numbers, email addresses, social-media handles, passwords, OTPs, bank details and private images out of calls and chats. End and report any conversation that feels unsafe or inappropriate. Reports are reviewed by the administrator, who may warn, restrict, suspend or block an account. Voice audio is not recorded by We Met.`,
  };
  const body = documents[req.params.type];
  if (!body) return res.status(404).json({ error: 'Document not found.' });
  res.json({ type: req.params.type, body, draft: false });
});

module.exports = router;
