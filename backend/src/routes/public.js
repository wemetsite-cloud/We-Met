const express = require('express');
const config = require('../config');
const db = require('../db');
const { decodeProfileImage } = require('../profile-image');
const { asyncHandler } = require('../middleware');

const router = express.Router();

router.get('/config', (_req, res) => res.json({
  appName: config.appName,
  supportEmail: config.supportEmail,
  smsEnabled: config.sms.enabled,
  portals: { customer: '/', listener: '/listener/', admin: '/admin/' },
  pushEnabled: config.webPush.enabled,
  vapidPublicKey: config.webPush.enabled ? config.webPush.publicKey : '',
  iceServers: config.iceServers,
  minimumStartSeconds: config.minimumStartSeconds,
  ringSeconds: config.ringSeconds,
  callingLanguage: 'Malayalam',
}));


router.get('/listener-profile-image/:id', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT profile_image FROM users
     WHERE id=$1 AND role='employee' AND status='active'
       AND listener_verification_status='approved'`,
    [req.params.id],
  );
  const image = decodeProfileImage(result.rows[0]?.profile_image);
  if (!image) return res.status(404).end();
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Length', String(image.buffer.length));
  return res.end(image.buffer);
}));

router.get('/listener-banner-image/:id', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT banner_image FROM users
     WHERE id=$1 AND role='employee' AND status='active'
       AND listener_verification_status='approved'`,
    [req.params.id],
  );
  const image = decodeProfileImage(result.rows[0]?.banner_image);
  if (!image) return res.status(404).end();
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Length', String(image.buffer.length));
  return res.end(image.buffer);
}));

router.get('/legal/:type', (req, res) => {
  const documents = {
    terms: `We Met provides verified listener profiles, private browser conversations, private posts and direct messages. Calls require available talk-time and use it only while audio is connected. The website does not currently accept online purchases. By creating an account, you confirm that you are at least 18 and accept the Terms and Privacy Policy. Threats, harassment, explicit requests, fraud, requests for private contact details, OTPs or financial information, and illegal activity are prohibited. We Met is not an emergency, medical or crisis-response service.`,
    privacy: `We Met stores the information required to operate the service: verified phone-first account details, customer profile photos, listener public profiles and private verification recordings, follows, private posts, direct messages, talk-time activity, call status and duration, reports, notifications and support messages. Listener voice-verification recordings are not published. Customer phone numbers are not shown to listeners. The website does not currently collect online purchase information or connect to an online checkout provider, and it does not record live call audio.`,
    safety: `Keep phone numbers, email addresses, social-media handles, passwords, OTPs, bank details and private images out of calls and messages. End and report any conversation that feels unsafe or inappropriate. Reports are reviewed by the administrator, who may warn, restrict, suspend or block accounts. Live call audio is not recorded by We Met.`,
  };
  const body = documents[req.params.type];
  if (!body) return res.status(404).json({ error: 'Document not found.' });
  res.json({ type: req.params.type, body, draft: false });
});

module.exports = router;
