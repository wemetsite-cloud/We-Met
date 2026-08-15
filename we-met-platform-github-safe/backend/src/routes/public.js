const express = require('express');
const config = require('../config');

const router = express.Router();

router.get('/config', (_req, res) => res.json({
  appName: config.appName,
  supportEmail: config.supportEmail,
  directUpiEnabled: config.upiPayment.enabled,
  googlePlayBillingEnabled: config.googlePlay.enabled,
  pushEnabled: config.webPush.enabled,
  vapidPublicKey: config.webPush.enabled ? config.webPush.publicKey : '',
  iceServers: config.iceServers,
  minimumStartSeconds: config.minimumStartSeconds,
  ringSeconds: config.ringSeconds,
  callingLanguage: 'Malayalam',
}));

router.get('/legal/:type', (req, res) => {
  const documents = {
    terms: `We Met is an 18+ service that connects customers with available listeners for respectful, lawful conversation. By creating an account, you confirm that you are at least 18 and accept these Terms and the Privacy Policy. Malayalam is the default call language, and customers may optionally connect with listeners assigned to other languages. Harassment, explicit requests, fraud, attempts to exchange personal contact details, requests for OTPs or financial information, and unlawful activity are prohibited. We Met is not an emergency, medical or crisis-response service. Administrators may review account metadata, reports and support messages and may restrict, suspend or close accounts when necessary.`,
    privacy: `We Met stores information needed to operate and secure the service: account details, wallet balance, call duration and status, listener rates and earnings ledgers, listener payout details and payment references, messages sent during an active call, reports, notifications and support messages. For Google Play purchases, the service processes product identifiers, order details and purchase tokens; only a one-way hash of a processed purchase token is retained. Customer contact details are not shown to listeners. Voice audio is not recorded by We Met. Customers can request account deletion in the app or at /delete-account.html. Listener identity is anonymised on deletion while legally required, de-identified payout and accounting records may be retained. Service providers process information only as required to host, secure and operate the platform.`,
    refund: `Talk-time purchased in the Android customer app is handled through Google Play Billing. Google Play purchase and refund rules apply. Used talk-time is not exchangeable for cash except where required by law. If a completed purchase is not reflected in the wallet, contact support with the Google Play order reference. Direct payment submission is disabled in the Play-distributed app.`,
    safety: `We Met is for respectful 18+ conversation. Keep phone numbers, email addresses, social-media handles, passwords, OTPs, bank details and private images out of calls and chats. End and report any conversation that violates these rules. Customers can block a listener from call history so they are not connected again. Reports are reviewed and may result in warnings, restrictions, suspension or account closure. Voice audio is not recorded by We Met.`,
    childSafety: `We Met is restricted to adults aged 18 and older. The service has zero tolerance for child sexual abuse and exploitation, grooming, solicitation, trafficking, or content that sexualises or endangers minors. Users can report a call or account in the app and contact wemetsite@gmail.com. We remove prohibited content, restrict accounts, preserve required evidence and report apparent violations to the appropriate authorities and, where applicable, the National Center for Missing & Exploited Children.`,
    accountDeletion: `Customers can permanently delete their account from Account and safety in the app or by using /delete-account.html. Deletion removes the customer profile, wallet and associated call content after active calls end. Listeners can delete their account from Profile in the listener app; their identity is anonymised while de-identified payout and accounting records may be retained where legally required.`,
  };
  const aliases = { 'child-safety': 'childSafety', 'account-deletion': 'accountDeletion' };
  const body = documents[aliases[req.params.type] || req.params.type];
  if (!body) return res.status(404).json({ error: 'Document not found.' });
  res.json({ type: req.params.type, body, draft: false });
});

module.exports = router;
