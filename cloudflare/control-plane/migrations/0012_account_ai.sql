-- Account-funded hosted AI: permission, short-lived model credentials, the
-- per-request reservation ledger, and the operator adjustment audit.
--
-- Money is stored in micro-USD (1 USD = 1,000,000) and token counts in
-- tokens; both are nonnegative JavaScript safe integers, so the CHECK bounds
-- are the same number the Worker can represent. Arithmetic that decides a
-- charge happens in BigInt in `src/ai-wallet.ts`; these triggers keep the
-- stored invariants true even for two Workers writing at once.
--
-- Nothing here cascades from "user" or "session": deleting an account must
-- never erase settled charges, and a request whose token was revoked (or
-- whose session was signed out) keeps its accounting. Revoked credentials and
-- their history simply stop admitting new work.
CREATE TABLE account_ai_balances (
  owner_user_id TEXT PRIMARY KEY REFERENCES "user"(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- Set on the first enable and never cleared: a disabled account that was
  -- once activated reads as suspended, not as a new registration.
  activated_at INTEGER,
  available_micro_usd INTEGER NOT NULL DEFAULT 0
    CHECK (available_micro_usd BETWEEN 0 AND 9007199254740991),
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0
    CHECK (reserved_micro_usd BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL
);

-- A model credential is `omb_product_ai_<lookup>.<secret>`; only the SHA-256
-- of the whole header value is stored. `session_id` is Better Auth's stable
-- session id (never the raw bearer), and deliberately carries no foreign key:
-- a signed-out session must invalidate admission without deleting the token
-- or the requests it paid for.
CREATE TABLE account_ai_tokens (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id),
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 64),
  lookup_id TEXT NOT NULL UNIQUE CHECK (length(lookup_id) = 22),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER
);

CREATE INDEX account_ai_tokens_owner_idx
  ON account_ai_tokens(owner_user_id, revoked_at, expires_at);
CREATE INDEX account_ai_tokens_session_idx ON account_ai_tokens(session_id);
CREATE INDEX account_ai_tokens_device_idx
  ON account_ai_tokens(owner_user_id, device_id, revoked_at, expires_at);
CREATE INDEX account_ai_tokens_expiry_idx ON account_ai_tokens(expires_at);

-- At most two unexpired credentials per device so a renewal can hand off
-- without a gap; at most ten devices per account. Both limits are also
-- enforced by the issuing code, but only a trigger is atomic against two
-- concurrent issuances.
CREATE TRIGGER account_ai_tokens_device_limit_before_insert
BEFORE INSERT ON account_ai_tokens
WHEN NEW.revoked_at IS NULL
  AND (
    SELECT COUNT(*)
    FROM account_ai_tokens
    WHERE owner_user_id = NEW.owner_user_id
      AND device_id = NEW.device_id
      AND revoked_at IS NULL
      AND expires_at > NEW.created_at
  ) >= 2
BEGIN
  SELECT RAISE(ABORT, 'ai_token_device_limit');
END;

CREATE TRIGGER account_ai_tokens_account_limit_before_insert
BEFORE INSERT ON account_ai_tokens
WHEN NEW.revoked_at IS NULL
  AND (
    SELECT COUNT(DISTINCT device_id)
    FROM account_ai_tokens
    WHERE owner_user_id = NEW.owner_user_id
      AND device_id <> NEW.device_id
      AND revoked_at IS NULL
      AND expires_at > NEW.created_at
  ) >= 10
BEGIN
  SELECT RAISE(ABORT, 'ai_token_account_limit');
END;

