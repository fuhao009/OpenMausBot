-- Collect trusted usage atomically, including usage beyond an admission estimate.
DROP TRIGGER account_ai_requests_charge_before_update;
CREATE TRIGGER account_ai_requests_charge_before_update
BEFORE UPDATE OF state ON account_ai_requests
WHEN NEW.state = 'settled' AND OLD.state <> 'settled'
  AND NEW.charged_micro_points > coalesce(OLD.charged_micro_points,
    OLD.reserved_micro_points + (SELECT available_micro_points FROM account_ai_balances WHERE owner_user_id = OLD.owner_user_id))
BEGIN
  SELECT RAISE(ABORT, 'ai_charge_invalid');
END;

DROP TRIGGER account_ai_requests_settle_after_update;
CREATE TRIGGER account_ai_requests_settle_after_update
AFTER UPDATE OF state ON account_ai_requests
WHEN NEW.state = 'settled' AND OLD.state <> 'settled'
BEGIN
  UPDATE account_ai_balances
     SET reserved_micro_points = reserved_micro_points - iif(OLD.charged_micro_points IS NULL, OLD.reserved_micro_points, 0),
         available_micro_points = available_micro_points + coalesce(OLD.charged_micro_points, OLD.reserved_micro_points) - NEW.charged_micro_points,
         updated_at = NEW.updated_at
   WHERE owner_user_id = NEW.owner_user_id;
END;

CREATE TRIGGER account_ai_requests_partial_charge_after_update
AFTER UPDATE OF state ON account_ai_requests
WHEN NEW.state = 'review' AND OLD.state IN ('reserved', 'streaming') AND NEW.charged_micro_points IS NOT NULL
BEGIN
  UPDATE account_ai_balances
     SET reserved_micro_points = reserved_micro_points - OLD.reserved_micro_points,
         available_micro_points = available_micro_points + OLD.reserved_micro_points - NEW.charged_micro_points,
         updated_at = NEW.updated_at
   WHERE owner_user_id = NEW.owner_user_id;
END;

DROP TRIGGER account_ai_adjustments_settle_before_insert;
CREATE TRIGGER account_ai_adjustments_settle_before_insert
BEFORE INSERT ON account_ai_adjustments
WHEN NEW.kind = 'settle'
BEGIN
  SELECT RAISE(ABORT, 'ai_request_not_in_review') WHERE NOT EXISTS (
    SELECT 1 FROM account_ai_requests WHERE id = NEW.request_id AND owner_user_id = NEW.owner_user_id AND state = 'review'
  );
  SELECT RAISE(ABORT, 'ai_charge_invalid') WHERE NEW.amount_micro_points > (
    SELECT coalesce(charged_micro_points, reserved_micro_points) FROM account_ai_requests WHERE id = NEW.request_id
  );
END;
