# CampusPay Hub

CampusPay Hub is a role-based school portal for student communication, class resources, and payment tracking.

## Paystack-Only Workflow

The payment system runs in strict Paystack mode:

1. Lecturers create payment items.
2. System creates per-student payment obligations with deterministic references.
3. Students pay through Paystack checkout.
4. Paystack webhook/verification ingests transactions.
5. Matching engine auto-approves high-confidence matches.
6. Approved transactions auto-generate downloadable approved receipts.
7. Low-confidence or duplicate transactions are handled in reconciliation exception flows.

## Roles

- `student`: see payment items/obligations, pay with Paystack, view ledger, download approved receipts.
- `lecturer` (stored as `teacher` role value): manage payment items, verify delayed Paystack references, review reconciliation exceptions.
- `admin`: all lecturer capabilities + broader monitoring.

## Core APIs

### Payment Items + Obligations

- `GET /api/payment-items` (auth required)
  - for students, includes `my_reference`, `obligation_status`, `amount_paid_total`
- `POST /api/payment-items` (lecturer/admin)
- `PUT /api/payment-items/:id` (lecturer owner/admin)
- `DELETE /api/payment-items/:id` (lecturer owner/admin)

### Student Payment + Receipt APIs

- `GET /api/my/payment-ledger`
- `POST /api/payments/paystack/initialize`
- `GET /api/payments/paystack/callback`
- `GET /api/my/payment-receipts` (approved receipts only)
- `GET /api/payment-receipts/:id/file?variant=approved`

### Paystack Ingestion + Verification

- `POST /api/payments/webhook/paystack`
- `POST /api/payments/paystack/verify`
- `POST /api/payments/paystack/reference-requests` (student fallback for delayed webhook confirmation)
- `POST /api/payments/paystack/reference-requests/bulk-verify` (lecturer/admin)

### Exception Queue + Actions

- `GET /api/lecturer/reconciliation/summary`
- `GET /api/admin/reconciliation/summary`
- `GET /api/reconciliation/summary` (lecturer/admin generic)
- `GET /api/lecturer/reconciliation/exceptions`
- `GET /api/admin/reconciliation/exceptions`
- `GET /api/reconciliation/exceptions` (lecturer/admin generic)
  - filters: `status`, `reason`, `student`, `paymentItemId`, `dateFrom`, `dateTo`, `page`, `pageSize`
  - default response is paginated: `{items, pagination}`
  - use `legacy=1` for array-only compatibility
- `POST /api/reconciliation/:id/approve`
- `POST /api/reconciliation/:id/reject`
- `POST /api/reconciliation/:id/request-student-confirmation`
- `POST /api/reconciliation/:id/merge-duplicates`

### Deprecated APIs (`410 Gone`)

- `POST /api/payment-receipts`
- `GET|POST|DELETE /api/lecturer/payment-statement` (`/api/teacher/payment-statement` alias)
- `GET /api/lecturer/payment-receipts`
- `GET /api/admin/payment-receipts`
- `POST /api/payment-receipts/:id/assign`
- `POST /api/payment-receipts/:id/notes`
- `GET /api/payment-receipts/:id/notes`
- `POST /api/payment-receipts/bulk`
- `POST /api/payment-receipts/:id/verify`
- `POST /api/payment-receipts/:id/under-review`
- `POST /api/payment-receipts/:id/approve`
- `POST /api/payment-receipts/:id/reject`
- `POST /api/reconciliation/bulk`
- `POST /api/payments/webhook`

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

- `payment_receipt_events` for approved-receipt lifecycle/audit
- `reconciliation_events` for transaction reconciliation actions
- `audit_logs` for actor-level accountability

## Approved Student Receipt Generator

Automated workflow included in this repo:

1. Reads approved rows from `payment_receipts` (`status='approved'`).
2. Skips already-processed rows unless `--force`.
3. Fills HTML/CSS template placeholders.
4. Inserts profile picture (`user_profiles.profile_image_url`) into passport slot; falls back to a placeholder image if missing.
5. Creates image-based PDF (300 DPI) at:
   - `outputs/receipts/{application_id}_{yyyy-mm-dd}.pdf`
6. Marks the approved receipt as ready for in-app download.
7. Tracks generation state in `approved_receipt_dispatches`:
   - `receipt_generated_at`
   - `receipt_sent_at`
   - `receipt_file_path`
   - `receipt_sent`
8. Students download generated approved PDFs from:
   - `/api/payment-receipts/:id/file?variant=approved` (authorized owner/admin/lecturer)
9. Immediate trigger on approval:
   - reconciliation-approved transactions (including Paystack webhook/verify auto-approvals) auto-generate downloadable receipts
   - optional toggle: `RECEIPT_IMMEDIATE_ON_APPROVE=true|false`
   - response includes `approved_receipt_delivery` with readiness/failure summary

### Manual Command

```bash
npm run generate:approved-receipts
```

### One-Off With Limit

```bash
node scripts/generate-receipts.js --limit=50
```

### Scheduled Mode

```bash
node scripts/generate-receipts.js --schedule --interval-minutes=30
```

### Force Resend

```bash
node scripts/generate-receipts.js --force
```

### Template Files

- `templates/approved-student-receipt.html`
- `templates/approved-student-receipt.css`

### Sample Placeholder Map

```json
{
  "full_name": "Ada Lovelace",
  "application_id": "APP-0001",
  "program": "Computer Science",
  "amount_paid": "NGN 50,000.00",
  "receipt_no": "RCP-000001",
  "approval_date": "Feb 25, 2026",
  "passport_photo": "data:image/png;base64,..."
}
```

### Dependencies

- `nodemailer` (optional) if you use the standalone email sender workflow
- `puppeteer` for HTML-to-image rendering
- `pdf-lib` to package image into PDF
- Optional: set `RECEIPT_BROWSER_EXECUTABLE_PATH` if you want to use a system browser binary

If browser-based rendering is unavailable in production, the generator falls back to a minimal built-in PDF so receipts do not remain pending.

Install/update dependencies:

```bash
npm install
```

Runtime notes:

- Puppeteer downloads a Chromium binary during install; allow this in CI/build environments.
- If your host blocks bundled Chromium, set `RECEIPT_BROWSER_EXECUTABLE_PATH` to a system Chrome/Chromium path.

## Environment Variables

See `.env.example`, including:

- `PAYMENT_REFERENCE_PREFIX`
- `PAYMENT_REFERENCE_TENANT_ID`
- `AUTO_RECONCILE_CONFIDENCE`
- `REVIEW_RECONCILE_CONFIDENCE`
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_WEBHOOK_SECRET`
- `PAYSTACK_INTERNAL_VERIFY_SECRET`
- `RECEIPT_*` values for approved receipt generation/download
- `SMTP_*` values only if you run the standalone email sender workflow

## Running Tests

```bash
npm test
```

## Backward Compatibility Notes

- Legacy receipt endpoints are retained in schema for compatibility but deprecated at runtime (`410 Gone`).
- Existing receipt history is preserved and migrated into normalized transaction records.
- Legacy `/teacher` and `/api/teacher/*` routes still work as aliases for `/lecturer` and `/api/lecturer/*`.
