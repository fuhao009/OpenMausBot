CREATE TABLE ai_channel_catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ai_channel_audit (
  revision INTEGER PRIMARY KEY,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER ai_channel_catalog_insert_audit
AFTER INSERT ON ai_channel_catalog
BEGIN
  INSERT INTO ai_channel_audit (revision, actor_id, reason, created_at)
  VALUES (NEW.revision, NEW.actor_id, NEW.reason, NEW.updated_at);
END;

CREATE TRIGGER ai_channel_catalog_update_audit
AFTER UPDATE ON ai_channel_catalog
BEGIN
  INSERT INTO ai_channel_audit (revision, actor_id, reason, created_at)
  VALUES (NEW.revision, NEW.actor_id, NEW.reason, NEW.updated_at);
END;
