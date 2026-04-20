const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const mockPaystackTransferClient = {
  hasSecretKey: true,
  createTransferRecipient: jest.fn(),
  initiateTransfer: jest.fn(),
  getTransfer: jest.fn(),
  listBanks: jest.fn(),
};

jest.mock("../services/approved-receipt-generator", () => ({
  generateApprovedStudentReceipts: jest.fn(async () => ({
    eligible: 0,
    sent: 0,
    failed: 0,
  })),
}));

jest.mock("../services/paystack-transfers", () => ({
  createPaystackTransferClient: jest.fn(() => mockPaystackTransferClient),
}));

jest.setTimeout(30000);

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paytec-payout-"));
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
process.env.PAYOUT_ENCRYPTION_KEY = "test-payout-encryption-key";
process.env.PAYOUT_DEFAULT_SHARE_BPS = "10000";
process.env.PAYOUT_MINIMUM_AMOUNT = "1000";
process.env.PAYOUT_WORKER_INTERVAL_MS = "0";

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

function signPaystackPayload(payload, secret = process.env.PAYSTACK_WEBHOOK_SECRET) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  return { rawBody, signature };
}

async function clearPayoutTables() {
  await run("DELETE FROM lecturer_payout_events");
  await run("DELETE FROM lecturer_payout_transfers");
  await run("DELETE FROM lecturer_payout_ledger");
  await run("DELETE FROM lecturer_payout_accounts");
  await run("DELETE FROM payment_matches");
  await run("DELETE FROM reconciliation_exceptions");
  await run("DELETE FROM reconciliation_events");
  await run("DELETE FROM payment_transactions");
  await run("DELETE FROM paystack_sessions");
  await run("DELETE FROM payment_obligations");
  await run("DELETE FROM payment_items");
  await run("DELETE FROM payment_receipt_events");
  await run("DELETE FROM payment_receipts");
  await run("DELETE FROM audit_events");
  await run("DELETE FROM audit_logs");
}

beforeAll(async () => {
  fs.mkdirSync(testDataDir, { recursive: true });
  await initDatabase();
  await clearPayoutTables();
  await run("DELETE FROM auth_roster");
  await run("DELETE FROM users WHERE role != 'admin'");

  const teacherHash = await bcrypt.hash("teach", 12);
  const studentHash = await bcrypt.hash("doe", 12);
  await run(
    `
      INSERT INTO auth_roster (auth_id, role, password_hash, source_file)
      VALUES
        ('teach_001', 'teacher', ?, 'tests'),
        ('std_001', 'student', ?, 'tests')
    `,
    [teacherHash, studentHash]
  );
});

beforeEach(async () => {
  await clearPayoutTables();
  mockPaystackTransferClient.createTransferRecipient.mockReset();
  mockPaystackTransferClient.initiateTransfer.mockReset();
  mockPaystackTransferClient.getTransfer.mockReset();
  mockPaystackTransferClient.listBanks.mockReset();

  mockPaystackTransferClient.createTransferRecipient.mockImplementation(async (input) => ({
    status: true,
    message: "Recipient created",
    data: {
      recipient_code: `RCP-${String(input.bank_code || "000").slice(0, 3)}-${String(input.account_number || "").slice(-4)}`,
      type: input.type || "nuban",
      active: true,
      details: {
        bank_name: `Bank ${String(input.bank_code || "000")}`,
        account_name: input.name,
      },
    },
  }));

  mockPaystackTransferClient.initiateTransfer.mockImplementation(async (input) => ({
    status: true,
    message: "Transfer queued",
    data: {
      status: "processing",
      transfer_code: `TRF-${String(input.reference || "REF").slice(-8)}`,
      reference: input.reference,
      amount: input.amount,
      recipient: input.recipient,
      details: {
        bank_name: "Bank 999",
        account_name: "Lecturer One",
      },
    },
  }));
});

afterAll(async () => {
  await new Promise((resolve) => db.close(resolve));
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch (_err) {
    // Best-effort cleanup only.
  }
});

async function createLecturerPaymentItem(teacher, title, expectedAmount = 47000) {
  const itemResponse = await postJson(teacher, "/api/payment-items", {
    title,
    description: `${title} description`,
    expectedAmount,
    currency: "NGN",
    dueDate: "2026-08-20",
  });
  expect(itemResponse.status).toBe(201);
  return itemResponse.body;
}

