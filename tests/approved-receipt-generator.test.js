const fs = require("fs");
const os = require("os");
const path = require("path");
const { generateApprovedStudentReceipts, renderTemplate } = require("../services/approved-receipt-generator");
const { openSqliteDatabase } = require("../services/sqlite-client");

const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6j4BsAAAAASUVORK5CYII=";

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function collectEvents(mockFn) {
  return mockFn.mock.calls
    .map((call) => (call && call[0] && typeof call[0] === "object" ? call[0].event : null))
    .filter(Boolean);
}

async function setupSchema(db) {
  await db.run(`
    CREATE TABLE payment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN'
    )
  `);
  await db.run(`
    CREATE TABLE payment_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_item_id INTEGER NOT NULL,
      student_username TEXT NOT NULL,
      amount_paid REAL NOT NULL,
      paid_at TEXT,
      transaction_ref TEXT NOT NULL,
      receipt_file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT
    )
  `);
  await db.run(`
    CREATE TABLE payment_obligations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_item_id INTEGER NOT NULL,
      student_username TEXT NOT NULL,
      payment_reference TEXT NOT NULL
    )
  `);
  await db.run(`
    CREATE TABLE user_profiles (
      username TEXT PRIMARY KEY,
      display_name TEXT,
      profile_image_url TEXT,
      email TEXT
    )
  `);
}