-- One row per upstream call, including tool follow-ups and retries. Rates are
-- the price snapshot taken when the request was admitted, so an operator price
-- change never retroactively reprices work already in flight.
CREATE TABLE account_ai_requests (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id),
  -- No FK: revoking a credential must not delete (or block deleting) history.
  token_id TEXT NOT NULL,
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  endpoint TEXT NOT NULL CHECK (endpoint IN ('chat', 'responses')),
  pricing_version TEXT NOT NULL CHECK (length(pricing_version) BETWEEN 1 AND 64),
  input_rate INTEGER NOT NULL CHECK (input_rate BETWEEN 0 AND 9007199254740991),
  cached_rate INTEGER NOT NULL CHECK (cached_rate BETWEEN 0 AND 9007199254740991),
  output_rate INTEGER NOT NULL CHECK (output_rate BETWEEN 0 AND 9007199254740991),
  max_input_tokens INTEGER NOT NULL
    CHECK (max_input_tokens BETWEEN 1 AND 9007199254740991),
  max_output_tokens INTEGER NOT NULL
    CHECK (max_output_tokens BETWEEN 0 AND 9007199254740991),
  reserved_micro_usd INTEGER NOT NULL
    CHECK (reserved_micro_usd BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'streaming', 'review', 'settled')),
  charged_micro_usd INTEGER
    CHECK (charged_micro_usd IS NULL OR charged_micro_usd BETWEEN 0 AND 9007199254740991),
  input_tokens INTEGER
    CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 9007199254740991),
  cached_input_tokens INTEGER
    CHECK (cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER
    CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 9007199254740991),
  settlement_reason TEXT
    CHECK (settlement_reason IS NULL OR length(settlement_reason) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER,
  -- A settled request always carries the charge that was actually taken.
  CHECK (state <> 'settled' OR charged_micro_usd IS NOT NULL)
);

CREATE INDEX account_ai_requests_owner_idx
  ON account_ai_requests(owner_user_id, created_at, id);
CREATE INDEX account_ai_requests_state_idx ON account_ai_requests(state, created_at);

-- Admission is one statement (`INSERT ... SELECT` over the balance row), so
-- enabled, token/session liveness, balance cover, and the in-flight ceiling
-- are all decided against one snapshot. This trigger is the atomic in-flight
-- ceiling: `reserved` and `streaming` count, `review` does not (its money
-- stays reserved but it no longer occupies an execution slot).
CREATE TRIGGER account_ai_requests_in_flight_before_insert
BEFORE INSERT ON account_ai_requests
WHEN NEW.state = 'reserved'
  AND (
    SELECT COUNT(*)
    FROM account_ai_requests
    WHERE owner_user_id = NEW.owner_user_id
      AND state IN ('reserved', 'streaming')
  ) >= 2
BEGIN
  SELECT RAISE(ABORT, 'ai_busy');
END;

-- The reserve transfer: the INSERT itself only happens when the whole
-- admission test holds, so a rejected request never touches the balance. A
-- concurrent admission that read the same pre-state fails the guarded UPDATE
-- and aborts this statement, rolling the request row back with it.
CREATE TRIGGER account_ai_requests_reserve_after_insert
AFTER INSERT ON account_ai_requests
WHEN NEW.state = 'reserved'
BEGIN
  UPDATE account_ai_balances
     SET available_micro_usd = available_micro_usd - NEW.reserved_micro_usd,
         reserved_micro_usd = reserved_micro_usd + NEW.reserved_micro_usd,
         updated_at = NEW.created_at
   WHERE owner_user_id = NEW.owner_user_id
     AND available_micro_usd >= NEW.reserved_micro_usd;
  SELECT RAISE(ABORT, 'ai_reserve_conflict') WHERE changes() = 0;
END;

-- Reservation state is append-only: reserved -> streaming|review|settled,
-- streaming -> review|settled, review -> settled. Nothing goes back.
CREATE TRIGGER account_ai_requests_state_transition_before_update
BEFORE UPDATE OF state ON account_ai_requests
WHEN NEW.state <> OLD.state
  AND NOT (
    (OLD.state = 'reserved' AND NEW.state IN ('streaming', 'review', 'settled'))
    OR (OLD.state = 'streaming' AND NEW.state IN ('review', 'settled'))
    OR (OLD.state = 'review' AND NEW.state = 'settled')
  )
BEGIN
  SELECT RAISE(ABORT, 'ai_request_state_invalid');
END;

