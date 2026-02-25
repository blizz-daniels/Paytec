const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const XLSX = require("xlsx");

const testDataDir = path.join(__dirname, "tmp-data");
process.env.NODE_ENV = "test";
process.env.DATA_DIR = testDataDir;
process.env.RECEIPT_OUTPUT_DIR = path.join(testDataDir, "outputs", "receipts");
process.env.SESSION_SECRET = "test-session-secret";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.STUDENT_ROSTER_PATH = path.join(testDataDir, "students.csv");
process.env.TEACHER_ROSTER_PATH = path.join(testDataDir, "teachers.csv");
process.env.PAYSTACK_SECRET_KEY = "sk_test_paystack_secret";
process.env.PAYSTACK_PUBLIC_KEY = "pk_test_paystack_public";
process.env.PAYSTACK_WEBHOOK_SECRET = "sk_test_paystack_secret";
process.env.PAYSTACK_CALLBACK_URL = "http://localhost:3000/api/payments/paystack/callback";

const { app, initDatabase, run, get, all, db } = require("../server");

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

async function postJson(agent, url, payload) {
  const csrfToken = await getCsrfToken(agent);
  return agent.post(url).set("X-CSRF-Token", csrfToken).send(payload);
}

async function putJson(agent, url, payload) {
  const csrfToken = await getCsrfToken(agent);
  return agent.put(url).set("X-CSRF-Token", csrfToken).send(payload);
}

async function deleteWithCsrf(agent, url) {
  const csrfToken = await getCsrfToken(agent);
  return agent.delete(url).set("X-CSRF-Token", csrfToken);
}

function signPaystackPayload(payload, secret = process.env.PAYSTACK_WEBHOOK_SECRET) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  return { rawBody, signature };
}

beforeAll(async () => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });
  await initDatabase();

  await run("DELETE FROM payment_receipt_events");
  await run("DELETE FROM payment_receipts");
  await run("DELETE FROM reconciliation_exceptions");
  await run("DELETE FROM payment_matches");
  await run("DELETE FROM reconciliation_events");
  await run("DELETE FROM payment_transactions");
  await run("DELETE FROM paystack_sessions");
  await run("DELETE FROM payment_obligations");
  await run("DELETE FROM payment_items");
  await run("DELETE FROM teacher_payment_statements");
  await run("DELETE FROM notification_reads");
  await run("DELETE FROM notifications");
  await run("DELETE FROM audit_events");
  await run("DELETE FROM audit_logs");
  await run("DELETE FROM auth_roster");
  await run("DELETE FROM users WHERE role != 'admin'");

  const surnameHashDoe = await bcrypt.hash("doe", 12);
  const surnameHashRoe = await bcrypt.hash("roe", 12);
  const surnameHashTeach = await bcrypt.hash("teach", 12);
  const surnameHashTutor = await bcrypt.hash("tutor", 12);
  await run(
    `
      INSERT INTO auth_roster (auth_id, role, password_hash, source_file)
      VALUES
      ('std_001', 'student', ?, 'tests'),
      ('std_002', 'student', ?, 'tests'),
      ('teach_001', 'teacher', ?, 'tests'),
      ('teach_002', 'teacher', ?, 'tests')
    `,
    [surnameHashDoe, surnameHashRoe, surnameHashTeach, surnameHashTutor]
  );

  await run(
    `
      INSERT INTO user_profiles (username, display_name, email, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        email = excluded.email,
        updated_at = CURRENT_TIMESTAMP
    `,
    ["std_001", "Std 001", "std_001@example.com"]
  );
  await run(
    `
      INSERT INTO user_profiles (username, display_name, email, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        email = excluded.email,
        updated_at = CURRENT_TIMESTAMP
    `,
    ["std_002", "Std 002", "std_002@example.com"]
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("student can submit valid receipt", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const itemResponse = await postJson(teacher, "/api/payment-items", {
    title: "Tuition - Term 1",
    description: "Core tuition",
    expectedAmount: 50000,
    currency: "NGN",
    dueDate: "2026-03-01",
  });
  expect(itemResponse.status).toBe(201);
  const paymentItemId = itemResponse.body.id;

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const csrfToken = await getCsrfToken(student);
  const submitResponse = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", csrfToken)
    .field("paymentItemId", String(paymentItemId))
    .field("amountPaid", "50000")
    .field("paidAt", "2026-02-20T10:00:00")
    .field("transactionRef", "TX-VALID-001")
    .field("note", "Paid via bank app")
    .attach("receiptFile", Buffer.from("fake-image-data"), {
      filename: "receipt.png",
      contentType: "image/png",
    });
  expect(submitResponse.status).toBe(201);

  const myReceipts = await student.get("/api/my/payment-receipts");
  expect(myReceipts.status).toBe(200);
  expect(Array.isArray(myReceipts.body)).toBe(true);
  expect(myReceipts.body.length).toBeGreaterThan(0);
});

