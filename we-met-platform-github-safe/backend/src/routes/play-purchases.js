const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { verifyProductPurchase } = require('../google-play');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const createRateLimit = require('../request-limit');

const router = express.Router();
const verificationLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many purchase checks. Please wait and try again.',
});

function tokenHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function accountHash(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

async function previousPurchase(hash, customerId) {
  const result = await db.query(`
    SELECT purchase.id,purchase.customer_id,purchase.seconds_granted,user.balance_seconds
    FROM play_purchases purchase
    JOIN users user ON user.id=purchase.customer_id
    WHERE purchase.token_hash=$1
  `, [hash]);
  const purchase = result.rows[0];
  if (!purchase) return null;
  if (purchase.customer_id !== customerId) {
    throw Object.assign(new Error('This purchase is already linked to another account.'), { status: 409 });
  }
  return purchase;
}

router.use(authenticate, requireRole('customer'));

router.post('/verify', verificationLimit, asyncHandler(async (req, res) => {
  const productId = String(req.body.productId || '').trim();
  const purchaseToken = String(req.body.purchaseToken || '').trim();
  if (!/^[A-Za-z0-9._-]{3,200}$/.test(productId)) {
    return res.status(400).json({ error: 'The Google Play product ID is invalid.' });
  }
  if (purchaseToken.length < 20 || purchaseToken.length > 4096 || /\s/.test(purchaseToken)) {
    return res.status(400).json({ error: 'The Google Play purchase token is invalid.' });
  }

  const hash = tokenHash(purchaseToken);
  const prior = await previousPurchase(hash, req.user.id);
  if (prior) {
    return res.json({
      credited: false,
      alreadyProcessed: true,
      secondsAdded: Number(prior.seconds_granted),
      balanceSeconds: Number(prior.balance_seconds),
      message: 'This purchase was already added to your wallet.',
    });
  }

  const verified = await verifyProductPurchase(purchaseToken);
  if (verified.purchaseStateContext?.purchaseState !== 'PURCHASED') {
    return res.status(409).json({ error: 'Google Play has not completed this purchase yet.' });
  }
  if (verified.obfuscatedExternalAccountId !== accountHash(req.user.id)) {
    return res.status(409).json({ error: 'This purchase does not belong to the signed-in account.' });
  }

  const lineItems = Array.isArray(verified.productLineItem) ? verified.productLineItem : [];
  const lineItem = lineItems.find((item) => item?.productId === productId);
  if (!lineItem || lineItems.length !== 1) {
    return res.status(400).json({ error: 'The verified Google Play product does not match this pack.' });
  }
  const quantity = Number(lineItem.productOfferDetails?.quantity || 1);
  if (quantity !== 1) {
    return res.status(400).json({ error: 'This talk-time pack must be purchased one at a time.' });
  }
  if (lineItem.productOfferDetails?.consumptionState === 'CONSUMPTION_STATE_CONSUMED') {
    return res.status(409).json({ error: 'This Google Play purchase was already consumed.' });
  }

  const planResult = await db.query(`
    SELECT id,name,seconds
    FROM plans
    WHERE play_product_id=$1 AND active=true
  `, [productId]);
  const plan = planResult.rows[0];
  if (!plan) return res.status(404).json({ error: 'This Google Play pack is not active.' });

  const orderId = String(verified.orderId || req.body.orderId || '').trim().slice(0, 200) || null;
  const completedAt = verified.purchaseCompletionTime ? new Date(verified.purchaseCompletionTime) : null;
  const outcome = await db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [hash]);
    const existing = await client.query(`
      SELECT id,customer_id,seconds_granted FROM play_purchases WHERE token_hash=$1 FOR UPDATE
    `, [hash]);
    if (existing.rows[0]) {
      if (existing.rows[0].customer_id !== req.user.id) {
        throw Object.assign(new Error('This purchase is already linked to another account.'), { status: 409 });
      }
      const balance = await client.query('SELECT balance_seconds FROM users WHERE id=$1', [req.user.id]);
      return {
        alreadyProcessed: true,
        secondsAdded: Number(existing.rows[0].seconds_granted),
        balanceSeconds: Number(balance.rows[0].balance_seconds),
      };
    }

    if (orderId) {
      const duplicateOrder = await client.query('SELECT id FROM play_purchases WHERE order_id=$1 FOR UPDATE', [orderId]);
      if (duplicateOrder.rows[0]) {
        throw Object.assign(new Error('This Google Play order was already processed.'), { status: 409 });
      }
    }

    const inserted = await client.query(`
      INSERT INTO play_purchases(
        customer_id,token_hash,order_id,product_id,quantity,seconds_granted,
        test_purchase,purchase_completed_at
      ) VALUES($1,$2,$3,$4,1,$5,$6,$7)
      RETURNING id
    `, [
      req.user.id,
      hash,
      orderId,
      productId,
      Number(plan.seconds),
      Boolean(verified.testPurchaseContext),
      completedAt && !Number.isNaN(completedAt.valueOf()) ? completedAt : null,
    ]);
    const balance = await client.query(`
      UPDATE users
      SET balance_seconds=balance_seconds+$2,updated_at=now()
      WHERE id=$1
      RETURNING balance_seconds
    `, [req.user.id, Number(plan.seconds)]);
    await client.query(`
      INSERT INTO wallet_transactions(customer_id,seconds_delta,type,note,reference_id)
      VALUES($1,$2,'payment',$3,$4)
    `, [req.user.id, Number(plan.seconds), `Google Play · ${plan.name}`, inserted.rows[0].id]);

    return {
      alreadyProcessed: false,
      secondsAdded: Number(plan.seconds),
      balanceSeconds: Number(balance.rows[0].balance_seconds),
    };
  });

  res.status(outcome.alreadyProcessed ? 200 : 201).json({
    credited: !outcome.alreadyProcessed,
    alreadyProcessed: outcome.alreadyProcessed,
    secondsAdded: outcome.secondsAdded,
    balanceSeconds: outcome.balanceSeconds,
    message: outcome.alreadyProcessed
      ? 'This purchase was already added to your wallet.'
      : `${plan.name} was added to your wallet.`,
  });
}));

module.exports = router;