-- The admission snapshot and the money it moved are immutable. Only the
-- settlement fields (state, charge, usage, reason, timestamps) may change.
CREATE TRIGGER account_ai_requests_snapshot_before_update
BEFORE UPDATE ON account_ai_requests
WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
  OR NEW.token_id IS NOT OLD.token_id
  OR NEW.model IS NOT OLD.model
  OR NEW.endpoint IS NOT OLD.endpoint
  OR NEW.pricing_version IS NOT OLD.pricing_version
  OR NEW.input_rate IS NOT OLD.input_rate
  OR NEW.cached_rate IS NOT OLD.cached_rate
  OR NEW.output_rate IS NOT OLD.output_rate
  OR NEW.max_input_tokens IS NOT OLD.max_input_tokens
  OR NEW.max_output_tokens IS NOT OLD.max_output_tokens
  OR NEW.reserved_micro_usd IS NOT OLD.reserved_micro_usd
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'ai_request_immutable');
END;

-- A settled row is final: neither the charge nor the reservation it released
-- can be rewritten, so a repeated settlement can never refund twice.
CREATE TRIGGER account_ai_requests_settled_before_update
BEFORE UPDATE ON account_ai_requests
WHEN OLD.state = 'settled'
  AND (
    NEW.state <> 'settled'
    OR NEW.charged_micro_usd IS NOT OLD.charged_micro_usd
    OR NEW.reserved_micro_usd IS NOT OLD.reserved_micro_usd
  )
BEGIN
  SELECT RAISE(ABORT, 'ai_request_immutable');
END;

-- A settlement may never charge more than was reserved: `review` is settled
-- at an operator-chosen amount inside [0, R].
CREATE TRIGGER account_ai_requests_charge_before_update
BEFORE UPDATE OF state ON account_ai_requests
WHEN NEW.state = 'settled'
  AND OLD.state <> 'settled'
  AND NEW.charged_micro_usd > OLD.reserved_micro_usd
BEGIN
  SELECT RAISE(ABORT, 'ai_charge_invalid');
END;

-- Release the reservation exactly once per request and return the unused
-- part. The trigger only fires on the transition into `settled`, so replaying
-- a settlement (or an operator retry) cannot refund a second time.
CREATE TRIGGER account_ai_requests_settle_after_update
AFTER UPDATE OF state ON account_ai_requests
WHEN NEW.state = 'settled' AND OLD.state <> 'settled'
BEGIN
  UPDATE account_ai_balances
     SET reserved_micro_usd = reserved_micro_usd - OLD.reserved_micro_usd,
         available_micro_usd = available_micro_usd
           + (OLD.reserved_micro_usd - NEW.charged_micro_usd),
         updated_at = NEW.updated_at
   WHERE owner_user_id = NEW.owner_user_id;
END;

-- Operator audit and idempotency: one row per operation id, carrying the
-- canonical body hash and the exact result returned the first time. The
-- effect (enable, disable, grant, settle) is applied by the triggers below in
-- the same statement, so audit and money can never disagree.
CREATE TABLE account_ai_adjustments (
  operation_id TEXT PRIMARY KEY,
  operator_user_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('enable', 'disable', 'grant', 'settle')),
  request_id TEXT,
  body_hash TEXT NOT NULL CHECK (length(body_hash) = 64),
  amount_micro_usd INTEGER
    CHECK (amount_micro_usd IS NULL OR amount_micro_usd BETWEEN 0 AND 9007199254740991),
  enabled INTEGER CHECK (enabled IS NULL OR enabled IN (0, 1)),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  CHECK (
    (kind = 'grant' AND amount_micro_usd IS NOT NULL AND amount_micro_usd > 0
      AND enabled IS NULL AND request_id IS NULL)
    OR (kind IN ('enable', 'disable') AND enabled IS NOT NULL AND amount_micro_usd IS NULL
        AND request_id IS NULL)
    OR (kind = 'settle' AND request_id IS NOT NULL
        AND amount_micro_usd IS NOT NULL AND amount_micro_usd >= 0 AND enabled IS NULL)
  ),
  CHECK (kind <> 'enable' OR enabled = 1),
  CHECK (kind <> 'disable' OR enabled = 0)
);

CREATE INDEX account_ai_adjustments_owner_idx
  ON account_ai_adjustments(owner_user_id, created_at, operation_id);