async function createApprovedPayoutBalance({ title = "Payout Fee", amount = 47000 } = {}) {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const item = await createLecturerPaymentItem(teacher, title, amount);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const ledger = await student.get("/api/my/payment-ledger");
  const row = (ledger.body?.items || []).find((entry) => Number(entry.id) === Number(item.id));
  expect(row?.my_reference).toBeTruthy();
  expect(Number(row?.obligation_id || 0)).toBeGreaterThan(0);

  return { teacher, student, item, row };
}

test("lecturer payout account response masks the bank account number", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");

  const saveResponse = await postJson(teacher, "/api/lecturer/payout-account", {
    bankName: "Bank 999",
    bankCode: "999",
    accountName: "Lecturer One",
    accountNumber: "1234567890",
    autoPayoutEnabled: false,
    reviewRequired: false,
  });
  expect(saveResponse.status).toBe(200);
  expect(saveResponse.body.account.account_masked).toBe("**** 7890");
  expect(saveResponse.body.account.account_last4).toBe("7890");
  expect(String(JSON.stringify(saveResponse.body))).not.toContain("1234567890");

  const fetchResponse = await teacher.get("/api/lecturer/payout-account");
  expect(fetchResponse.status).toBe(200);
  expect(fetchResponse.body.account.account_masked).toBe("**** 7890");
  expect(fetchResponse.body.account.account_number_encrypted).toBeUndefined();
});

test("payout account save returns Paystack validation errors instead of a generic 500", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  mockPaystackTransferClient.createTransferRecipient.mockRejectedValueOnce(
    Object.assign(new Error("Account number is invalid for the selected bank."), {
      status: 400,
      code: "paystack_api_error",
    })
  );

  const response = await postJson(teacher, "/api/lecturer/payout-account", {
    bankName: "Bank 999",
    bankCode: "999",
    accountName: "Lecturer One",
    accountNumber: "1234567890",
    autoPayoutEnabled: false,
    reviewRequired: false,
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toBe("Account number is invalid for the selected bank.");
  expect(response.body.code).toBe("paystack_api_error");
});

test("initDatabase upgrades legacy lecturer payout account columns before payout details are saved", async () => {
  await run("DROP TABLE IF EXISTS lecturer_payout_events");
  await run("DROP TABLE IF EXISTS lecturer_payout_ledger");
  await run("DROP TABLE IF EXISTS lecturer_payout_transfers");
  await run("DROP TABLE IF EXISTS lecturer_payout_accounts");
  await run(`
    CREATE TABLE lecturer_payout_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lecturer_username TEXT NOT NULL UNIQUE,
      bank_name TEXT NOT NULL,
      bank_code TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_last4 TEXT NOT NULL,
      account_number_encrypted TEXT NOT NULL,
      recipient_code TEXT NOT NULL UNIQUE
    )
  `);

  await initDatabase();

  const payoutAccountColumns = await all("PRAGMA table_info(lecturer_payout_accounts)");
  expect(payoutAccountColumns.some((column) => column.name === "recipient_type")).toBe(true);
  expect(payoutAccountColumns.some((column) => column.name === "recipient_status")).toBe(true);
  expect(payoutAccountColumns.some((column) => column.name === "last_provider_response_json")).toBe(true);

  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const response = await postJson(teacher, "/api/lecturer/payout-account", {
    bankName: "Bank 777",
    bankCode: "777",
    accountName: "Lecturer One",
    accountNumber: "1234567890",
    autoPayoutEnabled: true,
    reviewRequired: false,
  });

  expect(response.status).toBe(200);
  expect(response.body.account.bank_code).toBe("777");
});

test("student cannot access lecturer payout endpoints", async () => {
  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const summaryResponse = await student.get("/api/lecturer/payout-summary");
  expect(summaryResponse.status).toBe(302);
  const historyResponse = await student.get("/api/lecturer/payout-history");
  expect(historyResponse.status).toBe(302);
});

test("payout request validation rejects low amounts and duplicate requests are prevented", async () => {
  const { teacher, row } = await createApprovedPayoutBalance({ title: "Manual Payout Fee", amount: 47000 });

  await postJson(teacher, "/api/lecturer/payout-account", {
    bankName: "Bank 999",
    bankCode: "999",
    accountName: "Lecturer One",
    accountNumber: "1234567890",
    autoPayoutEnabled: false,
    reviewRequired: false,
  });

  const webhookPayload = {
    id: "evt-paystack-payout-001",
    event: "charge.success",
    data: {
      id: 900001,
      reference: "PSTK-PAYOUT-001",
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
        payment_item_id: Number(row.payment_item_id || 0),
        obligation_id: Number(row.obligation_id || 0),
        payment_reference: row.my_reference,
      },
    },
  };
  const signed = signPaystackPayload(webhookPayload);
  const webhookResponse = await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signed.signature)
    .send(signed.rawBody);
  expect(webhookResponse.status).toBe(200);
  expect(webhookResponse.body.ok).toBe(true);

  const ledgerRows = await all(
    "SELECT id, status, payout_transfer_id FROM lecturer_payout_ledger ORDER BY id ASC"
  );
  expect(ledgerRows).toHaveLength(1);
  expect(ledgerRows[0].status).toBe("available");

  const lowAmount = await postJson(teacher, "/api/lecturer/payout-request", { amount: 1 });
  expect(lowAmount.status).toBe(400);

  const firstRequest = await postJson(teacher, "/api/lecturer/payout-request", {});
  expect(firstRequest.status).toBe(200);
  expect(firstRequest.body.activeTransfer).toBeTruthy();
  expect(firstRequest.body.activeTransfer.status).toBe("queued");

  const duplicateRequest = await postJson(teacher, "/api/lecturer/payout-request", {});
  expect(duplicateRequest.status).toBe(200);
  expect(duplicateRequest.body.alreadyQueued).toBe(true);
  expect(duplicateRequest.body.activeTransfer.id).toBe(firstRequest.body.activeTransfer.id);

  const transferRows = await all("SELECT id, status FROM lecturer_payout_transfers ORDER BY id ASC");
  expect(transferRows).toHaveLength(1);
});

