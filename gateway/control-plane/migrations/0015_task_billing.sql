-- Dynamic pricing is frozen in the request row, in the same admission statement
-- that transfers the reservation. Historical requests retain NULL metadata.
ALTER TABLE account_ai_requests ADD COLUMN billing_snapshot TEXT
  CHECK (billing_snapshot IS NULL OR (json_valid(billing_snapshot) AND json_type(billing_snapshot) = 'object'));
ALTER TABLE account_ai_requests ADD COLUMN cost_micro_currency INTEGER
  CHECK (cost_micro_currency IS NULL OR (typeof(cost_micro_currency) = 'integer' AND cost_micro_currency BETWEEN 0 AND 9007199254740991));
ALTER TABLE account_ai_requests ADD COLUMN cost_status TEXT
  CHECK (cost_status IS NULL OR cost_status IN ('estimated', 'conservative', 'unknown'));
ALTER TABLE account_ai_requests ADD COLUMN cache_write_tokens INTEGER
  CHECK (cache_write_tokens IS NULL OR (typeof(cache_write_tokens) = 'integer' AND cache_write_tokens BETWEEN 0 AND 9007199254740991));
ALTER TABLE account_ai_requests ADD COLUMN cache_write_hour_tokens INTEGER
  CHECK (cache_write_hour_tokens IS NULL OR (typeof(cache_write_hour_tokens) = 'integer' AND cache_write_hour_tokens BETWEEN 0 AND 9007199254740991));
ALTER TABLE account_ai_requests ADD COLUMN latency_ms INTEGER
  CHECK (latency_ms IS NULL OR (typeof(latency_ms) = 'integer' AND latency_ms BETWEEN 0 AND 9007199254740991));

-- Extend, rather than replace, the original immutable pricing trigger.
CREATE TRIGGER account_ai_requests_billing_snapshot_before_update
BEFORE UPDATE ON account_ai_requests
WHEN NEW.billing_snapshot IS NOT OLD.billing_snapshot
BEGIN
  SELECT RAISE(ABORT, 'ai_request_immutable');
END;

CREATE TRIGGER account_ai_requests_billing_settled_before_update
BEFORE UPDATE ON account_ai_requests
WHEN OLD.state = 'settled' AND (
  NEW.cost_micro_currency IS NOT OLD.cost_micro_currency
  OR NEW.cost_status IS NOT OLD.cost_status
  OR NEW.cache_write_tokens IS NOT OLD.cache_write_tokens
  OR NEW.cache_write_hour_tokens IS NOT OLD.cache_write_hour_tokens
  OR NEW.latency_ms IS NOT OLD.latency_ms
)
BEGIN
  SELECT RAISE(ABORT, 'ai_request_immutable');
END;

-- Operator settlement chooses a charge, not an upstream procurement cost.
-- Keep its original audit-and-money atomicity and preserve historical rows.
DROP TRIGGER account_ai_adjustments_settle_after_insert;
CREATE TRIGGER account_ai_adjustments_settle_after_insert
AFTER INSERT ON account_ai_adjustments
WHEN NEW.kind = 'settle'
BEGIN
  UPDATE account_ai_requests
     SET state = 'settled',
         charged_micro_points = NEW.amount_micro_points,
         settlement_reason = substr(NEW.reason, 1, 200),
         settled_at = NEW.created_at,
         updated_at = NEW.created_at,
         cost_micro_currency = NULL,
         cost_status = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE 'unknown' END,
         latency_ms = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE max(0, NEW.created_at - created_at) END
   WHERE id = NEW.request_id AND owner_user_id = NEW.owner_user_id;
END;
