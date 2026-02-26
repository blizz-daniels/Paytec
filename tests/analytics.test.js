const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const testDataDir = path.join(__dirname, "tmp-analytics-data");
process.env.NODE_ENV = "test";
process.env.DATA_DIR = testDataDir;
process.env.RECEIPT_OUTPUT_DIR = path.join(testDataDir, "outputs", "receipts");
process.env.RECEIPT_IMMEDIATE_ON_APPROVE = "false";
process.env.SESSION_SECRET = "test-session-secret";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.STUDENT_ROSTER_PATH = path.join(testDataDir, "students.csv");
process.env.TEACHER_ROSTER_PATH = path.join(testDataDir, "teachers.csv");
process.env.PAYSTACK_SECRET_KEY = "sk_test_paystack_secret";
process.env.PAYSTACK_PUBLIC_KEY = "pk_test_paystack_public";
process.env.PAYSTACK_WEBHOOK_SECRET = "sk_test_paystack_secret";
process.env.PAYSTACK_CALLBACK_URL = "http://localhost:3000/api/payments/paystack/callback";

const { app, initDatabase, run, db } = require("../server");

const seeded = {
  itemAId: 0,
  itemBId: 0,
};

async function getCsrfToken(agent) {
  const response = await agent.get("/api/csrf-token");
  expect(response.status).toBe(200);
  expect(response.body.csrfToken).toBeTruthy();
  return response.body.csrfToken;
}

async function login(agent, username, password) {
  const csrfToken = await getCsrfToken(agent);
  const response = await agent
    .post("/login")
    .set("X-CSRF-Token", csrfToken)
    .type("form")
    .send({ username, password });
  expect(response.status).toBe(302);
}

