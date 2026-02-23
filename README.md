# CampusPay Hub

CampusPay Hub is a role-based school portal for student communication, class resources, and payment tracking.

## Payment Receipt Workflow (Phase 1)

This release adds a manual-first payment receipt verification flow.

### Roles

- `student`: submit receipts and view only own submissions.
- `teacher`: create/manage payment items, review receipts, approve/reject submissions.
- `admin`: all teacher capabilities + broader monitoring and queue access.

### Receipt Status Lifecycle

- `submitted` -> `under_review`
- `under_review` -> `approved`
- `under_review` -> `rejected`

Invalid transitions are rejected with `400`.

## Payment APIs

### Payment Item CRUD

- `GET /api/payment-items` (auth required)
- `POST /api/payment-items` (teacher/admin)
- `PUT /api/payment-items/:id` (teacher owner or admin)
- `DELETE /api/payment-items/:id` (teacher owner or admin)

Validation:
- title required, max 120
- expected amount > 0
- currency must be 3 uppercase letters
- due date optional, must be valid date if supplied

### Student Receipt Submission

- `POST /api/payment-receipts` (student only, multipart/form-data)
  - fields: `paymentItemId`, `amountPaid`, `paidAt`, `transactionRef`, `note` (optional), `receiptFile`
- `GET /api/my/payment-receipts` (student only)

Validation:
- payment item must exist
- amount paid must be positive
- paid date/time required and valid
- transaction reference required
- duplicate `transactionRef` rejected (`409`)

### Review Queue + Transitions

- `GET /api/teacher/payment-receipts` (teacher/admin)
- `GET /api/admin/payment-receipts` (admin)
- filters: `status`, `student`, `dateFrom`, `dateTo`, `paymentItemId`
- `POST /api/payment-receipts/:id/under-review`
- `POST /api/payment-receipts/:id/approve`
- `POST /api/payment-receipts/:id/reject` (requires `rejectionReason`)

### Secure Receipt File Access

- `GET /api/payment-receipts/:id/file`

Access allowed only for:
- owner student
- teacher/admin reviewers

Receipt files are stored privately and are not served from a public static directory.

## Verification Logic (Manual-First)

For each receipt, the system computes and stores verification flags in `verification_notes` JSON:

- `amount_matches_expected`: `abs(amount_paid - expected_amount) < 0.01`
- `paid_before_due`: `true/false` if due date exists, otherwise `null`
- `duplicate_reference`: defensive duplicate check against other receipts

These flags are shown in teacher/admin queue UI and support manual decision making.

## OCR + AI Statement Parsing

Receipt and statement extraction supports:

- OCR providers via `OCR_PROVIDER`:
  - `none` (default)
  - `ocrspace` (requires `OCR_SPACE_API_KEY`)
- AI-assisted statement row extraction via `STATEMENT_PARSER_PROVIDER=openai` (requires `OPENAI_API_KEY`)

Statement upload accepts CSV, TXT, TSV, JSON, XML, PDF, JPG, PNG, WEBP, XLS/XLSX, DOC/DOCX, and RTF.

Parsing order for statement uploads:
- Structured table parse (`normalizeStatementRowsText`)
- Loose-line parse (`parseStatementRowsFromLooseText`)
- AI fallback parse (`parseStatementRowsWithAi`)

## Audit + Event Logging

Every payment action writes:

1. `payment_receipt_events` (receipt lifecycle trail)
2. `audit_logs` (system-wide accountability log)

Logged actions include:
- receipt submit
- move under review
- approve
- reject
- payment item create/edit/delete

## Database Additions

- `payment_items`
- `payment_receipts`
- `payment_receipt_events`
- indexes on receipt lookup and event lookup

Migrations are handled via `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and column presence checks in `initDatabase()`.

## Running Tests

```bash
npm test
```

Current integration tests cover:
- valid submit flow
- invalid file type rejection
- duplicate transaction reference rejection
- file access authorization
- teacher queue access
- invalid transition rejection
- event + audit write checks
- payment item ownership enforcement

## Future Roadmap

- Integrate real OCR provider in `extractReceiptText`
- Add payment gateway webhook verification
- Add auto-reconciliation against provider transaction IDs
- Add richer reviewer dashboard analytics
