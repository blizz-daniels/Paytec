-- Paystack integration rollback
DROP INDEX IF EXISTS idx_paystack_sessions_reference;
DROP INDEX IF EXISTS idx_paystack_sessions_status;
DROP INDEX IF EXISTS idx_paystack_sessions_student;
DROP INDEX IF EXISTS idx_paystack_sessions_obligation;
DROP TABLE IF EXISTS paystack_sessions;