async function seedApprovedReceiptRow(db) {
  await db.run("INSERT INTO payment_items (id, title, currency) VALUES (1, 'Computer Science', 'NGN')");
  await db.run(
    `
      INSERT INTO payment_obligations (payment_item_id, student_username, payment_reference)
      VALUES (1, 'std_001', 'APP-0001')
    `
  );
  await db.run(
    `
      INSERT INTO user_profiles (username, display_name, profile_image_url, email)
      VALUES ('std_001', 'Ada Lovelace', '/users/std_001.png', 'std_001@example.com')
    `
  );
  await db.run(
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
        reviewed_at
      )
      VALUES (1, 'std_001', 50000, '2026-02-24T10:00:00.000Z', 'TX-001', '/tmp/source.pdf', 'approved', '2026-02-24T10:00:00.000Z', '2026-02-25T09:00:00.000Z')
    `
  );
}

describe("approved receipt generator", () => {
  let tmpDir;
  let dataDir;
  let db;
  let logger;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paytec-receipt-generator-"));
    dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(path.join(dataDir, "users"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "users", "std_001.png"), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
    db = openSqliteDatabase(path.join(tmpDir, "test.sqlite"));
    logger = makeLogger();
    await setupSchema(db);
    await seedApprovedReceiptRow(db);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("renderTemplate replaces placeholders", () => {
    const output = renderTemplate("Hi {{full_name}} | {{program}} | {{missing}}", {
      full_name: "Ada",
      program: "Computer Science",
    });
    expect(output).toBe("Hi Ada | Computer Science | ");
  });

  test("generates PDF, sends mail, and updates sent status", async () => {
    const outputDir = path.join(tmpDir, "outputs", "receipts");
    const sendEmail = jest.fn().mockResolvedValue({});
    const renderPdf = jest.fn(async ({ outputPdfPath }) => {
      fs.mkdirSync(path.dirname(outputPdfPath), { recursive: true });
      fs.writeFileSync(outputPdfPath, Buffer.from("%PDF-1.4\n%mock\n"));
    });

    const summary = await generateApprovedStudentReceipts({
      db,
      dataDir,
      outputDir,
      templateHtml:
        "<html><head></head><body>{{full_name}}|{{application_id}}|{{program}}|{{amount_paid}}|{{receipt_no}}|{{approval_date}}|{{passport_photo}}</body></html>",
      templateCss: "body{font-family:Arial,sans-serif;}",
      sendEmail,
      renderPdf,
      nowProvider: () => new Date("2026-02-25T11:00:00.000Z"),
      logger,
    });

    expect(summary).toEqual({ eligible: 1, sent: 1, failed: 0 });
    expect(renderPdf).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe("std_001@example.com");
    expect(sendEmail.mock.calls[0][0].subject).toBe("Your Approved Student Receipt");
    expect(sendEmail.mock.calls[0][0].attachments).toHaveLength(1);

    const dispatchRow = await db.get(
      `
        SELECT receipt_sent, receipt_generated_at, receipt_sent_at, receipt_file_path, attempt_count
        FROM approved_receipt_dispatches
        WHERE payment_receipt_id = 1
      `
    );
    expect(dispatchRow).toBeTruthy();
    expect(Number(dispatchRow.receipt_sent)).toBe(1);
    expect(dispatchRow.receipt_generated_at).toBeTruthy();
    expect(dispatchRow.receipt_sent_at).toBeTruthy();
    expect(dispatchRow.receipt_file_path).toMatch(/[\\/]APP-0001_2026-02-25\.pdf$/);
    expect(Number(dispatchRow.attempt_count)).toBe(1);
    expect(fs.existsSync(dispatchRow.receipt_file_path)).toBe(true);

    const infoEvents = collectEvents(logger.info);
    expect(infoEvents).toEqual(
      expect.arrayContaining(["start", "generate_success", "send_success", "summary"])
    );
  });

  test("keeps receipt_sent false when email send fails", async () => {
    const outputDir = path.join(tmpDir, "outputs", "receipts");
    const renderPdf = jest.fn(async ({ outputPdfPath }) => {
      fs.mkdirSync(path.dirname(outputPdfPath), { recursive: true });
      fs.writeFileSync(outputPdfPath, Buffer.from("%PDF-1.4\n%mock\n"));
    });
    const sendEmail = jest.fn().mockRejectedValue(Object.assign(new Error("SMTP auth failed"), { code: "EAUTH" }));

    const summary = await generateApprovedStudentReceipts({
      db,
      dataDir,
      outputDir,
      templateHtml: "<html><body>{{full_name}}</body></html>",
      templateCss: "",
      sendEmail,
      renderPdf,
      nowProvider: () => new Date("2026-02-25T11:00:00.000Z"),
      logger,
    });

    expect(summary).toEqual({ eligible: 1, sent: 0, failed: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(renderPdf).toHaveBeenCalledTimes(1);

    const dispatchRow = await db.get(
      `
        SELECT receipt_sent, receipt_generated_at, receipt_sent_at, receipt_file_path, last_error
        FROM approved_receipt_dispatches
        WHERE payment_receipt_id = 1
      `
    );
    expect(Number(dispatchRow.receipt_sent)).toBe(0);
    expect(dispatchRow.receipt_generated_at).toBeTruthy();
    expect(dispatchRow.receipt_sent_at).toBeFalsy();
    expect(dispatchRow.receipt_file_path).toMatch(/[\\/]APP-0001_2026-02-25\.pdf$/);
    expect(dispatchRow.last_error).toContain("SMTP auth failed");

    const errorEvents = collectEvents(logger.error);
    expect(errorEvents).toContain("send_fail");
  });

  test("skips already-sent rows unless force is enabled", async () => {
    const outputDir = path.join(tmpDir, "outputs", "receipts");
    const renderPdf = jest.fn(async ({ outputPdfPath }) => {
      fs.mkdirSync(path.dirname(outputPdfPath), { recursive: true });
      fs.writeFileSync(outputPdfPath, Buffer.from("%PDF-1.4\n%mock\n"));
    });
    const sendEmailFirstRun = jest.fn().mockResolvedValue({});
    await generateApprovedStudentReceipts({
      db,
      dataDir,
      outputDir,
      templateHtml: "<html><body>{{full_name}}</body></html>",
      templateCss: "",
      sendEmail: sendEmailFirstRun,
      renderPdf,
      nowProvider: () => new Date("2026-02-25T11:00:00.000Z"),
      logger,
    });
    expect(sendEmailFirstRun).toHaveBeenCalledTimes(1);

    const sendEmailSecondRun = jest.fn().mockResolvedValue({});
    const secondSummary = await generateApprovedStudentReceipts({
      db,
      dataDir,
      outputDir,
      templateHtml: "<html><body>{{full_name}}</body></html>",
      templateCss: "",
      sendEmail: sendEmailSecondRun,
      renderPdf,
      nowProvider: () => new Date("2026-02-25T12:00:00.000Z"),
      logger,
    });
    expect(secondSummary).toEqual({ eligible: 0, sent: 0, failed: 0 });
    expect(sendEmailSecondRun).not.toHaveBeenCalled();

    const sendEmailForced = jest.fn().mockResolvedValue({});
    const forcedSummary = await generateApprovedStudentReceipts({
      db,
      force: true,
      dataDir,
      outputDir,
      templateHtml: "<html><body>{{full_name}}</body></html>",
      templateCss: "",
      sendEmail: sendEmailForced,
      renderPdf,
      nowProvider: () => new Date("2026-02-25T13:00:00.000Z"),
      logger,
    });
    expect(forcedSummary).toEqual({ eligible: 1, sent: 1, failed: 0 });
    expect(sendEmailForced).toHaveBeenCalledTimes(1);
  });

  test("processes only the targeted paymentReceiptId when provided", async () => {
    await db.run(
      `
        INSERT INTO payment_obligations (payment_item_id, student_username, payment_reference)
        VALUES (1, 'std_002', 'APP-0002')
      `
    );
    await db.run(
      `
        INSERT INTO user_profiles (username, display_name, profile_image_url, email)
        VALUES ('std_002', 'Grace Hopper', '/users/std_001.png', 'std_002@example.com')
      `
    );
    await db.run(
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
          reviewed_at
        )
        VALUES (1, 'std_002', 45000, '2026-02-24T10:00:00.000Z', 'TX-002', '/tmp/source-2.pdf', 'approved', '2026-02-24T10:00:00.000Z', '2026-02-25T09:30:00.000Z')
      `
    );

    const outputDir = path.join(tmpDir, "outputs", "receipts");
    const sendEmail = jest.fn().mockResolvedValue({});
    const renderPdf = jest.fn(async ({ outputPdfPath }) => {
      fs.mkdirSync(path.dirname(outputPdfPath), { recursive: true });
      fs.writeFileSync(outputPdfPath, Buffer.from("%PDF-1.4\n%mock\n"));
    });

    const summary = await generateApprovedStudentReceipts({
      db,
      paymentReceiptId: 2,
      dataDir,
      outputDir,
      templateHtml: "<html><body>{{full_name}}</body></html>",
      templateCss: "",
      sendEmail,
      renderPdf,
      nowProvider: () => new Date("2026-02-25T11:00:00.000Z"),
      logger,
    });

    expect(summary).toEqual({ eligible: 1, sent: 1, failed: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe("std_002@example.com");

    const firstDispatch = await db.get(
      `
        SELECT receipt_sent
        FROM approved_receipt_dispatches
        WHERE payment_receipt_id = 1
      `
    );
    const secondDispatch = await db.get(
      `
        SELECT receipt_sent
        FROM approved_receipt_dispatches
        WHERE payment_receipt_id = 2
      `
    );
    expect(firstDispatch).toBeNull();
    expect(Number(secondDispatch.receipt_sent || 0)).toBe(1);
  });

  test("preserves sent state if a force resend attempt fails", async () => {
    const outputDir = path.join(tmpDir, "outputs", "receipts");
    const renderPdf = jest.fn(async ({ outputPdfPath }) => {
      fs.mkdirSync(path.dirname(outputPdfPath), { recursive: true });
      fs.writeFileSync(outputPdfPath, Buffer.from("%PDF-1.4\n%mock\n"));
    });

    await generateApprovedStudentReceipts({
      db,
      dataDir,
      outputDir,
      templateHtml: "<html><body>{{full_name}}</body></html>",
      templateCss: "",
      sendEmail: jest.fn().mockResolvedValue({}),
      renderPdf,
      nowProvider: () => new Date("2026-02-25T11:00:00.000Z"),
      logger,
    });

    const forceFailSummary = await generateApprovedStudentReceipts({
      db,
      force: true,
      dataDir,
      outputDir,
      templateHtml: "<html><body>{{full_name}}</body></html>",
      templateCss: "",
      sendEmail: jest.fn().mockRejectedValue(new Error("forced resend failed")),
      renderPdf,
      nowProvider: () => new Date("2026-02-25T12:00:00.000Z"),
      logger,
    });
    expect(forceFailSummary).toEqual({ eligible: 1, sent: 0, failed: 1 });

    const dispatchAfterFail = await db.get(
      `
        SELECT receipt_sent, receipt_sent_at, last_error, attempt_count
        FROM approved_receipt_dispatches
        WHERE payment_receipt_id = 1
      `
    );
    expect(Number(dispatchAfterFail.receipt_sent)).toBe(1);
    expect(dispatchAfterFail.receipt_sent_at).toBeTruthy();
    expect(dispatchAfterFail.last_error).toContain("forced resend failed");
    expect(Number(dispatchAfterFail.attempt_count)).toBe(2);

    const defaultRunAfterForceFailure = await generateApprovedStudentReceipts({
      db,
      dataDir,
      outputDir,
      templateHtml: "<html><body>{{full_name}}</body></html>",
      templateCss: "",
      sendEmail: jest.fn().mockResolvedValue({}),
      renderPdf,
      nowProvider: () => new Date("2026-02-25T13:00:00.000Z"),
      logger,
    });
    expect(defaultRunAfterForceFailure).toEqual({ eligible: 0, sent: 0, failed: 0 });
  });
});
