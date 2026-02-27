const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");

const testDataDir = path.join(__dirname, "tmp-messages-data");
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

async function clearMessageTables() {
  await run("DELETE FROM messages");
  await run("DELETE FROM message_participants");
  await run("DELETE FROM message_threads");
}

async function createThreadAs(agent, body) {
  const response = await postJson(agent, "/api/messages/threads", body);
  expect(response.status).toBe(201);
  expect(Number(response.body.threadId || 0)).toBeGreaterThan(0);
  return response.body;
}

beforeAll(async () => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });
  await initDatabase();

  await clearMessageTables();
  await run("DELETE FROM user_profiles");
  await run("DELETE FROM auth_roster");
  await run("DELETE FROM users WHERE role != 'admin'");

  const studentOneHash = await bcrypt.hash("doe", 12);
  const studentTwoHash = await bcrypt.hash("roe", 12);
  const studentThreeHash = await bcrypt.hash("kay", 12);
  const teacherHash = await bcrypt.hash("teach", 12);
  await run(
    `
      INSERT INTO auth_roster (auth_id, role, password_hash, source_file)
      VALUES
        ('std_001', 'student', ?, 'tests'),
        ('std_002', 'student', ?, 'tests'),
        ('std_003', 'student', ?, 'tests'),
        ('teach_001', 'teacher', ?, 'tests')
    `,
    [studentOneHash, studentTwoHash, studentThreeHash, teacherHash]
  );
});

beforeEach(async () => {
  await clearMessageTables();
});

afterAll(async () => {
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("authorization by role for thread creation", async () => {
  const unauthPage = await request(app).get("/messages");
  expect(unauthPage.status).toBe(302);
  const legacyPathRedirect = await request(app).get("/messages.html");
  expect(legacyPathRedirect.status).toBe(302);

  const student = request.agent(app);
  await login(student, "std_001", "doe");
  const denied = await postJson(student, "/api/messages/threads", {
    subject: "Question",
    recipients: ["std_002"],
    message: "Can I start a direct message?",
  });
  expect(denied.status).toBe(403);

  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const teacherCreate = await postJson(teacher, "/api/messages/threads", {
    subject: "Fee reminder",
    recipients: ["std_001", "std_002"],
    message: "Please pay before Friday.",
  });
  expect(teacherCreate.status).toBe(201);
  expect(Array.isArray(teacherCreate.body.participants)).toBe(true);
  const teacherDirectory = await teacher.get("/api/messages/students");
  expect(teacherDirectory.status).toBe(200);
  expect(Array.isArray(teacherDirectory.body.students)).toBe(true);

  const admin = request.agent(app);
  await login(admin, "admin", "admin-pass-123");
  const adminCreate = await postJson(admin, "/api/messages/threads", {
    subject: "Admin notice",
    recipients: ["std_003"],
    message: "This is an admin message.",
  });
  expect(adminCreate.status).toBe(201);

  const studentDirectoryDenied = await student.get("/api/messages/students");
  expect(studentDirectoryDenied.status).toBe(403);
});

test("participant scoping blocks non-participants from fetching or replying", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const created = await createThreadAs(teacher, {
    subject: "Private check-in",
    recipients: ["std_001"],
    message: "Hello std_001",
  });
  const threadId = Number(created.threadId || 0);

  const participantStudent = request.agent(app);
  await login(participantStudent, "std_001", "doe");
  const participantView = await participantStudent.get(`/api/messages/threads/${threadId}`);
  expect(participantView.status).toBe(200);
  expect(participantView.body.thread.id).toBe(threadId);

  const outsiderStudent = request.agent(app);
  await login(outsiderStudent, "std_002", "roe");
  const blockedView = await outsiderStudent.get(`/api/messages/threads/${threadId}`);
  expect(blockedView.status).toBe(403);

  const blockedReply = await postJson(outsiderStudent, `/api/messages/threads/${threadId}/messages`, {
    message: "I should not send this",
  });
  expect(blockedReply.status).toBe(403);
});

test("validation rejects invalid message payloads and ids", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");

  const emptyMessage = await postJson(teacher, "/api/messages/threads", {
    subject: "Empty body",
    recipients: ["std_001"],
    message: "",
  });
  expect(emptyMessage.status).toBe(400);

  const longBody = "a".repeat(4001);
  const longMessage = await postJson(teacher, "/api/messages/threads", {
    subject: "Long body",
    recipients: ["std_001"],
    message: longBody,
  });
  expect(longMessage.status).toBe(400);

  const invalidRecipients = await postJson(teacher, "/api/messages/threads", {
    subject: "Bad recipients",
    recipients: ["teach_001", "invalid username"],
    message: "Hello",
  });
  expect(invalidRecipients.status).toBe(400);

  const invalidGet = await teacher.get("/api/messages/threads/abc");
  expect(invalidGet.status).toBe(400);

  const invalidReply = await postJson(teacher, "/api/messages/threads/0/messages", {
    message: "No thread",
  });
  expect(invalidReply.status).toBe(400);

  const invalidRead = await postJson(teacher, "/api/messages/threads/-2/read", {});
  expect(invalidRead.status).toBe(400);
});

