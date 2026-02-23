-- Reconciliation-first rollback
-- Note: SQLite cannot reliably drop added columns from existing tables in-place.
-- This rollback only removes new reconciliation tables and indexes.

DROP INDEX IF EXISTS idx_reconciliation_exceptions_status;
DROP INDEX IF EXISTS idx_reconciliation_exceptions_reason;
DROP INDEX IF EXISTS idx_payment_matches_decision;
DROP INDEX IF EXISTS idx_payment_matches_obligation;
DROP INDEX IF EXISTS idx_payment_transactions_source_checksum;
DROP INDEX IF EXISTS idx_payment_transactions_checksum;
DROP INDEX IF EXISTS idx_payment_transactions_date;
DROP INDEX IF EXISTS idx_payment_transactions_ref;
DROP INDEX IF EXISTS idx_payment_transactions_status;
DROP INDEX IF EXISTS idx_payment_obligations_reference;
DROP INDEX IF EXISTS idx_payment_obligations_status;
DROP INDEX IF EXISTS idx_payment_obligations_item;
DROP INDEX IF EXISTS idx_payment_obligations_student;

DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS reconciliation_events;
DROP TABLE IF EXISTS reconciliation_exceptions;
DROP TABLE IF EXISTS payment_matches;
DROP TABLE IF EXISTS payment_transactions;
DROP TABLE IF EXISTS payment_obligations;
