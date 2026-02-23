const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const XLSX = require("xlsx");

const testDataDir = path.join(__dirname, "tmp-data");
process.env.NODE_ENV = "test";
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = "test-session-secret";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-pass-123";
process.env.STUDENT_ROSTER_PATH = path.join(testDataDir, "students.csv");
process.env.TEACHER_ROSTER_PATH = path.join(testDataDir, "teachers.csv");

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
