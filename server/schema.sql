-- ============================================================
--  Student Pocket Filler — PostgreSQL Schema
--  Run this once to initialize the database
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  USERS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255)    NOT NULL,
  email           VARCHAR(255)    UNIQUE NOT NULL,
  password_hash   VARCHAR(255)    NOT NULL,
  phone           VARCHAR(20),
  college         VARCHAR(255),
  upi_id          VARCHAR(255),
  wallet_balance  DECIMAL(10,2)   NOT NULL DEFAULT 0,
  total_earned    DECIMAL(10,2)   NOT NULL DEFAULT 0,
  surveys_completed INTEGER       NOT NULL DEFAULT 0,
  role            VARCHAR(20)     NOT NULL DEFAULT 'student'
                  CHECK (role IN ('student', 'admin')),
  created_at      TIMESTAMP       NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP       NOT NULL DEFAULT NOW()
);

-- ============================================================
--  SURVEY CODE SUBMISSIONS TABLE
--  Students submit completion codes after finishing a survey
-- ============================================================
CREATE TABLE IF NOT EXISTS survey_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  survey_id        VARCHAR(50)  NOT NULL,
  survey_name      VARCHAR(255) NOT NULL,
  survey_type      VARCHAR(20)  NOT NULL CHECK (survey_type IN ('quick', 'standard', 'mega')),
  completion_code  VARCHAR(100) NOT NULL,
  amount_inr       DECIMAL(10,2) NOT NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  reviewed_at      TIMESTAMP
);

-- Prevent a user from submitting the same code twice
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_codes_user_code
  ON survey_codes(user_id, completion_code);

-- ============================================================
--  TRANSACTIONS TABLE
--  Immutable ledger of all credits and debits
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      DECIMAL(10,2) NOT NULL,
  type        VARCHAR(10)   NOT NULL CHECK (type IN ('credit', 'debit')),
  note        VARCHAR(500),
  status      VARCHAR(20)   NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'reversed')),
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
--  WITHDRAWALS TABLE
--  Student cash-out requests
-- ============================================================
CREATE TABLE IF NOT EXISTS withdrawals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upi_id        VARCHAR(255) NOT NULL,
  amount        DECIMAL(10,2) NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'rejected')),
  requested_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMP
);

-- ============================================================
--  CPX POSTBACK DEDUP TABLE
--  Prevents double-crediting from CPX Research postbacks
-- ============================================================
CREATE TABLE IF NOT EXISTS cpx_postbacks (
  trans_id    VARCHAR(255) PRIMARY KEY,
  user_id     UUID NOT NULL,
  amount_inr  DECIMAL(10,2) NOT NULL,
  status      VARCHAR(10)  NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
--  INDEXES for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_survey_codes_user    ON survey_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_survey_codes_status  ON survey_codes(status);
CREATE INDEX IF NOT EXISTS idx_transactions_user    ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user     ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status   ON withdrawals(status);
