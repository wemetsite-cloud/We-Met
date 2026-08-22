CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL CHECK (role IN ('customer','employee','admin')),
  name text NOT NULL,
  username text UNIQUE,
  email text UNIQUE,
  phone text,
  bio text,
  profile_image text,
  employee_code text UNIQUE,
  upi_id text,
  upi_phone text,
  listener_rate_paise integer NOT NULL DEFAULT 0 CONSTRAINT users_listener_rate_nonnegative CHECK (listener_rate_paise >= 0),
  listener_availability text NOT NULL DEFAULT 'offline' CHECK (listener_availability IN ('online','break','offline')),
  listener_language text NOT NULL DEFAULT 'Malayalam',
  password_hash text NOT NULL,
  auth_version integer NOT NULL DEFAULT 0,
  balance_seconds integer NOT NULL DEFAULT 0 CHECK (balance_seconds >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','suspended')),
  suspended_until timestamptz,
  suspension_reason text,
  terms_accepted_at timestamptz,
  last_login_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  price_paise integer NOT NULL CHECK (price_paise > 0),
  seconds integer NOT NULL CHECK (seconds > 0),
  popular boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text,
  seconds integer NOT NULL CHECK (seconds > 0),
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  used_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seconds_added integer NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, customer_id)
);


CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  employee_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','connecting','active','ended','rejected','cancelled','failed')),
  started_at timestamptz,
  ended_at timestamptz,
  billed_seconds integer NOT NULL DEFAULT 0,
  listener_rate_paise integer NOT NULL DEFAULT 0 CONSTRAINT calls_listener_rate_nonnegative CHECK (listener_rate_paise >= 0),
  listener_earnings_paise bigint NOT NULL DEFAULT 0 CONSTRAINT calls_listener_earnings_nonnegative CHECK (listener_earnings_paise >= 0),
  earnings_settled_at timestamptz,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listener_activity_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('online','break')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seconds_delta integer NOT NULL,
  type text NOT NULL CHECK (type IN ('coupon','admin_adjustment','call_debit','payment')),
  note text,
  reference_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listener_wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('call_credit','payout','admin_adjustment')),
  amount_paise bigint NOT NULL CHECK (amount_paise <> 0),
  reference_id uuid,
  billed_seconds integer CHECK (billed_seconds IS NULL OR billed_seconds >= 0),
  rate_paise_per_minute integer CHECK (rate_paise_per_minute IS NULL OR rate_paise_per_minute >= 0),
  payout_upi_id text,
  payout_upi_phone text,
  payment_reference text,
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listener_withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 10000),
  payout_upi_id text,
  payout_upi_phone text,
  listener_note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','declined')),
  payment_reference text,
  admin_note text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  paid_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payout_upi_id IS NOT NULL OR payout_upi_phone IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS favorites (
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, employee_id)
);

CREATE TABLE IF NOT EXISTS call_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  details text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','closed')),
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','replied','closed')),
  admin_reply text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  route text NOT NULL,
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','declined','completed')),
  recovery_key_hash text,
  note text,
  admin_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS manual_payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
  plan_name text NOT NULL,
  amount_paise integer NOT NULL CHECK (amount_paise >= 100),
  seconds integer NOT NULL CHECK (seconds > 0),
  checkout_reference text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manual_intent_id uuid UNIQUE REFERENCES manual_payment_intents(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
  plan_name text NOT NULL,
  amount_paise integer NOT NULL CHECK (amount_paise > 0),
  seconds integer NOT NULL CHECK (seconds > 0),
  payment_method text NOT NULL DEFAULT 'upi' CHECK (payment_method IN ('bank_transfer','upi')),
  checkout_reference text,
  destination_last4 text,
  payee_upi_id text,
  utr_reference text,
  customer_note text,
  proof_mime text,
  proof_size integer CHECK (proof_size > 0 AND proof_size <= 3145728),
  proof_data bytea,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  admin_message text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS razorpay_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
  plan_name text NOT NULL,
  amount_paise integer NOT NULL CHECK (amount_paise >= 100),
  currency text NOT NULL CHECK (currency = 'INR'),
  seconds integer NOT NULL CHECK (seconds > 0),
  receipt text NOT NULL UNIQUE,
  razorpay_order_id text NOT NULL UNIQUE,
  razorpay_payment_id text UNIQUE,
  razorpay_signature text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Safe upgrades from earlier packages.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_code text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS upi_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS upi_phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS listener_rate_paise integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS listener_availability text NOT NULL DEFAULT 'offline';
ALTER TABLE users ADD COLUMN IF NOT EXISTS listener_language text NOT NULL DEFAULT 'Malayalam';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS popular boolean NOT NULL DEFAULT false;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_note text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE calls ADD COLUMN IF NOT EXISTS listener_rate_paise integer NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS listener_earnings_paise bigint NOT NULL DEFAULT 0;
-- On an upgrade, mark only the calls that pre-date the earnings feature as
-- historical. Keeping this inside the column-add migration is important:
-- completed calls created after v6.1.0 must remain recoverable if settlement
-- is interrupted and the server restarts.
DO $$
DECLARE
  earnings_column_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema=current_schema()
      AND table_name='calls'
      AND column_name='earnings_settled_at'
  ) INTO earnings_column_exists;

  IF NOT earnings_column_exists THEN
    ALTER TABLE calls ADD COLUMN earnings_settled_at timestamptz;
    UPDATE calls
    SET earnings_settled_at=COALESCE(ended_at,created_at)
    WHERE status IN ('ended','rejected','cancelled','failed');
  END IF;
