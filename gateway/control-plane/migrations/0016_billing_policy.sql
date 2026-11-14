CREATE TABLE ai_billing_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  multiplier_bps INTEGER NOT NULL CHECK (multiplier_bps BETWEEN 10000 AND 1000000),
  last_adjusted_at INTEGER,
  adjustment_reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE ai_billing_policy_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  multiplier_bps INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER ai_billing_policy_audit_insert AFTER INSERT ON ai_billing_policy BEGIN
  INSERT INTO ai_billing_policy_audit (revision, policy_json, multiplier_bps, actor_id, reason, created_at)
  VALUES (NEW.revision, NEW.policy_json, NEW.multiplier_bps, NEW.actor_id, NEW.reason, NEW.updated_at);
END;
CREATE TRIGGER ai_billing_policy_audit_update AFTER UPDATE ON ai_billing_policy BEGIN
  INSERT INTO ai_billing_policy_audit (revision, policy_json, multiplier_bps, actor_id, reason, created_at)
  VALUES (NEW.revision, NEW.policy_json, NEW.multiplier_bps, NEW.actor_id, NEW.reason, NEW.updated_at);
END;
CREATE INDEX account_ai_requests_created_idx ON account_ai_requests(created_at DESC, id DESC);
