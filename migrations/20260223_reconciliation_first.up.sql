-- Reconciliation-first migration (non-destructive)
-- Preserves legacy payment_receipts and related tables.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS payment_obligations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_item_id INTEGER NOT NULL,
  student_username TEXT NOT NULL,
  expected_amount REAL NOT NULL,
  due_date TEXT,
  payment_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid',
  amount_paid_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(payment_item_id, student_username),
  UNIQUE(payment_reference),
  FOREIGN KEY (payment_item_id) REFERENCES payment_items(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_ref TEXT,
  amount REAL NOT NULL,
  paid_at TEXT NOT NULL,
  payer_name TEXT,
  source TEXT NOT NULL,
  source_event_id TEXT UNIQUE,
  source_file_name TEXT,
  normalized_txn_ref TEXT,
  normalized_paid_date TEXT,
  normalized_payer_name TEXT,
  student_hint_username TEXT,
  payment_item_hint_id INTEGER,
  checksum TEXT,
  raw_payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unmatched',
  matched_obligation_id INTEGER,
  confidence REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (matched_obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (payment_item_hint_id) REFERENCES payment_items(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payment_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  obligation_id INTEGER,
  transaction_id INTEGER NOT NULL UNIQUE,
  confidence REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (match_id) REFERENCES payment_matches(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reconciliation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER,
  obligation_id INTEGER,
  actor_username TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id) ON UPDATE CASCADE ON DELETE SET NULL,
  FOREIGN KEY (obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_role TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_obligations_student ON payment_obligations(student_username);
CREATE INDEX IF NOT EXISTS idx_payment_obligations_item ON payment_obligations(payment_item_id);
CREATE INDEX IF NOT EXISTS idx_payment_obligations_status ON payment_obligations(status);
CREATE INDEX IF NOT EXISTS idx_payment_obligations_reference ON payment_obligations(payment_reference);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_ref ON payment_transactions(normalized_txn_ref);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_date ON payment_transactions(normalized_paid_date);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_amount ON payment_transactions(amount);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_checksum ON payment_transactions(checksum);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transactions_source_checksum ON payment_transactions(source, checksum);

CREATE INDEX IF NOT EXISTS idx_payment_matches_obligation ON payment_matches(obligation_id);
CREATE INDEX IF NOT EXISTS idx_payment_matches_decision ON payment_matches(decision);
CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_reason ON reconciliation_exceptions(reason);
CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_status ON reconciliation_exceptions(status);