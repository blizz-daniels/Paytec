CREATE TABLE IF NOT EXISTS approved_receipt_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_receipt_id INTEGER NOT NULL UNIQUE,
  student_username TEXT NOT NULL,
  receipt_generated_at TEXT,
  receipt_sent_at TEXT,
  receipt_file_path TEXT,
  receipt_sent INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_receipt_id) REFERENCES payment_receipts(id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_approved_receipt_dispatches_sent ON approved_receipt_dispatches(receipt_sent);
CREATE INDEX IF NOT EXISTS idx_approved_receipt_dispatches_receipt ON approved_receipt_dispatches(payment_receipt_id);
