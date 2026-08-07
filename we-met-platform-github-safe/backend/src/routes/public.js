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
    terms: `We Met is intended for respectful, lawful conversations between people aged 18 or above. By creating an account, you confirm that you are at least 18 and accept these Terms and the Privacy Policy. Calls on the platform are intended to be in Malayalam, while the website interface is in English. Threats, harassment, sexual requests, fraud, asking for personal contact details, requesting OTPs or bank information, and any illegal activity are prohibited. The administrator may review account activity metadata, reports and support messages and may restrict, suspend or block accounts when necessary.`,
    privacy: `We Met stores account information, wallet balance, call duration and status, text messages sent inside an active call, payment references and status, optional payment screenshots, reports, notifications and support messages so the service can operate safely. UPI screenshots are supporting information only and may be removed after the required record-retention period. Razorpay processes gateway payment details under its own privacy and security terms when that gateway is enabled; We Met does not store your card number, UPI PIN or OTP. Customer phone numbers and email addresses are not shown to listeners. Voice audio is not recorded by this version of the platform. Database and service providers may process information only as required to operate the service.`,
    refund: `Talk-time is credited only after a direct UPI payment is independently matched in the receiving account, or after Razorpay confirms that a gateway payment is captured when Razorpay is enabled. Failed, cancelled, incomplete, unmatched or duplicate payment attempts do not receive talk-time. Purchased talk-time is not exchangeable for cash and is not refundable after use, except where required by law or expressly approved by the administrator. Contact support with the UPI transaction ID or Razorpay payment reference if a completed payment is not reflected in your wallet.`,
    safety: `Do not share phone numbers, email addresses, social-media handles, passwords, OTPs, bank details, payment information or private images during calls or chats. End and report any conversation that feels unsafe. Reports are reviewed by the administrator, who may warn, restrict, suspend or block an account. Voice audio is not recorded by We Met.`,
  };
  const body = documents[req.params.type];
  if (!body) return res.status(404).json({ error: 'Document not found.' });
  res.json({ type: req.params.type, body, draft: true });
});

module.exports = router;