beforeAll(async () => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });
  await initDatabase();

  await run("DELETE FROM payment_receipt_events");
  await run("DELETE FROM approved_receipt_dispatches");
  await run("DELETE FROM payment_receipts");
  await run("DELETE FROM reconciliation_exceptions");
  await run("DELETE FROM payment_matches");
  await run("DELETE FROM reconciliation_events");
  await run("DELETE FROM payment_transactions");
  await run("DELETE FROM paystack_sessions");
  await run("DELETE FROM paystack_reference_requests");
  await run("DELETE FROM payment_obligations");
  await run("DELETE FROM payment_items");
  await run("DELETE FROM notification_reads");
  await run("DELETE FROM notifications");
  await run("DELETE FROM audit_events");
  await run("DELETE FROM audit_logs");
  await run("DELETE FROM auth_roster");
  await run("DELETE FROM users WHERE role != 'admin'");

  const studentDoeHash = await bcrypt.hash("doe", 12);
  const studentRoeHash = await bcrypt.hash("roe", 12);
  const teacherOneHash = await bcrypt.hash("teach", 12);
  const teacherTwoHash = await bcrypt.hash("tutor", 12);
  await run(
    `
      INSERT INTO auth_roster (auth_id, role, password_hash, source_file)
      VALUES
        ('std_001', 'student', ?, 'tests'),
        ('std_002', 'student', ?, 'tests'),
        ('teach_001', 'teacher', ?, 'tests'),
        ('teach_002', 'teacher', ?, 'tests')
    `,
    [studentDoeHash, studentRoeHash, teacherOneHash, teacherTwoHash]
  );

  const itemA = await run(
    `
      INSERT INTO payment_items (
        title,
        description,
        expected_amount,
        currency,
        due_date,
        created_by,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ["Teacher One Tuition", "Teacher one item", 100, "NGN", "2026-02-10", "teach_001", "2026-02-01T09:00:00Z"]
  );
  const itemB = await run(
    `
      INSERT INTO payment_items (
        title,
        description,
        expected_amount,
        currency,
        due_date,
        created_by,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ["Teacher Two Lab", "Teacher two item", 200, "NGN", "2026-02-20", "teach_002", "2026-02-01T09:00:00Z"]
  );
  seeded.itemAId = Number(itemA.lastID || 0);
  seeded.itemBId = Number(itemB.lastID || 0);

  const obligationA1 = await run(
    `
      INSERT INTO payment_obligations (
        payment_item_id,
        student_username,
        expected_amount,
        due_date,
        payment_reference,
        status,
        amount_paid_total,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [seeded.itemAId, "std_001", 100, "2026-02-10", "REF-A-001", "paid", 100, "2026-02-01T09:30:00Z", "2026-02-18T10:00:00Z"]
  );
  const obligationA2 = await run(
    `
      INSERT INTO payment_obligations (
        payment_item_id,
        student_username,
        expected_amount,
        due_date,
        payment_reference,
        status,
        amount_paid_total,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [seeded.itemAId, "std_002", 120, "2026-02-15", "REF-A-002", "unpaid", 20, "2026-02-01T09:35:00Z", "2026-02-18T10:00:00Z"]
  );
  const obligationB1 = await run(
    `
      INSERT INTO payment_obligations (
        payment_item_id,
        student_username,
        expected_amount,
        due_date,
        payment_reference,
        status,
        amount_paid_total,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [seeded.itemBId, "std_001", 200, "2026-02-20", "REF-B-001", "paid", 200, "2026-02-01T09:40:00Z", "2026-02-19T10:00:00Z"]
  );

  const txA1 = await run(
    `
      INSERT INTO payment_transactions (
        txn_ref,
        amount,
        paid_at,
        payer_name,
        source,
        source_event_id,
        normalized_txn_ref,
        normalized_paid_date,
        normalized_payer_name,
        student_hint_username,
        payment_item_hint_id,
        checksum,
        raw_payload_json,
        status,
        matched_obligation_id,
        confidence,
        reasons_json,
        created_at,
        reviewed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      "PSTK-A-APPROVED-1",
      100,
      "2026-02-12T12:00:00Z",
      "std_001",
      "paystack",
      "evt-analytics-a-approved-1",
      "pstk-a-approved-1",
      "2026-02-12",
      "std_001",
      "std_001",
      seeded.itemAId,
      "checksum-a-approved-1",
      "{}",
      "approved",
      Number(obligationA1.lastID || 0),
      1,
      JSON.stringify(["exact_reference"]),
      "2026-02-12T12:00:01Z",
      "2026-02-12T12:01:00Z",
    ]
  );
  const txA2 = await run(
    `
      INSERT INTO payment_transactions (
        txn_ref,
        amount,
        paid_at,
        payer_name,
        source,
        source_event_id,
        normalized_txn_ref,
        normalized_paid_date,
        normalized_payer_name,
        student_hint_username,
        payment_item_hint_id,
        checksum,
        raw_payload_json,
        status,
        matched_obligation_id,
        confidence,
        reasons_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      "PSTK-A-REVIEW-1",
      20,
      "2026-02-13T11:00:00Z",
      "std_002",
      "paystack",
      "evt-analytics-a-review-1",
      "pstk-a-review-1",
      "2026-02-13",
      "std_002",
      "std_002",
      seeded.itemAId,
      "checksum-a-review-1",
      "{}",
      "needs_review",
      Number(obligationA2.lastID || 0),
      0.66,
      JSON.stringify(["amount_match"]),
      "2026-02-13T11:00:01Z",
    ]
  );
  await run(
    `
      INSERT INTO payment_transactions (
        txn_ref,
        amount,
        paid_at,
        payer_name,
        source,
        source_event_id,
        normalized_txn_ref,
        normalized_paid_date,
        normalized_payer_name,
        student_hint_username,
        payment_item_hint_id,
        checksum,
        raw_payload_json,
        status,
        matched_obligation_id,
        confidence,
        reasons_json,
        created_at,
        reviewed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      "PSTK-A-APPROVED-MANUAL",
      30,
      "2026-02-14T15:00:00Z",
      "std_002",
      "paystack",
      "evt-analytics-a-approved-manual",
      "pstk-a-approved-manual",
      "2026-02-14",
      "std_002",
      "std_002",
      seeded.itemAId,
      "checksum-a-approved-manual",
      "{}",
      "approved",
      Number(obligationA2.lastID || 0),
      0.9,
      JSON.stringify(["manual_approved"]),
      "2026-02-14T15:00:01Z",
      "2026-02-14T15:01:00Z",
    ]
  );
  await run(
    `
      INSERT INTO payment_transactions (
        txn_ref,
        amount,
        paid_at,
        payer_name,
        source,
        source_event_id,
        normalized_txn_ref,
        normalized_paid_date,
        normalized_payer_name,
        student_hint_username,
        payment_item_hint_id,
        checksum,
        raw_payload_json,
        status,
        matched_obligation_id,
        confidence,
        reasons_json,
        created_at,
        reviewed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      "PSTK-B-APPROVED-1",
      200,
      "2026-02-16T10:00:00Z",
      "std_001",
      "paystack",
      "evt-analytics-b-approved-1",
      "pstk-b-approved-1",
      "2026-02-16",
      "std_001",
      "std_001",
      seeded.itemBId,
      "checksum-b-approved-1",
      "{}",
      "approved",
      Number(obligationB1.lastID || 0),
      1,
      JSON.stringify(["exact_reference"]),
      "2026-02-16T10:00:01Z",
      "2026-02-16T10:01:00Z",
    ]
  );

  const matchA2 = await run(
    `
      INSERT INTO payment_matches (
        obligation_id,
        transaction_id,
        confidence,
        reasons_json,
        decision
      )
      VALUES (?, ?, ?, ?, ?)
    `,
    [Number(obligationA2.lastID || 0), Number(txA2.lastID || 0), 0.66, JSON.stringify(["amount_match"]), "pending"]
  );
  await run(
    `
      INSERT INTO reconciliation_exceptions (
        match_id,
        reason,
        status,
        assigned_to,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [Number(matchA2.lastID || 0), "amount_mismatch", "open", "teach_001", "2026-02-13T11:05:00Z", "2026-02-13T11:05:00Z"]
  );

  await run(
    `
      INSERT INTO paystack_sessions (
        obligation_id,
        student_id,
        gateway_reference,
        amount,
        status,
        init_payload_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [Number(obligationA1.lastID || 0), "std_001", "PSTK-SESSION-A1", 100, "approved", "{}", "2026-02-12T11:59:00Z", "2026-02-12T12:01:00Z"]
  );
  await run(
    `
      INSERT INTO paystack_sessions (
        obligation_id,
        student_id,
        gateway_reference,
        amount,
        status,
        init_payload_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [Number(obligationA2.lastID || 0), "std_002", "PSTK-SESSION-A2", 120, "pending_webhook", "{}", "2026-02-13T10:59:00Z", "2026-02-13T11:01:00Z"]
  );
  await run(
    `
      INSERT INTO paystack_sessions (
        obligation_id,
        student_id,
        gateway_reference,
        amount,
        status,
        init_payload_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [Number(obligationB1.lastID || 0), "std_001", "PSTK-SESSION-B1", 200, "failed", "{}", "2026-02-16T09:59:00Z", "2026-02-16T10:01:00Z"]
  );

  const receiptA1 = await run(
    `
      INSERT INTO payment_receipts (
        payment_item_id,
        student_username,
        amount_paid,
        paid_at,
        transaction_ref,
        receipt_file_path,
        status,
        submitted_at,
        reviewed_by,
        reviewed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    `,
    [seeded.itemAId, "std_001", 100, "2026-02-12T12:00:00Z", "RCPT-A-1", "receipt-a-1.pdf", "2026-02-12T12:00:30Z", "teach_001", "2026-02-12T12:01:00Z"]
  );
  const receiptA2 = await run(
    `
      INSERT INTO payment_receipts (
        payment_item_id,
        student_username,
        amount_paid,
        paid_at,
        transaction_ref,
        receipt_file_path,
        status,
        submitted_at,
        reviewed_by,
        reviewed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    `,
    [seeded.itemAId, "std_002", 30, "2026-02-14T15:00:00Z", "RCPT-A-2", "receipt-a-2.pdf", "2026-02-14T15:00:30Z", "teach_001", "2026-02-14T15:01:00Z"]
  );
  const receiptB1 = await run(
    `
      INSERT INTO payment_receipts (
        payment_item_id,
        student_username,
        amount_paid,
        paid_at,
        transaction_ref,
        receipt_file_path,
        status,
        submitted_at,
        reviewed_by,
        reviewed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    `,
    [seeded.itemBId, "std_001", 200, "2026-02-16T10:00:00Z", "RCPT-B-1", "receipt-b-1.pdf", "2026-02-16T10:00:30Z", "teach_002", "2026-02-16T10:01:00Z"]
  );

  await run(
    `
      INSERT INTO approved_receipt_dispatches (
        payment_receipt_id,
        student_username,
        receipt_generated_at,
        receipt_sent_at,
        receipt_file_path,
        receipt_sent,
        attempt_count,
        last_error,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      Number(receiptA1.lastID || 0),
      "std_001",
      "2026-02-12T12:02:00Z",
      "2026-02-12T12:02:30Z",
      path.join(testDataDir, "outputs", "receipts", "APP-A-1.pdf"),
      1,
      1,
      null,
      "2026-02-12T12:02:00Z",
      "2026-02-12T12:02:30Z",
    ]
  );
  await run(
    `
      INSERT INTO approved_receipt_dispatches (
        payment_receipt_id,
        student_username,
        receipt_generated_at,
        receipt_sent_at,
        receipt_file_path,
        receipt_sent,
        attempt_count,
        last_error,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      Number(receiptA2.lastID || 0),
      "std_002",
      "2026-02-14T15:02:00Z",
      null,
      "",
      0,
      1,
      "pending",
      "2026-02-14T15:02:00Z",
      "2026-02-14T15:02:00Z",
    ]
  );
  await run(
    `
      INSERT INTO approved_receipt_dispatches (
        payment_receipt_id,
        student_username,
        receipt_generated_at,
        receipt_sent_at,
        receipt_file_path,
        receipt_sent,
        attempt_count,
        last_error,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      Number(receiptB1.lastID || 0),
      "std_001",
      "2026-02-16T10:02:00Z",
      "2026-02-16T10:02:30Z",
      path.join(testDataDir, "outputs", "receipts", "APP-B-1.pdf"),
      1,
      1,
      null,
      "2026-02-16T10:02:00Z",
      "2026-02-16T10:02:30Z",
    ]
  );
});

afterAll(async () => {
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("authorization on analytics page and analytics APIs", async () => {
  const unauth = await request(app).get("/analytics");
  expect(unauth.status).toBe(401);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const studentPage = await student.get("/analytics");
  expect(studentPage.status).toBe(403);
  const studentApi = await student.get("/api/analytics/overview?from=2026-02-01&to=2026-02-28");
  expect(studentApi.status).toBe(403);
  const studentExport = await student.get("/api/analytics/export.csv?from=2026-02-01&to=2026-02-28");
  expect(studentExport.status).toBe(403);

  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const teacherPage = await teacher.get("/analytics");
  expect(teacherPage.status).toBe(200);
  expect(String(teacherPage.text || "")).toContain("Advanced Analytics and Visual Dashboards");

  const admin = request.agent(app);
  await login(admin, "admin", "admin-pass-123");
  const adminPage = await admin.get("/analytics");
  expect(adminPage.status).toBe(200);
});

test("teacher data scope differs from admin scope", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const teacherOverview = await teacher.get("/api/analytics/overview?from=2026-02-01&to=2026-02-28");
  expect(teacherOverview.status).toBe(200);
  expect(Number(teacherOverview.body?.kpis?.totalCollected || 0)).toBeCloseTo(130, 5);

  const teacherTopItems = await teacher.get("/api/analytics/top-items?from=2026-02-01&to=2026-02-28&limit=20");
  expect(teacherTopItems.status).toBe(200);
  expect(Array.isArray(teacherTopItems.body.items)).toBe(true);
  expect(teacherTopItems.body.items.length).toBeGreaterThan(0);
  expect(teacherTopItems.body.items.every((row) => Number(row.paymentItemId) === seeded.itemAId)).toBe(true);

  const teacherForbiddenFilter = await teacher.get(
    `/api/analytics/overview?from=2026-02-01&to=2026-02-28&paymentItemId=${seeded.itemBId}`
  );
  expect(teacherForbiddenFilter.status).toBe(400);

  const admin = request.agent(app);
  await login(admin, "admin", "admin-pass-123");
  const adminOverview = await admin.get("/api/analytics/overview?from=2026-02-01&to=2026-02-28");
  expect(adminOverview.status).toBe(200);
  expect(Number(adminOverview.body?.kpis?.totalCollected || 0)).toBeCloseTo(330, 5);

  const adminTopItems = await admin.get("/api/analytics/top-items?from=2026-02-01&to=2026-02-28&limit=20");
  expect(adminTopItems.status).toBe(200);
  const itemIds = new Set((adminTopItems.body.items || []).map((row) => Number(row.paymentItemId || 0)));
  expect(itemIds.has(seeded.itemAId)).toBe(true);
  expect(itemIds.has(seeded.itemBId)).toBe(true);
});

test("analytics filter validation errors return 400", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");

  const invalidDate = await teacher.get("/api/analytics/overview?from=bad-date&to=2026-02-28");
  expect(invalidDate.status).toBe(400);
  expect(invalidDate.body.error).toMatch(/from/i);

  const invalidGranularity = await teacher.get(
    "/api/analytics/revenue-series?from=2026-02-01&to=2026-02-28&granularity=quarter"
  );
  expect(invalidGranularity.status).toBe(400);
  expect(invalidGranularity.body.error).toMatch(/granularity/i);

  const invalidLimit = await teacher.get("/api/analytics/top-items?from=2026-02-01&to=2026-02-28&limit=1000");
  expect(invalidLimit.status).toBe(400);
  expect(invalidLimit.body.error).toMatch(/limit/i);
});

test("analytics endpoint response shapes", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const baseQuery = "from=2026-02-01&to=2026-02-28&granularity=day";

  const overview = await teacher.get(`/api/analytics/overview?${baseQuery}`);
  expect(overview.status).toBe(200);
  expect(overview.body).toHaveProperty("filters");
  expect(overview.body).toHaveProperty("kpis");

  const revenue = await teacher.get(`/api/analytics/revenue-series?${baseQuery}`);
  expect(revenue.status).toBe(200);
  expect(Array.isArray(revenue.body.series)).toBe(true);

  const breakdown = await teacher.get(`/api/analytics/status-breakdown?${baseQuery}`);
  expect(breakdown.status).toBe(200);
  expect(Array.isArray(breakdown.body.breakdown)).toBe(true);

  const reconciliation = await teacher.get(`/api/analytics/reconciliation-funnel?${baseQuery}`);
  expect(reconciliation.status).toBe(200);
  expect(Array.isArray(reconciliation.body.stages)).toBe(true);

  const topItems = await teacher.get(`/api/analytics/top-items?${baseQuery}&limit=10&sort=collected_desc`);
  expect(topItems.status).toBe(200);
  expect(Array.isArray(topItems.body.items)).toBe(true);

  const paystack = await teacher.get(`/api/analytics/paystack-funnel?${baseQuery}`);
  expect(paystack.status).toBe(200);
  expect(Array.isArray(paystack.body.stages)).toBe(true);

  const aging = await teacher.get(`/api/analytics/aging?${baseQuery}`);
  expect(aging.status).toBe(200);
  expect(Array.isArray(aging.body.buckets)).toBe(true);
});

test("analytics CSV export returns text/csv and payload", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const response = await teacher.get("/api/analytics/export.csv?from=2026-02-01&to=2026-02-28&granularity=day");
  expect(response.status).toBe(200);
  expect(String(response.headers["content-type"] || "")).toContain("text/csv");
  expect(String(response.text || "").length).toBeGreaterThan(100);
  expect(String(response.text || "")).toContain("Overview");
});