test("student can download generated approved receipt PDF", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const itemResponse = await postJson(teacher, "/api/payment-items", {
    title: "Acceptance Fee",
    description: "Approved receipt download test",
    expectedAmount: 15000,
    currency: "NGN",
    dueDate: "2026-03-01",
  });
  expect(itemResponse.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const csrfToken = await getCsrfToken(student);
  const submitResponse = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", csrfToken)
    .field("paymentItemId", String(itemResponse.body.id))
    .field("amountPaid", "15000")
    .field("paidAt", "2026-02-20T10:00:00")
    .field("transactionRef", "TX-APPROVED-PDF-001")
    .attach("receiptFile", Buffer.from("fake-image-data"), {
      filename: "receipt.png",
      contentType: "image/png",
    });
  expect(submitResponse.status).toBe(201);
  const receiptId = Number(submitResponse.body.id || 0);
  expect(receiptId).toBeGreaterThan(0);

  const approveResponse = await postJson(teacher, `/api/payment-receipts/${receiptId}/approve`, {});
  expect(approveResponse.status).toBe(200);

  const outputDir = process.env.RECEIPT_OUTPUT_DIR;
  const approvedPdfPath = path.join(outputDir, `APPROVED-${receiptId}.pdf`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(approvedPdfPath, Buffer.from("%PDF-1.4\n%approved\n"));

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
        last_error
      )
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, 1, 1, NULL)
      ON CONFLICT(payment_receipt_id) DO UPDATE SET
        receipt_file_path = excluded.receipt_file_path,
        receipt_sent = excluded.receipt_sent,
        receipt_generated_at = excluded.receipt_generated_at,
        receipt_sent_at = excluded.receipt_sent_at,
        attempt_count = excluded.attempt_count,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    `,
    [receiptId, "std_001", approvedPdfPath]
  );

  const myReceipts = await student.get("/api/my/payment-receipts");
  expect(myReceipts.status).toBe(200);
  const matchingReceipt = myReceipts.body.find((row) => Number(row.id) === receiptId);
  expect(matchingReceipt).toBeTruthy();
  expect(Number(matchingReceipt.approved_receipt_available || 0)).toBe(1);

  const downloadResponse = await student.get(`/api/payment-receipts/${receiptId}/file?variant=approved`);
  expect(downloadResponse.status).toBe(200);
  expect(String(downloadResponse.headers["content-type"] || "")).toContain("application/pdf");
  const payloadSize = Buffer.isBuffer(downloadResponse.body)
    ? downloadResponse.body.length
    : Buffer.byteLength(String(downloadResponse.text || ""), "utf8");
  expect(payloadSize).toBeGreaterThan(0);

  const invalidVariant = await student.get(`/api/payment-receipts/${receiptId}/file?variant=unknown`);
  expect(invalidVariant.status).toBe(400);
});

test("invalid file type is rejected", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const itemResponse = await postJson(teacher, "/api/payment-items", {
    title: "Lab Fee",
    description: "Lab payment",
    expectedAmount: 10000,
    currency: "NGN",
    dueDate: "",
  });
  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const csrfToken = await getCsrfToken(student);
  const response = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", csrfToken)
    .field("paymentItemId", String(itemResponse.body.id))
    .field("amountPaid", "10000")
    .field("paidAt", "2026-02-20T10:00:00")
    .field("transactionRef", "TX-INVALID-TYPE")
    .attach("receiptFile", Buffer.from("not-an-image"), {
      filename: "receipt.txt",
      contentType: "text/plain",
    });
  expect(response.status).toBe(400);
});

test("duplicate transaction reference is rejected", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const itemResponse = await postJson(teacher, "/api/payment-items", {
    title: "Field Trip",
    description: "Trip fee",
    expectedAmount: 20000,
    currency: "NGN",
    dueDate: "",
  });
  const student = request.agent(app);
  await login(student, "std_001", "doe");

  const csrf1 = await getCsrfToken(student);
  const first = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", csrf1)
    .field("paymentItemId", String(itemResponse.body.id))
    .field("amountPaid", "20000")
    .field("paidAt", "2026-02-20T10:00:00")
    .field("transactionRef", "TX-DUP-001")
    .attach("receiptFile", Buffer.from("img1"), { filename: "one.png", contentType: "image/png" });
  expect(first.status).toBe(201);

  const csrf2 = await getCsrfToken(student);
  const second = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", csrf2)
    .field("paymentItemId", String(itemResponse.body.id))
    .field("amountPaid", "20000")
    .field("paidAt", "2026-02-20T11:00:00")
    .field("transactionRef", "TX-DUP-001")
    .attach("receiptFile", Buffer.from("img2"), { filename: "two.png", contentType: "image/png" });
  expect(second.status).toBe(409);
});

test("student cannot access another student's receipt file", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const itemResponse = await postJson(teacher, "/api/payment-items", {
    title: "Exam Fee",
    description: "Exam registration",
    expectedAmount: 15000,
    currency: "NGN",
    dueDate: "",
  });

  const studentA = request.agent(app);
  await login(studentA, "std_001", "doe");
  const csrfA = await getCsrfToken(studentA);
  const submit = await studentA
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", csrfA)
    .field("paymentItemId", String(itemResponse.body.id))
    .field("amountPaid", "15000")
    .field("paidAt", "2026-02-20T10:00:00")
    .field("transactionRef", "TX-FILE-001")
    .attach("receiptFile", Buffer.from("img"), { filename: "file.png", contentType: "image/png" });
  expect(submit.status).toBe(201);
  const receiptId = submit.body.id;

  const studentB = request.agent(app);
  await login(studentB, "std_002", "roe");
  const fileResponse = await studentB.get(`/api/payment-receipts/${receiptId}/file`);
  expect(fileResponse.status).toBe(403);
});

test("teacher can list queue", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const response = await teacher.get("/api/teacher/payment-receipts");
  expect(response.status).toBe(200);
  expect(Array.isArray(response.body)).toBe(true);
});

test("invalid transition is rejected", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const queue = await teacher.get("/api/teacher/payment-receipts?status=submitted");
  const submittedReceipt = (queue.body || []).find((row) => row.status === "submitted");
  expect(submittedReceipt).toBeTruthy();
  const response = await postJson(teacher, `/api/payment-receipts/${submittedReceipt.id}/approve`, {});
  expect(response.status).toBe(400);
});

test("approve/reject writes events and audit logs", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const queue = await teacher.get("/api/teacher/payment-receipts?status=submitted");
  const firstSubmitted = (queue.body || []).find((row) => row.status === "submitted");
  expect(firstSubmitted).toBeTruthy();

  const underReview = await postJson(teacher, `/api/payment-receipts/${firstSubmitted.id}/under-review`, {});
  expect(underReview.status).toBe(200);
  const approve = await postJson(teacher, `/api/payment-receipts/${firstSubmitted.id}/approve`, {});
  expect(approve.status).toBe(200);

  const itemResponse = await postJson(teacher, "/api/payment-items", {
    title: "Sports Fee",
    description: "Sports activities",
    expectedAmount: 18000,
    currency: "NGN",
    dueDate: "",
  });
  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const csrf = await getCsrfToken(student);
  const submit = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", csrf)
    .field("paymentItemId", String(itemResponse.body.id))
    .field("amountPaid", "17000")
    .field("paidAt", "2026-02-20T12:00:00")
    .field("transactionRef", "TX-REJECT-001")
    .attach("receiptFile", Buffer.from("img"), { filename: "rej.png", contentType: "image/png" });
  expect(submit.status).toBe(201);

  const move = await postJson(teacher, `/api/payment-receipts/${submit.body.id}/under-review`, {});
  expect(move.status).toBe(200);
  const reject = await postJson(teacher, `/api/payment-receipts/${submit.body.id}/reject`, {
    rejectionReason: "Amount does not match expected payment.",
  });
  expect(reject.status).toBe(200);

  const eventRows = await all("SELECT action FROM payment_receipt_events WHERE receipt_id = ? ORDER BY id ASC", [
    submit.body.id,
  ]);
  const actions = eventRows.map((row) => row.action);
  expect(actions).toEqual(expect.arrayContaining(["submit", "move_under_review", "reject"]));

  const auditRows = await all(
    "SELECT action, content_type FROM audit_logs WHERE content_type = 'payment_receipt' AND content_id = ?",
    [submit.body.id]
  );
  expect(auditRows.length).toBeGreaterThan(0);
});

test("payment item ownership is enforced (teacher vs admin)", async () => {
  const teacherOne = request.agent(app);
  await login(teacherOne, "teach_001", "teach");
  const create = await postJson(teacherOne, "/api/payment-items", {
    title: "Ownership Fee",
    description: "Owner test",
    expectedAmount: 1000,
    currency: "NGN",
    dueDate: "",
  });
  expect(create.status).toBe(201);
  const itemId = create.body.id;

  const teacherTwo = request.agent(app);
  await login(teacherTwo, "teach_002", "tutor");
  const forbiddenEdit = await putJson(teacherTwo, `/api/payment-items/${itemId}`, {
    title: "Ownership Fee Updated",
    description: "Owner test",
    expectedAmount: 1200,
    currency: "NGN",
    dueDate: "",
  });
  expect(forbiddenEdit.status).toBe(403);
  const forbiddenDelete = await deleteWithCsrf(teacherTwo, `/api/payment-items/${itemId}`);
  expect(forbiddenDelete.status).toBe(403);

  const admin = request.agent(app);
  await login(admin, "admin", "admin-pass-123");
  const adminEdit = await putJson(admin, `/api/payment-items/${itemId}`, {
    title: "Admin Updated Item",
    description: "Admin changed",
    expectedAmount: 1300,
    currency: "NGN",
    dueDate: "",
  });
  expect(adminEdit.status).toBe(200);
});

test("teacher statement upload + verify can auto-approve matching receipt", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Auto Verify Fee",
    description: "Auto verification test",
    expectedAmount: 22000,
    currency: "NGN",
    dueDate: "2026-04-01",
    availabilityDays: 30,
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const studentCsrf = await getCsrfToken(student);
  const submit = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", studentCsrf)
    .field("paymentItemId", String(createItem.body.id))
    .field("amountPaid", "22000")
    .field("paidAt", "2026-02-20T10:00:00")
    .field("transactionRef", "TX-AUTO-VERIFY-001")
    .attach("receiptFile", Buffer.from("img"), { filename: "auto.png", contentType: "image/png" });
  expect(submit.status).toBe(201);

  const teacherCsrf = await getCsrfToken(teacher);
  const statementCsv = ["name,amount,date,reference", "std_001,22000,2026-02-20,TX-AUTO-VERIFY-001"].join("\n");
  const upload = await teacher
    .post("/api/teacher/payment-statement")
    .set("X-CSRF-Token", teacherCsrf)
    .attach("statementFile", Buffer.from(statementCsv), { filename: "statement.csv", contentType: "text/csv" });
  expect(upload.status).toBe(201);

  const statementInfo = await teacher.get("/api/teacher/payment-statement");
  expect(statementInfo.status).toBe(200);
  expect(statementInfo.body.hasStatement).toBe(true);
  expect(Number(statementInfo.body.parsed_row_count)).toBeGreaterThan(0);

  const verify = await postJson(teacher, `/api/payment-receipts/${submit.body.id}/verify`, {});
  expect(verify.status).toBe(200);
  expect(verify.body.matched).toBe(true);
  expect(verify.body.receipt.status).toBe("approved");
});

test("teacher statement upload accepts extended formats for verification parsing", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "XML Verify Fee",
    description: "Extended format test",
    expectedAmount: 18000,
    currency: "NGN",
    dueDate: "2026-05-01",
    availabilityDays: 30,
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const studentCsrf = await getCsrfToken(student);
  const submit = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", studentCsrf)
    .field("paymentItemId", String(createItem.body.id))
    .field("amountPaid", "18000")
    .field("paidAt", "2026-02-21T10:00:00")
    .field("transactionRef", "TX-XML-VERIFY-001")
    .attach("receiptFile", Buffer.from("img"), { filename: "auto-xml.png", contentType: "image/png" });
  expect(submit.status).toBe(201);

  const teacherCsrf = await getCsrfToken(teacher);
  const statementXmlLikeLine = "std_001 amount 18000 date 2026-02-21 ref TX-XML-VERIFY-001";
  const upload = await teacher
    .post("/api/teacher/payment-statement")
    .set("X-CSRF-Token", teacherCsrf)
    .attach("statementFile", Buffer.from(statementXmlLikeLine), {
      filename: "statement.xml",
      contentType: "application/xml",
    });
  expect(upload.status).toBe(201);
  expect(Number(upload.body.parsed_row_count || 0)).toBeGreaterThan(0);
  expect(upload.body.ingestion).toBeTruthy();
  expect(Number(upload.body.ingestion.totalRows || 0)).toBeGreaterThan(0);

  const verify = await postJson(teacher, `/api/payment-receipts/${submit.body.id}/verify`, {});
  expect(verify.status).toBe(200);
  expect(verify.body.matched).toBe(true);
  expect(verify.body.receipt.status).toBe("approved");
});

test("teacher statement upload parses real xlsx files for verification", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "XLSX Verify Fee",
    description: "Excel parsing test",
    expectedAmount: 26000,
    currency: "NGN",
    dueDate: "2026-06-01",
    availabilityDays: 30,
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const studentCsrf = await getCsrfToken(student);
  const submit = await student
    .post("/api/payment-receipts")
    .set("X-CSRF-Token", studentCsrf)
    .field("paymentItemId", String(createItem.body.id))
    .field("amountPaid", "26000")
    .field("paidAt", "2026-02-22T10:00:00")
    .field("transactionRef", "TX-XLSX-VERIFY-001")
    .attach("receiptFile", Buffer.from("img"), { filename: "auto-xlsx.png", contentType: "image/png" });
  expect(submit.status).toBe(201);

  const worksheet = XLSX.utils.aoa_to_sheet([
    ["name", "amount", "date", "reference"],
    ["std_001", "26000", "2026-02-22", "TX-XLSX-VERIFY-001"],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Statement");
  const statementBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });

  const teacherCsrf = await getCsrfToken(teacher);
  const upload = await teacher
    .post("/api/teacher/payment-statement")
    .set("X-CSRF-Token", teacherCsrf)
    .attach("statementFile", statementBuffer, {
      filename: "statement.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  expect(upload.status).toBe(201);
  expect(Number(upload.body.parsed_row_count || 0)).toBeGreaterThan(0);

  const verify = await postJson(teacher, `/api/payment-receipts/${submit.body.id}/verify`, {});
  expect(verify.status).toBe(200);
  expect(verify.body.matched).toBe(true);
  expect(verify.body.receipt.status).toBe("approved");
});

test("paystack initialize validates ownership and amount constraints", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Paystack Init Fee",
    description: "Initialize checks",
    expectedAmount: 33000,
    currency: "NGN",
    dueDate: "2026-07-15",
    availabilityDays: 30,
  });
  expect(createItem.status).toBe(201);

  const studentA = request.agent(app);
  await login(studentA, "std_001", "doe");
  const studentALedger = await studentA.get("/api/my/payment-ledger");
  expect(studentALedger.status).toBe(200);
  const obligation = (studentALedger.body?.items || []).find((row) => Number(row.id) === Number(createItem.body.id));
  expect(obligation).toBeTruthy();
  expect(Number(obligation.obligation_id || 0)).toBeGreaterThan(0);

  const studentB = request.agent(app);
  await login(studentB, "std_002", "roe");
  const forbidden = await postJson(studentB, "/api/payments/paystack/initialize", {
    obligationId: obligation.obligation_id,
    amount: 1000,
  });
  expect(forbidden.status).toBe(403);
  expect(forbidden.body.code).toBe("paystack_initialize_forbidden");

  const tooHigh = await postJson(studentA, "/api/payments/paystack/initialize", {
    obligationId: obligation.obligation_id,
    amount: 999999,
  });
  expect(tooHigh.status).toBe(400);
  expect(tooHigh.body.code).toBe("paystack_initialize_amount_exceeds_outstanding");

  const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        status: true,
        message: "Authorization URL created",
        data: {
          authorization_url: "https://checkout.paystack.com/mock-session-001",
          access_code: "mock-access-code-001",
          reference: "PSTK-MOCK-REF-001",
        },
      }),
  });
  const valid = await postJson(studentA, "/api/payments/paystack/initialize", {
    obligationId: obligation.obligation_id,
    amount: 15000,
  });
  expect(valid.status).toBe(200);
  expect(valid.body.authorization_url).toContain("paystack.com");
  expect(valid.body.access_code).toBeTruthy();
  expect(valid.body.reference).toBeTruthy();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const requestBody = JSON.parse(String(fetchSpy.mock.calls?.[0]?.[1]?.body || "{}"));
  expect(requestBody.email).toBe("std_001@example.com");

  const sessionRow = await get("SELECT status, amount FROM paystack_sessions WHERE gateway_reference = ? LIMIT 1", [
    valid.body.reference,
  ]);
  expect(sessionRow).toBeTruthy();
  expect(sessionRow.status).toBe("initiated");
  expect(Number(sessionRow.amount || 0)).toBeCloseTo(15000, 2);
});

test("paystack initialize rejects when profile email is missing and username is not an email", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Paystack Email Required",
    description: "Requires real customer email",
    expectedAmount: 14000,
    currency: "NGN",
    dueDate: "2026-07-20",
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_002", "roe");
  const ledger = await student.get("/api/my/payment-ledger");
  expect(ledger.status).toBe(200);
  const row = (ledger.body?.items || []).find((entry) => Number(entry.id) === Number(createItem.body.id));
  expect(row).toBeTruthy();

  await run("UPDATE user_profiles SET email = NULL WHERE username = ?", ["std_002"]);
  const fetchSpy = jest.spyOn(global, "fetch");

  const init = await postJson(student, "/api/payments/paystack/initialize", {
    obligationId: row.obligation_id,
    amount: 1000,
  });
  expect(init.status).toBe(400);
  expect(init.body.code).toBe("paystack_initialize_email_required");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("paystack callback redirects safely and does not auto-approve without webhook", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Paystack Callback Fee",
    description: "Callback should stay pending",
    expectedAmount: 12500,
    currency: "NGN",
    dueDate: "2026-08-01",
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const ledger = await student.get("/api/my/payment-ledger");
  const row = (ledger.body?.items || []).find((entry) => Number(entry.id) === Number(createItem.body.id));
  expect(row).toBeTruthy();

  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/mock-session-callback",
          access_code: "mock-access-code-callback",
          reference: "PSTK-MOCK-CALLBACK-001",
        },
      }),
  });
  const init = await postJson(student, "/api/payments/paystack/initialize", {
    obligationId: row.obligation_id,
    amount: 12500,
  });
  expect(init.status).toBe(200);

  const callback = await request(app).get(
    `/api/payments/paystack/callback?reference=${encodeURIComponent(init.body.reference)}`
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.location).toContain("/payments.html");
  expect(callback.headers.location).toContain("paystack_status=pending_webhook");

  const transactions = await get("SELECT COUNT(*) AS total FROM payment_transactions WHERE source = 'paystack'");
  expect(Number(transactions.total || 0)).toBe(0);
  const session = await get("SELECT status FROM paystack_sessions WHERE gateway_reference = ? LIMIT 1", [init.body.reference]);
  expect(session).toBeTruthy();
  expect(session.status).toBe("pending_webhook");
});

test("paystack webhook validates signature and auto-approves exact metadata reference", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Paystack Webhook Exact",
    description: "Exact reference auto-approval",
    expectedAmount: 47000,
    currency: "NGN",
    dueDate: "2026-08-20",
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const ledger = await student.get("/api/my/payment-ledger");
  const row = (ledger.body?.items || []).find((entry) => Number(entry.id) === Number(createItem.body.id));
  expect(row?.my_reference).toBeTruthy();
  expect(Number(row?.obligation_id || 0)).toBeGreaterThan(0);

  const webhookPayload = {
    id: "evt-paystack-exact-001",
    event: "charge.success",
    data: {
      id: 999001,
      reference: "PSTK-GW-EXACT-001",
      amount: 4700000,
      paid_at: "2026-02-23T11:00:00Z",
      customer: {
        email: "std_001@paytec.local",
        first_name: "Std",
        last_name: "One",
      },
      metadata: {
        tenant: "default-school",
        school_id: "default-school",
        student_username: "std_001",
        payment_item_id: createItem.body.id,
        obligation_id: row.obligation_id,
        payment_reference: row.my_reference,
      },
    },
  };

  const invalidSignatureResponse = await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", "invalid-signature")
    .send(JSON.stringify(webhookPayload));
  expect(invalidSignatureResponse.status).toBe(401);
  expect(invalidSignatureResponse.body.code).toBe("paystack_webhook_invalid_signature");

  const { rawBody, signature } = signPaystackPayload(webhookPayload);
  const validResponse = await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature)
    .send(rawBody);
  expect(validResponse.status).toBe(200);
  expect(validResponse.body.ok).toBe(true);
  expect(validResponse.body.inserted).toBe(true);
  expect(validResponse.body.idempotent).toBe(false);

  const tx = await get("SELECT status, matched_obligation_id, source FROM payment_transactions WHERE id = ? LIMIT 1", [
    validResponse.body.transaction_id,
  ]);
  expect(tx).toBeTruthy();
  expect(tx.source).toBe("paystack");
  expect(tx.status).toBe("approved");
  expect(Number(tx.matched_obligation_id || 0)).toBe(Number(row.obligation_id));

  const session = await get("SELECT status FROM paystack_sessions WHERE gateway_reference = ? LIMIT 1", ["PSTK-GW-EXACT-001"]);
  expect(session).toBeTruthy();
  expect(session.status).toBe("approved");
});

test("paystack webhook is idempotent for repeated source event id", async () => {
  const payload = {
    id: "evt-paystack-idempotent-001",
    event: "charge.success",
    data: {
      id: 880001,
      reference: "PSTK-GW-IDEMP-001",
      amount: 500000,
      paid_at: "2026-02-23T13:00:00Z",
      customer: { email: "std_002@paytec.local", first_name: "Std", last_name: "Two" },
      metadata: {
        tenant: "default-school",
        school_id: "default-school",
        student_username: "std_002",
        payment_item_id: null,
        obligation_id: null,
        payment_reference: "PSTK-GW-IDEMP-001",
      },
    },
  };

  const signed = signPaystackPayload(payload);
  const first = await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signed.signature)
    .send(signed.rawBody);
  expect(first.status).toBe(200);
  expect(first.body.idempotent).toBe(false);

  const second = await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signed.signature)
    .send(signed.rawBody);
  expect(second.status).toBe(200);
  expect(second.body.idempotent).toBe(true);

  const rows = await all("SELECT id FROM payment_transactions WHERE source_event_id = ?", [
    "paystack-charge.success-evt-paystack-idempotent-001",
  ]);
  expect(rows.length).toBe(1);
});

test("paystack verify endpoint ingests successful reference idempotently", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Paystack Verify Fee",
    description: "Verify endpoint test",
    expectedAmount: 29000,
    currency: "NGN",
    dueDate: "2026-09-30",
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const ledger = await student.get("/api/my/payment-ledger");
  const row = (ledger.body?.items || []).find((entry) => Number(entry.id) === Number(createItem.body.id));
  expect(row).toBeTruthy();

  const fetchPayload = {
    status: true,
    message: "Verification successful",
    data: {
      id: 7722001,
      status: "success",
      reference: "PSTK-VERIFY-REF-001",
      amount: 2900000,
      paid_at: "2026-02-23T15:10:00Z",
      customer: {
        email: "std_001@paytec.local",
        first_name: "Std",
        last_name: "One",
      },
      metadata: {
        tenant: "default-school",
        school_id: "default-school",
        student_username: "std_001",
        payment_item_id: createItem.body.id,
        obligation_id: row.obligation_id,
        payment_reference: row.my_reference,
      },
    },
  };
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(fetchPayload),
  });

  const first = await postJson(teacher, "/api/payments/paystack/verify", {
    reference: "PSTK-VERIFY-REF-001",
  });
  expect(first.status).toBe(200);
  expect(first.body.inserted).toBe(true);
  expect(first.body.idempotent).toBe(false);

  const second = await postJson(teacher, "/api/payments/paystack/verify", {
    reference: "PSTK-VERIFY-REF-001",
  });
  expect(second.status).toBe(200);
  expect(second.body.idempotent).toBe(true);
});

test("paystack verify endpoint accepts internal job secret without session", async () => {
  const fetchPayload = {
    status: true,
    message: "Verification successful",
    data: {
      id: 7733001,
      status: "success",
      reference: "PSTK-VERIFY-INTERNAL-001",
      amount: 150000,
      paid_at: "2026-02-23T16:45:00Z",
      customer: {
        email: "std_002@paytec.local",
        first_name: "Std",
        last_name: "Two",
      },
      metadata: {
        tenant: "default-school",
        school_id: "default-school",
        student_username: "std_002",
        payment_reference: "PSTK-VERIFY-INTERNAL-001",
      },
    },
  };
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(fetchPayload),
  });

  const internalVerify = await request(app)
    .post("/api/payments/paystack/verify")
    .set("Content-Type", "application/json")
    .set("x-paytec-webhook-secret", process.env.PAYSTACK_WEBHOOK_SECRET)
    .send({ reference: "PSTK-VERIFY-INTERNAL-001" });
  expect(internalVerify.status).toBe(200);
  expect(internalVerify.body.ok).toBe(true);
  expect(Number(internalVerify.body.transaction_id || 0)).toBeGreaterThan(0);

  const latestEvent = await get(
    "SELECT actor_role FROM reconciliation_events WHERE transaction_id = ? ORDER BY id DESC LIMIT 1",
    [internalVerify.body.transaction_id]
  );
  expect(latestEvent).toBeTruthy();
  expect(latestEvent.actor_role).toBe("system-paystack");
});

test("paystack amount mismatch routes transaction to exception queue", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Paystack Mismatch",
    description: "Mismatch should be queued",
    expectedAmount: 62000,
    currency: "NGN",
    dueDate: "2026-09-10",
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const ledger = await student.get("/api/my/payment-ledger");
  const row = (ledger.body?.items || []).find((entry) => Number(entry.id) === Number(createItem.body.id));
  expect(row).toBeTruthy();

  const payload = {
    id: "evt-paystack-mismatch-001",
    event: "charge.success",
    data: {
      id: 990091,
      reference: "PSTK-GW-MISMATCH-001",
      amount: 50000,
      paid_at: "2026-02-23T14:30:00Z",
      customer: { email: "std_001@paytec.local", first_name: "Std", last_name: "One" },
      metadata: {
        tenant: "default-school",
        school_id: "default-school",
        student_username: "std_001",
        payment_item_id: createItem.body.id,
        obligation_id: row.obligation_id,
        payment_reference: "UNKNOWN-PAYMENT-REF-001",
      },
    },
  };
  const signed = signPaystackPayload(payload);
  const webhook = await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signed.signature)
    .send(signed.rawBody);
  expect(webhook.status).toBe(200);

  const tx = await get("SELECT status FROM payment_transactions WHERE id = ? LIMIT 1", [webhook.body.transaction_id]);
  expect(tx).toBeTruthy();
  expect(["needs_review", "unmatched"]).toContain(tx.status);

  const queue = await teacher.get("/api/teacher/reconciliation/exceptions?student=std_001");
  expect(queue.status).toBe(200);
  const queueItems = Array.isArray(queue.body) ? queue.body : queue.body.items || [];
  expect(queueItems.some((entry) => Number(entry.id) === Number(webhook.body.transaction_id))).toBe(true);
});

test("reconciliation auto-approves exact obligation reference from webhook", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Webhook Exact Match Fee",
    description: "Exact reference match",
    expectedAmount: 31000,
    currency: "NGN",
    dueDate: "2026-07-01",
    availabilityDays: 30,
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const itemRows = await student.get("/api/payment-items");
  expect(itemRows.status).toBe(200);
  const itemRow = (itemRows.body || []).find((row) => Number(row.id) === Number(createItem.body.id));
  expect(itemRow).toBeTruthy();
  expect(itemRow.my_reference).toBeTruthy();

  const webhook = await request(app).post("/api/payments/webhook").send({
    eventId: "evt-exact-ref-001",
    transaction: {
      reference: itemRow.my_reference,
      amount: 31000,
      date: "2026-02-23T10:00:00Z",
      payer_name: "std_001",
    },
  });
  expect(webhook.status).toBe(200);
  expect(webhook.body.ok).toBe(true);
  expect(webhook.body.inserted).toBe(true);
  expect(webhook.body.idempotent).toBe(false);

  const tx = await get("SELECT status, matched_obligation_id FROM payment_transactions WHERE id = ? LIMIT 1", [
    webhook.body.transaction_id,
  ]);
  expect(tx).toBeTruthy();
  expect(tx.status).toBe("approved");
  expect(Number(tx.matched_obligation_id || 0)).toBeGreaterThan(0);

  const summary = await teacher.get("/api/teacher/reconciliation/summary");
  expect(summary.status).toBe(200);
  expect(Number(summary.body.auto_approved || 0)).toBeGreaterThan(0);
});

test("reconciliation keeps amount mismatch in exception queue for review", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Mismatch Review Fee",
    description: "Mismatch should require review",
    expectedAmount: 42000,
    currency: "NGN",
    dueDate: "2026-08-01",
    availabilityDays: 30,
  });
  expect(createItem.status).toBe(201);

  const webhook = await request(app).post("/api/payments/webhook").send({
    eventId: "evt-mismatch-001",
    transaction: {
      reference: "UNKNOWN-MISMATCH-REF-001",
      amount: 1000,
      date: "2026-02-23T12:00:00Z",
      payer_name: "std_001",
      payment_item_id: createItem.body.id,
      student_username: "std_001",
    },
  });
  expect(webhook.status).toBe(200);

  const tx = await get("SELECT status FROM payment_transactions WHERE id = ? LIMIT 1", [webhook.body.transaction_id]);
  expect(tx).toBeTruthy();
  expect(["needs_review", "unmatched"]).toContain(tx.status);

  const queue = await teacher.get("/api/teacher/reconciliation/exceptions?student=std_001");
  expect(queue.status).toBe(200);
  const queueItems = Array.isArray(queue.body) ? queue.body : queue.body.items || [];
  expect(queueItems.some((row) => Number(row.id) === Number(webhook.body.transaction_id))).toBe(true);
});

test("duplicate transaction detection flags repeated webhook reference", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Duplicate Detection Fee",
    description: "Duplicate webhook transactions",
    expectedAmount: 15000,
    currency: "NGN",
    dueDate: "2026-09-01",
    availabilityDays: 30,
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const itemRows = await student.get("/api/payment-items");
  const itemRow = (itemRows.body || []).find((row) => Number(row.id) === Number(createItem.body.id));
  expect(itemRow?.my_reference).toBeTruthy();

  const first = await request(app).post("/api/payments/webhook").send({
    eventId: "evt-dup-001",
    transaction: {
      reference: itemRow.my_reference,
      amount: 15000,
      date: "2026-02-23T14:00:00Z",
      payer_name: "std_001",
    },
  });
  expect(first.status).toBe(200);
  const second = await request(app).post("/api/payments/webhook").send({
    eventId: "evt-dup-002",
    transaction: {
      reference: itemRow.my_reference,
      amount: 15000,
      date: "2026-02-23T14:00:00Z",
      payer_name: "std_001",
    },
  });
  expect(second.status).toBe(200);

  const firstTx = await get("SELECT status FROM payment_transactions WHERE id = ? LIMIT 1", [first.body.transaction_id]);
  const secondTx = await get("SELECT status FROM payment_transactions WHERE id = ? LIMIT 1", [second.body.transaction_id]);
  expect(firstTx.status).toBe("approved");
  expect(secondTx.status).toBe("duplicate");
});

test("duplicate merge action keeps primary and marks duplicate link", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Duplicate Merge Fee",
    description: "Merge duplicate test",
    expectedAmount: 19000,
    currency: "NGN",
    dueDate: "2026-10-01",
    availabilityDays: 30,
  });
  expect(createItem.status).toBe(201);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const itemRows = await student.get("/api/payment-items");
  const itemRow = (itemRows.body || []).find((row) => Number(row.id) === Number(createItem.body.id));
  expect(itemRow?.my_reference).toBeTruthy();

  const primary = await request(app).post("/api/payments/webhook").send({
    eventId: "evt-merge-primary-001",
    transaction: {
      reference: itemRow.my_reference,
      amount: 19000,
      date: "2026-02-23T16:00:00Z",
      payer_name: "std_001",
    },
  });
  expect(primary.status).toBe(200);
  const duplicate = await request(app).post("/api/payments/webhook").send({
    eventId: "evt-merge-duplicate-001",
    transaction: {
      reference: itemRow.my_reference,
      amount: 19000,
      date: "2026-02-23T16:00:00Z",
      payer_name: "std_001",
    },
  });
  expect(duplicate.status).toBe(200);

  const merge = await postJson(teacher, `/api/reconciliation/${duplicate.body.transaction_id}/merge-duplicates`, {
    primaryTransactionId: String(primary.body.transaction_id),
  });
  expect(merge.status).toBe(200);

  const duplicateTx = await get(
    "SELECT status, matched_obligation_id FROM payment_transactions WHERE id = ? LIMIT 1",
    [duplicate.body.transaction_id]
  );
  const primaryTx = await get(
    "SELECT status, matched_obligation_id FROM payment_transactions WHERE id = ? LIMIT 1",
    [primary.body.transaction_id]
  );
  expect(primaryTx.status).toBe("approved");
  expect(duplicateTx.status).toBe("duplicate");
  expect(Number(duplicateTx.matched_obligation_id || 0)).toBe(Number(primaryTx.matched_obligation_id || 0));
});

test("statement dry-run previews rows without mutating transactions", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const txBefore = await get("SELECT COUNT(*) AS total FROM payment_transactions");

  const teacherCsrf = await getCsrfToken(teacher);
  const statementCsv = [
    "name,amount,date,reference",
    "std_001,12000,2026-02-20,DRY-RUN-REF-001",
    "std_002,abc,2026-02-20,DRY-RUN-REF-002",
  ].join("\n");
  const upload = await teacher
    .post("/api/teacher/payment-statement?dryRun=true")
    .set("X-CSRF-Token", teacherCsrf)
    .attach("statementFile", Buffer.from(statementCsv), { filename: "dry-run.csv", contentType: "text/csv" });
  expect(upload.status).toBe(200);
  expect(upload.body.dryRun).toBe(true);
  expect(upload.body.ingestion).toBeTruthy();

  const txAfter = await get("SELECT COUNT(*) AS total FROM payment_transactions");
  expect(Number(txAfter.total || 0)).toBe(Number(txBefore.total || 0));
});

test("legacy receipt migration maps to transactions and matches", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Legacy Migration Fee",
    description: "Legacy mapping",
    expectedAmount: 25000,
    currency: "NGN",
    dueDate: "2026-11-01",
  });
  expect(createItem.status).toBe(201);

  const insertLegacy = await run(
    `
      INSERT INTO payment_receipts (
        payment_item_id,
        student_username,
        amount_paid,
        paid_at,
        transaction_ref,
        receipt_file_path,
        status,
        verification_notes,
        extracted_text
      )
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?)
    `,
    [
      createItem.body.id,
      "std_001",
      25000,
      "2026-02-23T17:00:00Z",
      "TX-LEGACY-MAP-001",
      "legacy-no-file",
      JSON.stringify({ reviewer_note: "legacy approved" }),
      "",
    ]
  );

  await initDatabase();

  const migratedTx = await get(
    "SELECT id, status, matched_obligation_id FROM payment_transactions WHERE source_event_id = ? LIMIT 1",
    [`legacy-receipt-${insertLegacy.lastID}`]
  );
  expect(migratedTx).toBeTruthy();
  expect(Number(migratedTx.matched_obligation_id || 0)).toBeGreaterThan(0);
  expect(["approved", "needs_review", "rejected"]).toContain(migratedTx.status);

  const matchRow = await get("SELECT decision FROM payment_matches WHERE transaction_id = ? LIMIT 1", [migratedTx.id]);
  expect(matchRow).toBeTruthy();
});

test("webhook ingestion is idempotent for repeated event id", async () => {
  const payload = {
    eventId: "evt-idempotent-001",
    transaction: {
      reference: "IDEMP-REF-001",
      amount: 5000,
      date: "2026-02-23T15:00:00Z",
      payer_name: "std_002",
    },
  };
  const first = await request(app).post("/api/payments/webhook").send(payload);
  expect(first.status).toBe(200);
  expect(first.body.idempotent).toBe(false);
  const second = await request(app).post("/api/payments/webhook").send(payload);
  expect(second.status).toBe(200);
  expect(second.body.idempotent).toBe(true);

  const rows = await all("SELECT id FROM payment_transactions WHERE source_event_id = ?", ["evt-idempotent-001"]);
  expect(rows.length).toBe(1);
});

test("payment item availability controls student visibility in payments and notifications", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const createItem = await postJson(teacher, "/api/payment-items", {
    title: "Temporary Item",
    description: "Expires quickly",
    expectedAmount: 5000,
    currency: "NGN",
    dueDate: "",
    availabilityDays: 1,
  });
  expect(createItem.status).toBe(201);
  const itemId = createItem.body.id;

  await run("UPDATE payment_items SET available_until = '2001-01-01T00:00:00.000Z' WHERE id = ?", [itemId]);
  await run(
    "UPDATE notifications SET expires_at = '2001-01-01T00:00:00.000Z' WHERE related_payment_item_id = ? AND auto_generated = 1",
    [itemId]
  );

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const paymentItems = await student.get("/api/payment-items");
  expect(paymentItems.status).toBe(200);
  expect((paymentItems.body || []).some((row) => row.id === itemId)).toBe(false);

  const notifications = await student.get("/api/notifications");
  expect(notifications.status).toBe(200);
  expect((notifications.body || []).some((row) => Number(row.related_payment_item_id || 0) === itemId)).toBe(false);
});
