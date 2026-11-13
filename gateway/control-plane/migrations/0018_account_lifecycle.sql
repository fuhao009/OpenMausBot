CREATE TABLE account_lifecycle (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  password_change_required INTEGER NOT NULL DEFAULT 0 CHECK (password_change_required IN (0,1))
);
CREATE TABLE account_lifecycle_audit (
  operation_id TEXT PRIMARY KEY,
  operator_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('disable','delete','reset-password','change-password')),
  reason TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  password_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER account_lifecycle_audit_immutable BEFORE UPDATE ON account_lifecycle_audit
BEGIN SELECT RAISE(ABORT, 'account_audit_immutable'); END;
CREATE TRIGGER account_lifecycle_apply AFTER INSERT ON account_lifecycle_audit
BEGIN
  SELECT RAISE(ABORT, 'account_not_found') WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE id=NEW.user_id);
  SELECT RAISE(ABORT, 'account_deleted') WHERE EXISTS (SELECT 1 FROM account_lifecycle WHERE user_id=NEW.user_id AND deleted=1);
  SELECT RAISE(ABORT, 'account_delete_conflict') WHERE NEW.kind='delete' AND (
    EXISTS (SELECT 1 FROM account_ai_balances WHERE owner_user_id=NEW.user_id AND reserved_micro_points<>0)
    OR EXISTS (SELECT 1 FROM account_ai_requests WHERE owner_user_id=NEW.user_id AND state IN ('reserved','streaming','review')));
  SELECT RAISE(ABORT, 'account_reset_conflict') WHERE NEW.kind IN ('reset-password','change-password') AND (
    EXISTS (SELECT 1 FROM account_lifecycle WHERE user_id=NEW.user_id AND disabled=1)
    OR NOT EXISTS (SELECT 1 FROM "account" WHERE "userId"=NEW.user_id AND "providerId"='credential'));
  SELECT RAISE(ABORT, 'password_change_not_required') WHERE NEW.kind='change-password' AND NOT EXISTS
    (SELECT 1 FROM account_lifecycle WHERE user_id=NEW.user_id AND password_change_required=1);
  INSERT INTO account_lifecycle(user_id) VALUES(NEW.user_id) ON CONFLICT DO NOTHING;
  UPDATE account_lifecycle SET disabled=1
    WHERE user_id=NEW.user_id AND NEW.kind IN ('disable','delete');
  UPDATE account_lifecycle SET deleted=1
    WHERE user_id=NEW.user_id AND NEW.kind='delete';
  UPDATE account_lifecycle SET password_change_required=1
    WHERE user_id=NEW.user_id AND NEW.kind='reset-password';
  UPDATE account_lifecycle SET password_change_required=0
    WHERE user_id=NEW.user_id AND NEW.kind='change-password';
  DELETE FROM "session" WHERE "userId"=NEW.user_id;
  UPDATE account_ai_tokens SET revoked_at=NEW.created_at WHERE owner_user_id=NEW.user_id AND revoked_at IS NULL;
  UPDATE "account" SET password=NEW.password_hash, "updatedAt"=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE "userId"=NEW.user_id AND "providerId"='credential' AND NEW.kind IN ('reset-password','change-password');
  DELETE FROM "verification" WHERE NEW.kind='delete' AND instr(identifier,(SELECT email FROM "user" WHERE id=NEW.user_id))>0;
  DELETE FROM "account" WHERE "userId"=NEW.user_id AND NEW.kind='delete';
  UPDATE installations SET revoked_at=NEW.created_at, display_name='Deleted account' WHERE owner_user_id=NEW.user_id AND NEW.kind='delete';
  UPDATE "user" SET email='deleted-' || id || '@deleted.invalid', name='Deleted account', image=NULL, "emailVerified"=0,
    "updatedAt"=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.user_id AND NEW.kind='delete';
END;
CREATE TRIGGER account_lifecycle_session_guard BEFORE INSERT ON "session"
WHEN EXISTS (SELECT 1 FROM account_lifecycle WHERE user_id=NEW."userId" AND (disabled=1 OR deleted=1))
BEGIN SELECT RAISE(ABORT, 'account_disabled'); END;