test("transfer webhook rejects invalid signatures and can finalize a payout", async () => {
  const { teacher, row } = await createApprovedPayoutBalance({ title: "Transfer Webhook Fee", amount: 52000 });

  await postJson(teacher, "/api/lecturer/payout-account", {
    bankName: "Bank 888",
    bankCode: "888",
    accountName: "Lecturer One",
    accountNumber: "1234567890",
    autoPayoutEnabled: false,
    reviewRequired: false,
  });

  const webhookPayload = {
    id: "evt-paystack-payout-002",
    event: "charge.success",
    data: {
      id: 900002,
      reference: "PSTK-PAYOUT-002",
      amount: 5200000,
      paid_at: "2026-02-23T11:10:00Z",
      customer: {
        email: "std_001@paytec.local",
        first_name: "Std",
        last_name: "One",
      },
      metadata: {
        tenant: "default-school",
        school_id: "default-school",
        student_username: "std_001",
        payment_item_id: Number(row.payment_item_id || 0),
        obligation_id: Number(row.obligation_id || 0),
        payment_reference: row.my_reference,
      },
    },
  };
  const signed = signPaystackPayload(webhookPayload);
  await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signed.signature)
    .send(signed.rawBody);

  const firstPayout = await postJson(teacher, "/api/lecturer/payout-request", {});
  expect(firstPayout.status).toBe(200);
  const transferReference = firstPayout.body.activeTransfer.transfer_reference;
  expect(transferReference).toBeTruthy();

  const invalidTransferWebhook = await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", "bad-signature")
    .send(
      JSON.stringify({
        id: "evt-transfer-invalid",
        event: "transfer.success",
        data: {
          reference: transferReference,
          transfer_code: "TRF-TEST-001",
          status: "success",
        },
      })
    );
  expect(invalidTransferWebhook.status).toBe(401);
  expect(invalidTransferWebhook.body.code).toBe("paystack_webhook_invalid_signature");

  const transferPayload = {
    id: "evt-transfer-success",
    event: "transfer.success",
    data: {
      reference: transferReference,
      transfer_code: "TRF-TEST-001",
      status: "success",
      amount: 5200000,
      currency: "NGN",
      details: {
        bank_name: "Bank 888",
        account_name: "Lecturer One",
      },
    },
  };
  const signedTransfer = signPaystackPayload(transferPayload);
  const validTransferWebhook = await request(app)
    .post("/api/payments/webhook/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signedTransfer.signature)
    .send(signedTransfer.rawBody);
  expect(validTransferWebhook.status).toBe(200);

  const transferRow = await get("SELECT status, transfer_code FROM lecturer_payout_transfers WHERE transfer_reference = ? LIMIT 1", [
    transferReference,
  ]);
  expect(transferRow.status).toBe("success");
  expect(transferRow.transfer_code).toBe("TRF-TEST-001");
});