END $$;
ALTER TABLE password_reset_requests ADD COLUMN IF NOT EXISTS recovery_key_hash text;
ALTER TABLE password_reset_requests ADD COLUMN IF NOT EXISTS admin_message text;
ALTER TABLE password_reset_requests ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours');
ALTER TABLE password_reset_requests ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE password_reset_requests ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS manual_intent_id uuid REFERENCES manual_payment_intents(id) ON DELETE SET NULL;
ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'upi';
ALTER TABLE payment_submissions ALTER COLUMN payment_method SET DEFAULT 'upi';
ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS checkout_reference text;
ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS destination_last4 text;
ALTER TABLE payment_submissions ALTER COLUMN payee_upi_id DROP NOT NULL;
ALTER TABLE payment_submissions ALTER COLUMN proof_mime DROP NOT NULL;
ALTER TABLE payment_submissions ALTER COLUMN proof_size DROP NOT NULL;
ALTER TABLE payment_submissions ALTER COLUMN proof_data DROP NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_listener_availability_check;
ALTER TABLE users ADD CONSTRAINT users_listener_availability_check CHECK (listener_availability IN ('online','break','offline'));

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_listener_rate_nonnegative CHECK (listener_rate_paise >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE calls ADD CONSTRAINT calls_listener_rate_nonnegative CHECK (listener_rate_paise >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE calls ADD CONSTRAINT calls_listener_earnings_nonnegative CHECK (listener_earnings_paise >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE payment_submissions
SET payment_method='upi'
WHERE manual_intent_id IS NULL AND payee_upi_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE payment_submissions DROP CONSTRAINT IF EXISTS payment_submissions_payment_method_check;
  ALTER TABLE payment_submissions ADD CONSTRAINT payment_submissions_payment_method_check CHECK (payment_method IN ('bank_transfer','upi'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE password_reset_requests DROP CONSTRAINT IF EXISTS password_reset_requests_status_check;

UPDATE password_reset_requests SET status='completed' WHERE status='resolved';
UPDATE password_reset_requests SET status='declined' WHERE status='closed';
UPDATE password_reset_requests
SET status='declined',admin_message='Submit a new recovery request to receive a secure recovery key.',resolved_at=now()
WHERE status='open' AND recovery_key_hash IS NULL;

DO $$ BEGIN
  ALTER TABLE password_reset_requests ADD CONSTRAINT password_reset_requests_status_check CHECK (status IN ('open','approved','declined','completed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
  ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check CHECK (type IN ('coupon','admin_adjustment','call_debit','payment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
  ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active','blocked','suspended'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
  ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (status IN ('ringing','connecting','active','ended','rejected','cancelled','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_code ON users(employee_code) WHERE employee_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_name ON plans(name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_call_customer ON calls(customer_id) WHERE status IN ('ringing','connecting','active');
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_call_employee ON calls(employee_id) WHERE status IN ('ringing','connecting','active');
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_listener_activity ON listener_activity_sessions(employee_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_call_debit ON wallet_transactions(reference_id) WHERE type='call_debit' AND reference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_payment_credit ON wallet_transactions(reference_id) WHERE type='payment' AND reference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_listener_wallet_call_credit ON listener_wallet_transactions(reference_id) WHERE type='call_credit' AND reference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_listener_wallet_payout ON listener_wallet_transactions(reference_id) WHERE type='payout' AND reference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_listener_pending_withdrawal ON listener_withdrawal_requests(employee_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role,status);
CREATE INDEX IF NOT EXISTS idx_listener_availability ON users(listener_availability) WHERE role='employee' AND status='active';
CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_employee ON calls(employee_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_listener_activity_employee ON listener_activity_sessions(employee_id,started_at DESC);
CREATE INDEX IF NOT EXISTS idx_listener_activity_started ON listener_activity_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_customer ON wallet_transactions(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listener_wallet_employee ON listener_wallet_transactions(employee_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listener_wallet_type ON listener_wallet_transactions(type,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listener_withdrawal_employee ON listener_withdrawal_requests(employee_id,requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_listener_withdrawal_status ON listener_withdrawal_requests(status,requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_tickets(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_type,target_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_resets_status ON password_reset_requests(status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_recovery_key ON password_reset_requests(recovery_key_hash) WHERE recovery_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_manual_payment_intents_customer ON manual_payment_intents(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_payment_intents_expiry ON manual_payment_intents(expires_at) WHERE submitted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_submission_manual_intent ON payment_submissions(manual_intent_id) WHERE manual_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_utr_live ON payment_submissions((lower(regexp_replace(utr_reference, '\s+', '', 'g')))) WHERE utr_reference IS NOT NULL AND status<>'declined';
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payment_submissions(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payment_submissions(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_razorpay_orders_customer ON razorpay_orders(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_razorpay_orders_status ON razorpay_orders(status,created_at DESC);
UPDATE plans SET active=false,updated_at=now()
WHERE name IN ('Starter','Value','Silver','Gold','Queen','King');

INSERT INTO plans (name,price_paise,seconds,popular,active,sort_order) VALUES
('Quick Connect',4900,300,false,true,10),
('Easy Talk',9900,600,false,true,20),
('Open Talk',19900,1200,true,true,30),
('More Time',24900,1800,false,true,40),
('One Hour',49900,3600,false,true,50),
('Long Connect',199900,14400,false,true,60)
ON CONFLICT (name) DO UPDATE SET
  price_paise=EXCLUDED.price_paise,
  seconds=EXCLUDED.seconds,
  popular=EXCLUDED.popular,
  active=true,
  sort_order=EXCLUDED.sort_order,
  updated_at=now();