-- The audit trail is write-once. DELETE stays available so a test database
-- (and any future retention job) can be emptied; UPDATE never is.
CREATE TRIGGER account_ai_adjustments_immutable_before_update
BEFORE UPDATE ON account_ai_adjustments
BEGIN
  SELECT RAISE(ABORT, 'ai_adjustment_immutable');
END;

-- Grant: positive credit only, creating the ledger row on first use. The guard
-- counts the reservation too: an in-flight request returns into `available`
-- at settlement, so available + reserved + credit must stay representable.
CREATE TRIGGER account_ai_adjustments_grant_before_insert
BEFORE INSERT ON account_ai_adjustments
WHEN NEW.kind = 'grant'
  AND EXISTS (
    SELECT 1 FROM account_ai_balances
     WHERE owner_user_id = NEW.owner_user_id
       AND (available_micro_usd + reserved_micro_usd + NEW.amount_micro_usd) > 9007199254740991
  )
BEGIN
  SELECT RAISE(ABORT, 'ai_balance_overflow');
END;

CREATE TRIGGER account_ai_adjustments_grant_after_insert
AFTER INSERT ON account_ai_adjustments
WHEN NEW.kind = 'grant'
BEGIN
  INSERT INTO account_ai_balances
    (owner_user_id, enabled, available_micro_usd, reserved_micro_usd, updated_at)
  VALUES (NEW.owner_user_id, 0, NEW.amount_micro_usd, 0, NEW.created_at)
  ON CONFLICT(owner_user_id) DO UPDATE SET
    available_micro_usd = account_ai_balances.available_micro_usd + excluded.available_micro_usd,
    updated_at = excluded.updated_at;
END;

-- Enable stamps `activated_at` once and re-enabling keeps the original stamp.
CREATE TRIGGER account_ai_adjustments_enable_after_insert
AFTER INSERT ON account_ai_adjustments
WHEN NEW.kind = 'enable'
BEGIN
  INSERT INTO account_ai_balances
    (owner_user_id, enabled, activated_at, available_micro_usd, reserved_micro_usd, updated_at)
  VALUES (NEW.owner_user_id, 1, NEW.created_at, 0, 0, NEW.created_at)
  ON CONFLICT(owner_user_id) DO UPDATE SET
    enabled = 1,
    activated_at = COALESCE(account_ai_balances.activated_at, excluded.activated_at),
    updated_at = excluded.updated_at;
END;

-- Disabling blocks new admission but keeps balance, history, and in-flight
-- reservations exactly as they are.
CREATE TRIGGER account_ai_adjustments_disable_after_insert
AFTER INSERT ON account_ai_adjustments
WHEN NEW.kind = 'disable'
BEGIN
  UPDATE account_ai_balances
     SET enabled = 0, updated_at = NEW.created_at
   WHERE owner_user_id = NEW.owner_user_id;
END;

-- A settlement is only meaningful for a request awaiting review, for at most
-- its reservation. The pairing is checked before the audit row is written, so
-- a rejected settlement leaves no trace and no money movement.
CREATE TRIGGER account_ai_adjustments_settle_before_insert
BEFORE INSERT ON account_ai_adjustments
WHEN NEW.kind = 'settle'
  AND NEW.amount_micro_usd IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM account_ai_requests
     WHERE id = NEW.request_id
       AND owner_user_id = NEW.owner_user_id
       AND state = 'review'
       AND NEW.amount_micro_usd <= reserved_micro_usd
  )
BEGIN
  SELECT RAISE(ABORT, 'ai_request_not_in_review');
END;

CREATE TRIGGER account_ai_adjustments_settle_after_insert
AFTER INSERT ON account_ai_adjustments
WHEN NEW.kind = 'settle'
BEGIN
  UPDATE account_ai_requests
     SET state = 'settled',
         charged_micro_usd = NEW.amount_micro_usd,
         settlement_reason = substr(NEW.reason, 1, 200),
         settled_at = NEW.created_at,
         updated_at = NEW.created_at
   WHERE id = NEW.request_id
     AND owner_user_id = NEW.owner_user_id;
END;
