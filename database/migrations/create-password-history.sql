-- ES-207: password history. Only bcrypt hashes, newest 5 per user (pruned by the application). Safe to run more than once.
CREATE TABLE IF NOT EXISTS password_history (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL,
  password_hash varchar(255) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_history (user_id, id DESC);