test("basic response shapes for messaging endpoints", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const created = await createThreadAs(teacher, {
    subject: "Shape test",
    recipients: ["std_001", "std_002"],
    message: "Initial shape-check message",
  });
  const threadId = Number(created.threadId || 0);

  const listResponse = await teacher.get("/api/messages/threads");
  expect(listResponse.status).toBe(200);
  expect(Array.isArray(listResponse.body.threads)).toBe(true);
  expect(listResponse.body).toHaveProperty("unread");

  const detailResponse = await teacher.get(`/api/messages/threads/${threadId}`);
  expect(detailResponse.status).toBe(200);
  expect(detailResponse.body).toHaveProperty("thread");
  expect(Array.isArray(detailResponse.body.participants)).toBe(true);
  expect(Array.isArray(detailResponse.body.messages)).toBe(true);

  const replyResponse = await postJson(teacher, `/api/messages/threads/${threadId}/messages`, {
    message: "Second message",
  });
  expect(replyResponse.status).toBe(201);
  expect(replyResponse.body).toHaveProperty("message");
  expect(Number(replyResponse.body.message.id || 0)).toBeGreaterThan(0);

  const readResponse = await postJson(teacher, `/api/messages/threads/${threadId}/read`, {});
  expect(readResponse.status).toBe(200);
  expect(readResponse.body.ok).toBe(true);
  expect(readResponse.body).toHaveProperty("unread");

  const unreadResponse = await teacher.get("/api/messages/unread-count");
  expect(unreadResponse.status).toBe(200);
  expect(unreadResponse.body).toHaveProperty("unread_threads");
  expect(unreadResponse.body).toHaveProperty("unread_messages");
});

test("read and unread count behavior updates as threads are read and replied", async () => {
  const teacher = request.agent(app);
  await login(teacher, "teach_001", "teach");
  const created = await createThreadAs(teacher, {
    subject: "Read state",
    recipients: ["std_001"],
    message: "Please confirm receipt.",
  });
  const threadId = Number(created.threadId || 0);

  const student = request.agent(app);
  await login(student, "std_001", "doe");

  const beforeRead = await student.get("/api/messages/unread-count");
  expect(beforeRead.status).toBe(200);
  expect(Number(beforeRead.body.unread_threads || 0)).toBe(1);
  expect(Number(beforeRead.body.unread_messages || 0)).toBe(1);

  const markRead = await postJson(student, `/api/messages/threads/${threadId}/read`, {});
  expect(markRead.status).toBe(200);

  const afterRead = await student.get("/api/messages/unread-count");
  expect(afterRead.status).toBe(200);
  expect(Number(afterRead.body.unread_threads || 0)).toBe(0);
  expect(Number(afterRead.body.unread_messages || 0)).toBe(0);

  const teacherReply = await postJson(teacher, `/api/messages/threads/${threadId}/messages`, {
    message: "Following up on this message.",
  });
  expect(teacherReply.status).toBe(201);

  const afterTeacherReply = await student.get("/api/messages/unread-count");
  expect(afterTeacherReply.status).toBe(200);
  expect(Number(afterTeacherReply.body.unread_threads || 0)).toBe(1);
  expect(Number(afterTeacherReply.body.unread_messages || 0)).toBe(1);

  const studentReply = await postJson(student, `/api/messages/threads/${threadId}/messages`, {
    message: "Noted, I have seen this.",
  });
  expect(studentReply.status).toBe(201);

  const afterStudentReply = await student.get("/api/messages/unread-count");
  expect(afterStudentReply.status).toBe(200);
  expect(Number(afterStudentReply.body.unread_threads || 0)).toBe(0);
  expect(Number(afterStudentReply.body.unread_messages || 0)).toBe(0);
});
