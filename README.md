# CampusPay Hub

CampusPay Hub is a role-based school portal for student communication, class resources, and payment tracking.

## Reconciliation-First Workflow

The payment system now runs on an exception-only reconciliation model:

1. Teachers create payment items.
2. System creates per-student payment obligations with deterministic references.
3. Transactions are ingested from statement imports and webhooks.
4. Matching engine auto-approves high-confidence matches.
5. Low-confidence or duplicate transactions go to an exception queue for teacher action.
6. Student receipt upload remains available as a fallback evidence path.

## Roles

- `student`: see payment items/obligations, submit fallback receipts, view ledger.
- `teacher`: upload statements, review exceptions, apply reconciliation actions.
- `admin`: all teacher capabilities + broader monitoring.

## Core APIs

### Payment Items + Obligations

- `GET /api/payment-items` (auth required)
  - for students, includes `my_reference`, `obligation_status`, `amount_paid_total`
- `POST /api/payment-items` (teacher/admin)
- `PUT /api/payment-items/:id` (teacher owner/admin)
- `DELETE /api/payment-items/:id` (teacher owner/admin)

### Student Receipt (Fallback)

- `POST /api/payment-receipts` (student, multipart)
  - `receiptFile` is optional fallback proof
  - submitted payload is also normalized into `payment_transactions`
- `GET /api/my/payment-receipts`
- `GET /api/payment-receipts/:id/file`

### Statement Import + Auto Reconcile

- `GET /api/teacher/payment-statement`
- `POST /api/teacher/payment-statement`
  - parses rows from CSV/XLSX/PDF/image/etc
  - validation keeps bad rows in `ingestion.unparsedRows`
  - supports `?dryRun=true` preview mode (no DB writes)
  - ingests normalized transactions
  - auto-reconciles and returns ingestion summary
- `DELETE /api/teacher/payment-statement`

### Gateway Webhook (Idempotent)

- `POST /api/payments/webhook`
  - uses `source_event_id` idempotency key
  - optional shared secret header via `GATEWAY_WEBHOOK_SECRET`

### Exception Queue + Actions

- `GET /api/teacher/reconciliation/summary`
- `GET /api/admin/reconciliation/summary`
- `GET /api/reconciliation/summary` (teacher/admin generic)
- `GET /api/teacher/reconciliation/exceptions`
- `GET /api/admin/reconciliation/exceptions`
- `GET /api/reconciliation/exceptions` (teacher/admin generic)
  - filters: `status`, `reason`, `student`, `paymentItemId`, `dateFrom`, `dateTo`, `page`, `pageSize`
  - default response is paginated: `{items, pagination}`
  - use `legacy=1` for array-only compatibility
- `POST /api/reconciliation/:id/approve`
- `POST /api/reconciliation/:id/reject`
- `POST /api/reconciliation/:id/request-student-confirmation`
- `POST /api/reconciliation/:id/merge-duplicates`
- `POST /api/reconciliation/bulk`

## Matching + Normalization

All ingested transactions normalize to:

`{ txn_ref, amount, date, payer_name, source, raw_payload }`

Matching uses:

- exact obligation reference (highest confidence)
- student/item hints
- amount similarity
- payer-name similarity
- date proximity

Duplicate checks run before candidate selection.

Threshold behavior:

- `>= AUTO_RECONCILE_CONFIDENCE`: auto-approve
- `REVIEW_RECONCILE_CONFIDENCE .. AUTO_RECONCILE_CONFIDENCE`: exception queue
- `< REVIEW_RECONCILE_CONFIDENCE`: unmatched/low-confidence exception

## OCR + AI Statement Parsing

- OCR provider:
  - `OCR_PROVIDER=none|ocrspace`
- AI parser fallback:
  - `STATEMENT_PARSER_PROVIDER=openai`

Supported statement formats:

- `CSV, TXT, TSV, JSON, XML, PDF, JPG, PNG, WEBP, XLS/XLSX, DOC/DOCX, RTF`

Parsing order:

1. structured table parse
2. OCR/text extraction (for PDF/image)
3. loose-text parse
4. AI parse fallback

## Database Additions (Reconciliation)

- `payment_obligations`
- `payment_transactions`
- `payment_matches`
- `reconciliation_exceptions`
- `reconciliation_events`
- `audit_events`

Legacy data migration is run in `initDatabase()`:

- existing `payment_receipts` are mapped into `payment_transactions`
- mapped transactions are synchronized into `payment_matches`/`reconciliation_exceptions`
- obligations are backfilled for existing payment items/students

SQL migration scripts:

- `migrations/20260223_reconciliation_first.up.sql`
- `migrations/20260223_reconciliation_first.down.sql`

## Audit/Event Logging

- `payment_receipt_events` for legacy receipt lifecycle
- `reconciliation_events` for transaction reconciliation actions
- `audit_logs` for actor-level accountability

## Environment Variables

See `.env.example`, including:

- `GATEWAY_WEBHOOK_SECRET`
- `PAYMENT_REFERENCE_PREFIX`
- `PAYMENT_REFERENCE_TENANT_ID`
- `AUTO_RECONCILE_CONFIDENCE`
- `REVIEW_RECONCILE_CONFIDENCE`

## Running Tests

```bash
npm test
```

## Rollout Plan (Short)

1. Deploy schema + migration release.
2. Enable statement ingestion first and monitor exception rates.
3. Enable gateway webhook ingestion with idempotency checks.
4. Move teachers fully to reconciliation exception queue.
5. Keep legacy receipt endpoints active during transition window.

## Backward Compatibility Notes

- Legacy receipt endpoints remain available.
- Existing receipt history is preserved and migrated into normalized transaction records.
- Student receipt upload is still supported as fallback proof, but reconciliation now prioritizes transaction ingestion.