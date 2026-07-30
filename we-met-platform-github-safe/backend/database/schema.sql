CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL CHECK (role IN ('customer','employee','admin')),
  name text NOT NULL,
  username text UNIQUE,
  email text UNIQUE,
  phone text,
  date_of_birth date,
  bio text,
  employee_code text UNIQUE,
  upi_id text,
  password_hash text NOT NULL,
  balance_seconds integer NOT NULL DEFAULT 0 CHECK (balance_seconds >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','suspended')),
  suspended_until timestamptz,
  suspension_reason text,
  terms_accepted_at timestamptz,
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
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seconds_delta integer NOT NULL,
  type text NOT NULL CHECK (type IN ('coupon','admin_adjustment','call_debit')),
  note text,
  reference_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
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

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','closed')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Safe upgrades from earlier packages.
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_code text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS upi_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS popular boolean NOT NULL DEFAULT false;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_note text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

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
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_call_debit ON wallet_transactions(reference_id) WHERE type='call_debit' AND reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role,status);
CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_employee ON calls(employee_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_wallet_customer ON wallet_transactions(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_tickets(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC);

INSERT INTO plans (name,price_paise,seconds,popular,active,sort_order) VALUES
('Starter',4900,300,false,true,10),
('Value',9900,600,false,true,20),
('Silver',19900,1200,true,true,30),
('Gold',24900,1800,false,true,40),
('Queen',49900,3600,false,true,50),
('King',199900,12000,false,true,60)
ON CONFLICT (name) DO UPDATE SET
  price_paise=EXCLUDED.price_paise,
  seconds=EXCLUDED.seconds,
  popular=EXCLUDED.popular,
  active=true,
  sort_order=EXCLUDED.sort_order,
  updated_at=now();
