-- Paystack integration migration (non-destructive)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS paystack_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  obligation_id INTEGER NOT NULL,
  student_id TEXT NOT NULL,
  gateway_reference TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiated',
  init_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_paystack_sessions_obligation ON paystack_sessions(obligation_id);
CREATE INDEX IF NOT EXISTS idx_paystack_sessions_student ON paystack_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_paystack_sessions_status ON paystack_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paystack_sessions_reference ON paystack_sessions(gateway_reference);
