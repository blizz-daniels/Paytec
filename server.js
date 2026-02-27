const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const bcrypt = require("bcryptjs");
const express = require("express");
const multer = require("multer");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const SQLiteStore = require("connect-sqlite3")(session);
const { createPaystackClient } = require("./services/paystack");
const {
  generateApprovedStudentReceipts,
} = require("./services/approved-receipt-generator");
let xlsx = null;
try {
  xlsx = require("xlsx");
} catch (_err) {
  xlsx = null;
}

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";
const defaultDataDir = isProduction ? "/tmp/paytec" : path.join(__dirname, "data");
const dataDir = path.resolve(process.env.DATA_DIR || defaultDataDir);
const dbPath = path.join(dataDir, "paytec.sqlite");
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STUDENT_ROSTER_PATH = path.resolve(process.env.STUDENT_ROSTER_PATH || path.join(__dirname, "data", "students.csv"));
const LECTURER_ROSTER_PATH = path.resolve(
  process.env.LECTURER_ROSTER_PATH || process.env.TEACHER_ROSTER_PATH || path.join(__dirname, "data", "teachers.csv")
);

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required when NODE_ENV=production");
}
if (isProduction && !ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORD is required when NODE_ENV=production");
}

fs.mkdirSync(dataDir, { recursive: true });

const usersDir = path.join(dataDir, "users");
fs.mkdirSync(usersDir, { recursive: true });
const receiptsDir = path.join(dataDir, "receipts");
fs.mkdirSync(receiptsDir, { recursive: true });
const approvedReceiptsDir = path.resolve(process.env.RECEIPT_OUTPUT_DIR || path.join(__dirname, "outputs", "receipts"));
fs.mkdirSync(approvedReceiptsDir, { recursive: true });
const RECEIPT_LEGACY_FALLBACK_MAX_BYTES = Number.parseInt(
  String(process.env.RECEIPT_LEGACY_FALLBACK_MAX_BYTES || "1500"),
  10
);
const statementsDir = path.join(dataDir, "statements");
fs.mkdirSync(statementsDir, { recursive: true });
const contentFilesDir = path.join(dataDir, "content-files");
fs.mkdirSync(contentFilesDir, { recursive: true });
const handoutsFilesDir = path.join(contentFilesDir, "handouts");
fs.mkdirSync(handoutsFilesDir, { recursive: true });
const sharedFilesUploadDir = path.join(contentFilesDir, "shared");
fs.mkdirSync(sharedFilesUploadDir, { recursive: true });

const allowedAvatarMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedAvatarExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const allowedReceiptMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const allowedReceiptExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
const allowedStatementMimeTypes = new Set([
  "text/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "text/tab-separated-values",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/rtf",
  "application/octet-stream",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const allowedStatementExtensions = new Set([
  ".csv",
  ".txt",
  ".tsv",
  ".json",
  ".xml",
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".xls",
  ".xlsx",
  ".doc",
  ".docx",
  ".rtf",
]);
const allowedHandoutMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const allowedHandoutExtensions = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx"]);
const allowedSharedMimeTypes = new Set([
  "image/png",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
const allowedSharedExtensions = new Set([".png", ".mp4", ".webm", ".mov"]);
const allowedNotificationReactions = new Set(["like", "love", "haha", "wow", "sad"]);
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 8;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map();
let contentStreamClientSequence = 0;
const contentStreamClients = new Map();
const CONTENT_STREAM_KEEPALIVE_MS = 25 * 1000;
const execFileAsync = promisify(execFile);
const OCR_PROVIDER = String(process.env.OCR_PROVIDER || "none").trim().toLowerCase();
const OCR_SPACE_API_KEY = String(process.env.OCR_SPACE_API_KEY || "").trim();
const OCR_SPACE_ENDPOINT = String(process.env.OCR_SPACE_ENDPOINT || "https://api.ocr.space/parse/image").trim();
const STATEMENT_PARSER_PROVIDER = String(process.env.STATEMENT_PARSER_PROVIDER || "none").trim().toLowerCase();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_API_BASE_URL = String(process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/$/, "");
const OPENAI_STATEMENT_MODEL = String(process.env.OPENAI_STATEMENT_MODEL || "gpt-4o-mini").trim();
const GATEWAY_WEBHOOK_SECRET = String(process.env.GATEWAY_WEBHOOK_SECRET || "").trim();
const PAYSTACK_SECRET_KEY = String(process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_PUBLIC_KEY = String(process.env.PAYSTACK_PUBLIC_KEY || "").trim();
const PAYSTACK_WEBHOOK_SECRET = String(process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET_KEY).trim();
const PAYSTACK_CALLBACK_URL = String(process.env.PAYSTACK_CALLBACK_URL || "").trim();
const PAYMENT_REFERENCE_PREFIX = String(process.env.PAYMENT_REFERENCE_PREFIX || "PAYTEC").trim().toUpperCase();
const PAYMENT_REFERENCE_TENANT_ID = String(
  process.env.PAYMENT_REFERENCE_TENANT_ID || process.env.SCHOOL_ID || process.env.TENANT_ID || "default-school"
)
  .trim()
  .toLowerCase();
const AUTO_RECONCILE_CONFIDENCE = Number.parseFloat(String(process.env.AUTO_RECONCILE_CONFIDENCE || "0.9"));
const REVIEW_RECONCILE_CONFIDENCE = Number.parseFloat(String(process.env.REVIEW_RECONCILE_CONFIDENCE || "0.65"));
const PAYSTACK_SOURCE = "paystack";
const paystackClient = createPaystackClient({
  secretKey: PAYSTACK_SECRET_KEY,
});
if (isProduction) {
  const requiredPaystackEnv = [
    ["PAYSTACK_SECRET_KEY", PAYSTACK_SECRET_KEY],
    ["PAYSTACK_PUBLIC_KEY", PAYSTACK_PUBLIC_KEY],
    ["PAYSTACK_CALLBACK_URL", PAYSTACK_CALLBACK_URL],
  ];
  const missingPaystackEnv = requiredPaystackEnv.filter(([, value]) => !value).map(([key]) => key);
  if (missingPaystackEnv.length) {
    console.warn(
      `[startup] Missing Paystack env var(s): ${missingPaystackEnv.join(
        ", "
      )}. Paystack endpoints will remain unavailable until configured.`
    );
  }
}

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: usersDir,
    filename(req, file, cb) {
      const username = String(req.session?.user?.username || "user").replace(/[^\w-]/g, "");
      const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
      const safeExt = allowedAvatarExtensions.has(ext) ? ext : ".png";
      cb(null, `${username}${safeExt}`);
    },
  }),
  fileFilter(_req, file, cb) {
    if (allowedAvatarMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only PNG, JPEG, and WEBP files are allowed."));
  },
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: receiptsDir,
    filename(req, file, cb) {
      const username = String(req.session?.user?.username || "user").replace(/[^\w-]/g, "").slice(0, 40) || "user";
      const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
      const safeExt = allowedReceiptExtensions.has(ext) ? ext : ".bin";
      const suffix = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
      cb(null, `${username}-${suffix}${safeExt}`);
    },
  }),
  fileFilter(_req, file, cb) {
    if (allowedReceiptMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only JPG, PNG, WEBP, and PDF receipts are allowed."));
  },
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const statementUpload = multer({
  storage: multer.diskStorage({
    destination: statementsDir,
    filename(req, file, cb) {
      const teacher = String(req.session?.user?.username || "teacher").replace(/[^\w-]/g, "").slice(0, 40) || "teacher";
      const ext = path.extname(file.originalname || "").toLowerCase() || ".csv";
      const safeExt = allowedStatementExtensions.has(ext) ? ext : ".csv";
      const suffix = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
      cb(null, `${teacher}-${suffix}${safeExt}`);
    },
  }),
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowedStatementMimeTypes.has(file.mimetype) || allowedStatementExtensions.has(ext)) {
      cb(null, true);
      return;
    }
    cb(
      new Error(
        "Only CSV, TXT, TSV, JSON, XML, PDF, JPG, PNG, WEBP, XLS/XLSX, DOC/DOCX, and RTF statement files are allowed."
      )
    );
  },
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const handoutUpload = multer({
  storage: multer.diskStorage({
    destination: handoutsFilesDir,
    filename(req, file, cb) {
      const teacher = String(req.session?.user?.username || "teacher").replace(/[^\w-]/g, "").slice(0, 40) || "teacher";
      const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
      const safeExt = allowedHandoutExtensions.has(ext) ? ext : ".bin";
      const suffix = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
      cb(null, `${teacher}-${suffix}${safeExt}`);
    },
  }),
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowedHandoutMimeTypes.has(file.mimetype) || allowedHandoutExtensions.has(ext)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only PDF, Word, and Excel files are allowed for handouts."));
  },
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

const sharedFileUpload = multer({
  storage: multer.diskStorage({
    destination: sharedFilesUploadDir,
    filename(req, file, cb) {
      const teacher = String(req.session?.user?.username || "teacher").replace(/[^\w-]/g, "").slice(0, 40) || "teacher";
      const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
      const safeExt = allowedSharedExtensions.has(ext) ? ext : ".bin";
      const suffix = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
      cb(null, `${teacher}-${suffix}${safeExt}`);
    },
  }),
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowedSharedMimeTypes.has(file.mimetype) || allowedSharedExtensions.has(ext)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only PNG images and MP4/WEBM/MOV videos are allowed for shared files."));
  },
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});
const db = new sqlite3.Database(dbPath);

function resolveStoredContentPath(relativeUrl) {
  if (!relativeUrl || typeof relativeUrl !== "string") {
    return null;
  }
  const normalized = relativeUrl.replace(/\\/g, "/");
  if (!normalized.startsWith("/content-files/")) {
    return null;
  }
  const relativePath = normalized.slice("/content-files/".length);
  const absolute = path.resolve(contentFilesDir, relativePath);
  const relativeCheck = path.relative(contentFilesDir, absolute);
  if (!relativeCheck || relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    return null;
  }
  return absolute;
}

function isPathInsideDirectory(baseDir, candidatePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(String(candidatePath || ""));
  const relativeCheck = path.relative(resolvedBase, resolvedCandidate);
  return relativeCheck === "" || (!relativeCheck.startsWith("..") && !path.isAbsolute(relativeCheck));
}

function isLikelyLegacyPlainReceipt(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const threshold = Number.isFinite(RECEIPT_LEGACY_FALLBACK_MAX_BYTES)
      ? Math.max(400, RECEIPT_LEGACY_FALLBACK_MAX_BYTES)
      : 1500;
    return stat.isFile() && stat.size > 0 && stat.size <= threshold;
  } catch (_err) {
    return false;
  }
}

function removeStoredContentFile(relativeUrl) {
  const absolutePath = resolveStoredContentPath(relativeUrl);
  if (!absolutePath) {
    return;
  }
  fs.unlink(absolutePath, () => {});
}

function parseReactionDetails(detailsString) {
  if (!detailsString) {
    return [];
  }
  return String(detailsString)
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => {
      const [username, reaction] = entry.split("|");
      return {
        username: String(username || "").trim(),
        reaction: String(reaction || "").trim(),
      };
    })
    .filter((item) => item.username && item.reaction);
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

async function runMigrationSql(sql, params = []) {
  try {
    return await run(sql, params);
  } catch (err) {
    const message = String(err?.message || "");
    if (
      /duplicate column name/i.test(message) ||
      /already exists/i.test(message) ||
      /no such column/i.test(message) ||
      /UNIQUE constraint failed/i.test(message)
    ) {
      return null;
    }
    throw err;
  }
}

async function withSqlTransaction(work) {
  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const result = await work();
    await run("COMMIT");
    return result;
  } catch (err) {
    try {
      await run("ROLLBACK");
    } catch (_rollbackErr) {
      // ignore
    }
    throw err;
  }
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSurnamePassword(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidIdentifier(value) {
  return /^[a-z0-9/_-]{3,40}$/.test(value);
}

function isValidSurnamePassword(value) {
  return /^[a-z][a-z' -]{1,39}$/.test(value);
}

function normalizeDisplayName(value) {
  return String(value || "").trim();
}

function normalizeProfileEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidProfileEmail(value) {
  const normalized = normalizeProfileEmail(value);
  if (!normalized || normalized.length > 254) {
    return false;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized)) {
    return false;
  }
  const domain = String(normalized.split("@")[1] || "");
  if (!domain || domain === "localhost" || domain.endsWith(".local")) {
    return false;
  }
  return true;
}

function resolvePaystackCheckoutEmail(username, profileEmail) {
  const candidates = [profileEmail, username];
  for (const candidate of candidates) {
    const normalized = normalizeProfileEmail(candidate);
    if (isValidProfileEmail(normalized)) {
      return normalized;
    }
  }
  return "";
}

function getClientIp(req) {
  return String(req.ip || req.headers["x-forwarded-for"] || "unknown").trim();
}

function getLoginRateLimitKey(req, identifier) {
  return `${getClientIp(req)}::${String(identifier || "*")}`;
}

function getLoginAttemptRecord(key, now = Date.now()) {
  const existing = loginAttempts.get(key);
  if (!existing) {
    return {
      attempts: 0,
      windowStartedAt: now,
      blockedUntil: 0,
    };
  }
  if (existing.windowStartedAt + LOGIN_RATE_LIMIT_WINDOW_MS <= now) {
    existing.attempts = 0;
    existing.windowStartedAt = now;
  }
  return existing;
}

function isLoginRateLimited(req, identifier) {
  const now = Date.now();
  const key = getLoginRateLimitKey(req, identifier);
  const record = getLoginAttemptRecord(key, now);
  loginAttempts.set(key, record);
  return record.blockedUntil > now;
}

function recordFailedLogin(req, identifier) {
  const now = Date.now();
  const key = getLoginRateLimitKey(req, identifier);
  const record = getLoginAttemptRecord(key, now);
  record.attempts += 1;
  if (record.attempts >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS) {
    record.blockedUntil = now + LOGIN_RATE_LIMIT_BLOCK_MS;
    record.attempts = 0;
    record.windowStartedAt = now;
  }
  loginAttempts.set(key, record);
}

function clearFailedLogins(req, identifier) {
  const exactKey = getLoginRateLimitKey(req, identifier);
  const wildcardKey = getLoginRateLimitKey(req, "*");
  loginAttempts.delete(exactKey);
  loginAttempts.delete(wildcardKey);
}

function ensureCsrfToken(req) {
  if (!req.session) {
    return "";
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

function isSameToken(expected, provided) {
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");
  const providedBuffer = Buffer.from(String(provided || ""), "utf8");
  if (!expectedBuffer.length || expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function isTrustedPaystackInternalVerifyRequest(req) {
  const configuredSecret = String(GATEWAY_WEBHOOK_SECRET || PAYSTACK_WEBHOOK_SECRET || "").trim();
  const providedSecret = String(req.get("x-paytec-webhook-secret") || req.get("x-webhook-secret") || "").trim();
  if (!configuredSecret || !providedSecret) {
    return false;
  }
  return isSameToken(configuredSecret, providedSecret);
}

function rejectCsrf(req, res) {
  if (req.accepts("json")) {
    return res.status(403).json({ error: "Invalid CSRF token." });
  }
  return res.status(403).send("Invalid CSRF token.");
}

function requireCsrf(req, res, next) {
  if (CSRF_SAFE_METHODS.has(req.method)) {
    return next();
  }
  if (req.path === "/api/payments/webhook" || req.path === "/api/payments/webhook/paystack") {
    return next();
  }
  if (req.path === "/api/payments/paystack/verify" && isTrustedPaystackInternalVerifyRequest(req)) {
    return next();
  }
  const expectedToken = req.session ? req.session.csrfToken : "";
  const requestToken = req.get("x-csrf-token") || req.body?._csrf;
  if (!expectedToken || !requestToken || !isSameToken(expectedToken, requestToken)) {
    return rejectCsrf(req, res);
  }
  return next();
}

function removeContentStreamClient(clientId) {
  const client = contentStreamClients.get(clientId);
  if (!client) {
    return;
  }
  if (client.keepAliveTimer) {
    clearInterval(client.keepAliveTimer);
  }
  contentStreamClients.delete(clientId);
}

function writeContentStreamEvent(res, eventName, payload) {
  if (!res || res.writableEnded) {
    return;
  }
  const safeEventName = String(eventName || "message").replace(/[\r\n]/g, "");
  const safePayload = payload && typeof payload === "object" ? payload : {};
  res.write(`event: ${safeEventName}\n`);
  res.write(`data: ${JSON.stringify(safePayload)}\n\n`);
}

function broadcastContentUpdate(kind, action, metadata = {}, options = {}) {
  const audience = String(options.audience || "all")
    .trim()
    .toLowerCase();
  const payload = {
    kind: String(kind || "unknown")
      .trim()
      .toLowerCase() || "unknown",
    action: String(action || "updated")
      .trim()
      .toLowerCase() || "updated",
    at: new Date().toISOString(),
    ...(metadata && typeof metadata === "object" ? metadata : {}),
  };

  for (const [clientId, client] of contentStreamClients.entries()) {
    if (!client || !client.res || client.res.writableEnded) {
      removeContentStreamClient(clientId);
      continue;
    }
    if (audience !== "all" && client.role !== audience) {
      continue;
    }
    try {
      writeContentStreamEvent(client.res, "content:update", payload);
    } catch (_err) {
      removeContentStreamClient(clientId);
    }
  }
}

function deriveDisplayNameFromIdentifier(identifier) {
  const parts = String(identifier || "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) {
    return identifier;
  }
  return parts
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

async function importRoster(filePath, role, idHeader) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return importRosterCsvText(raw, role, idHeader, path.basename(filePath));
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildImportReportCsv(results) {
  const header = ["line_number", "identifier", "status", "message"];
  const lines = [header.join(",")];
  results.forEach((result) => {
    lines.push(
      [
        escapeCsvValue(result.lineNumber),
        escapeCsvValue(result.identifier),
        escapeCsvValue(result.status),
        escapeCsvValue(result.message),
      ].join(",")
    );
  });
  return lines.join("\n");
}

async function processRosterCsv(csvText, options) {
  const { role, idHeader, sourceName, applyChanges } = options;
  const raw = String(csvText || "");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 1) {
    throw new Error("CSV is empty.");
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const idIndex = headers.indexOf(idHeader);
  const surnameIndex = headers.indexOf("surname");
  const preferredNameColumns = ["name", "full_name", "display_name", "student_name"];
  const nameIndex =
    preferredNameColumns.reduce((foundIndex, candidate) => {
      if (foundIndex !== -1) {
        return foundIndex;
      }
      return headers.indexOf(candidate);
    }, -1);

  if (idIndex === -1 || surnameIndex === -1) {
    throw new Error(`Invalid roster header. Expected columns: ${idHeader},surname`);
  }

  const existingRows = await all("SELECT auth_id FROM auth_roster WHERE role = ?", [role]);
  const existingIds = new Set(existingRows.map((row) => normalizeIdentifier(row.auth_id)));
  const seenInFile = new Set();
  const results = [];
  const summary = {
    totalRows: Math.max(0, lines.length - 1),
    validRows: 0,
    invalidRows: 0,
    duplicateRows: 0,
    inserts: 0,
    updates: 0,
    imported: 0,
  };

  for (let i = 1; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const row = parseCsvLine(lines[i]);
    const identifier = normalizeIdentifier(row[idIndex]);
    const surnamePassword = normalizeSurnamePassword(row[surnameIndex]);
    const rawDisplayName = nameIndex !== -1 ? normalizeDisplayName(row[nameIndex]) : "";

    if (!isValidIdentifier(identifier)) {
      summary.invalidRows += 1;
      results.push({
        lineNumber,
        identifier,
        status: "error",
        message: `Invalid ${idHeader}. Use 3-40 chars: letters, numbers, /, _, -.`,
      });
      continue;
    }

    if (seenInFile.has(identifier)) {
      summary.invalidRows += 1;
      summary.duplicateRows += 1;
      results.push({
        lineNumber,
        identifier,
        status: "duplicate_in_file",
        message: `Duplicate ${idHeader} in this upload.`,
      });
      continue;
    }
    seenInFile.add(identifier);

    if (!isValidSurnamePassword(surnamePassword)) {
      summary.invalidRows += 1;
      results.push({
        lineNumber,
        identifier,
        status: "error",
        message: "Invalid surname password format.",
      });
      continue;
    }

    const exists = existingIds.has(identifier);
    const result = {
      lineNumber,
      identifier,
      status: exists ? "update" : "insert",
      message: exists ? "Will update existing account." : "Will create new account.",
    };

    if (applyChanges) {
      const passwordHash = await bcrypt.hash(surnamePassword, 12);
      await run(
        `
          INSERT INTO auth_roster (auth_id, role, password_hash, source_file)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(auth_id, role) DO UPDATE SET
            password_hash = excluded.password_hash,
            source_file = excluded.source_file
        `,
        [identifier, role, passwordHash, sourceName]
      );
      if (rawDisplayName) {
        await upsertProfileDisplayName(identifier, rawDisplayName);
      }
      result.message = exists ? "Updated existing account." : "Created new account.";
    }

    if (exists) {
      summary.updates += 1;
    } else {
      summary.inserts += 1;
      existingIds.add(identifier);
    }
    summary.validRows += 1;
    summary.imported += 1;
    results.push(result);
  }

  return {
    role,
    summary,
    rows: results,
    reportCsv: buildImportReportCsv(results),
  };
}

async function importRosterCsvText(csvText, role, idHeader, sourceName) {
  if (!String(csvText || "").trim()) {
    return 0;
  }
  const result = await processRosterCsv(csvText, {
    role,
    idHeader,
    sourceName,
    applyChanges: true,
  });
  return result.summary.imported;
}

async function upsertProfileDisplayName(username, displayName) {
  if (!displayName) {
    return;
  }
  await run(
    `
      INSERT INTO user_profiles (username, display_name, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        updated_at = CURRENT_TIMESTAMP
    `,
    [username, displayName]
  );
}

async function upsertProfileEmail(username, email) {
  if (!email) {
    return;
  }
  const normalizedEmail = normalizeProfileEmail(email);
  if (!isValidProfileEmail(normalizedEmail)) {
    return;
  }
  const profile = await getUserProfile(username);
  const displayName =
    profile && profile.display_name ? profile.display_name : deriveDisplayNameFromIdentifier(username);

  await run(
    `
      INSERT INTO user_profiles (username, display_name, email, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(username) DO UPDATE SET
        email = excluded.email,
        updated_at = CURRENT_TIMESTAMP,
        display_name = COALESCE(user_profiles.display_name, excluded.display_name)
    `,
    [username, displayName, normalizedEmail]
  );
}

async function upsertProfileImage(username, imageUrl) {
  if (!imageUrl) {
    return;
  }
  const profile = await getUserProfile(username);
  const displayName =
    profile && profile.display_name ? profile.display_name : deriveDisplayNameFromIdentifier(username);

  await run(
    `
      INSERT INTO user_profiles (username, display_name, profile_image_url, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(username) DO UPDATE SET
        profile_image_url = excluded.profile_image_url,
        updated_at = CURRENT_TIMESTAMP,
        display_name = COALESCE(user_profiles.display_name, excluded.display_name)
    `,
    [username, displayName, imageUrl]
  );
}

async function getUserProfile(username) {
  return get(
    `
      SELECT display_name, nickname, profile_image_url, email
      FROM user_profiles
      WHERE username = ?
    `,
    [username]
  );
}

async function initDatabase() {
  await run("PRAGMA foreign_keys = ON");

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS auth_roster (
      auth_id TEXT NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      source_file TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (auth_id, role)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS login_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      source TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      logged_in_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      is_urgent INTEGER NOT NULL DEFAULT 0,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      related_payment_item_id INTEGER,
      auto_generated INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
 
  await run(`
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (notification_id, username)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notification_reactions (
      notification_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      reaction TEXT NOT NULL,
      reacted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (notification_id, username)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS handout_reactions (
      handout_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      reaction TEXT NOT NULL,
      reacted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (handout_id, username)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS shared_file_reactions (
      shared_file_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      reaction TEXT NOT NULL,
      reacted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (shared_file_id, username)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS handouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      file_url TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS shared_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      file_url TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS message_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS message_participants (
      thread_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_read_message_id INTEGER,
      last_read_at TEXT,
      PRIMARY KEY (thread_id, username),
      FOREIGN KEY (thread_id) REFERENCES message_threads(id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      sender_username TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES message_threads(id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      expected_amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN',
      due_date TEXT,
      available_until TEXT,
      availability_days INTEGER,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS teacher_payment_statements (
      teacher_username TEXT PRIMARY KEY,
      original_filename TEXT NOT NULL,
      statement_file_path TEXT NOT NULL,
      parsed_rows_json TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payment_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_item_id INTEGER NOT NULL,
      student_username TEXT NOT NULL,
      amount_paid REAL NOT NULL,
      paid_at TEXT NOT NULL,
      transaction_ref TEXT NOT NULL UNIQUE,
      receipt_file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assigned_reviewer TEXT,
      assigned_at TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      rejection_reason TEXT,
      verification_notes TEXT,
      extracted_text TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payment_receipt_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL,
      actor_username TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS approved_receipt_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_receipt_id INTEGER NOT NULL UNIQUE,
      student_username TEXT NOT NULL,
      receipt_generated_at TEXT,
      receipt_sent_at TEXT,
      receipt_file_path TEXT,
      receipt_sent INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (payment_receipt_id) REFERENCES payment_receipts(id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payment_obligations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_item_id INTEGER NOT NULL,
      student_username TEXT NOT NULL,
      expected_amount REAL NOT NULL,
      due_date TEXT,
      payment_reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid',
      amount_paid_total REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(payment_item_id, student_username),
      UNIQUE(payment_reference),
      FOREIGN KEY (payment_item_id) REFERENCES payment_items(id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txn_ref TEXT,
      amount REAL NOT NULL,
      paid_at TEXT NOT NULL,
      payer_name TEXT,
      source TEXT NOT NULL,
      source_event_id TEXT UNIQUE,
      source_file_name TEXT,
      normalized_txn_ref TEXT,
      normalized_paid_date TEXT,
      normalized_payer_name TEXT,
      student_hint_username TEXT,
      payment_item_hint_id INTEGER,
      checksum TEXT,
      raw_payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'unmatched',
      matched_obligation_id INTEGER,
      confidence REAL NOT NULL DEFAULT 0,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (matched_obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (payment_item_hint_id) REFERENCES payment_items(id) ON UPDATE CASCADE ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS paystack_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      obligation_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      gateway_reference TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'initiated',
      init_payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS paystack_reference_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_username TEXT NOT NULL,
      obligation_id INTEGER,
      reference TEXT NOT NULL,
      normalized_reference TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolved_by TEXT,
      resolved_by_role TEXT,
      FOREIGN KEY (obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payment_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      obligation_id INTEGER,
      transaction_id INTEGER NOT NULL UNIQUE,
      confidence REAL NOT NULL DEFAULT 0,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      decision TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_to TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES payment_matches(id) ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reconciliation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER,
      obligation_id INTEGER,
      actor_username TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id) ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (obligation_id) REFERENCES payment_obligations(id) ON UPDATE CASCADE ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT,
      actor_role TEXT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_receipts_student ON payment_receipts(student_username)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_receipts_status ON payment_receipts(status)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_receipts_item ON payment_receipts(payment_item_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_receipt_events_receipt ON payment_receipt_events(receipt_id)");
  await runMigrationSql(
    "CREATE INDEX IF NOT EXISTS idx_approved_receipt_dispatches_sent ON approved_receipt_dispatches(receipt_sent)"
  );
  await runMigrationSql(
    "CREATE INDEX IF NOT EXISTS idx_approved_receipt_dispatches_receipt ON approved_receipt_dispatches(payment_receipt_id)"
  );
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_obligations_student ON payment_obligations(student_username)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_obligations_item ON payment_obligations(payment_item_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_obligations_status ON payment_obligations(status)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_obligations_reference ON payment_obligations(payment_reference)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_transactions_ref ON payment_transactions(normalized_txn_ref)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_transactions_date ON payment_transactions(normalized_paid_date)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_transactions_amount ON payment_transactions(amount)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_transactions_checksum ON payment_transactions(checksum)");
  await runMigrationSql("CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transactions_source_checksum ON payment_transactions(source, checksum)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_transactions_student_hint ON payment_transactions(student_hint_username)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_transactions_item_hint ON payment_transactions(payment_item_hint_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_transactions_obligation ON payment_transactions(matched_obligation_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_paystack_sessions_obligation ON paystack_sessions(obligation_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_paystack_sessions_student ON paystack_sessions(student_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_paystack_sessions_status ON paystack_sessions(status)");
  await runMigrationSql("CREATE UNIQUE INDEX IF NOT EXISTS idx_paystack_sessions_reference ON paystack_sessions(gateway_reference)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_paystack_ref_requests_student ON paystack_reference_requests(student_username)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_paystack_ref_requests_status ON paystack_reference_requests(status)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_paystack_ref_requests_reference ON paystack_reference_requests(normalized_reference)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_matches_obligation ON payment_matches(obligation_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_matches_decision ON payment_matches(decision)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_reason ON reconciliation_exceptions(reason)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_status ON reconciliation_exceptions(status)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_reconciliation_events_tx ON reconciliation_events(transaction_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_notifications_payment_item ON notifications(related_payment_item_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_payment_items_created_by ON payment_items(created_by)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_notification_reactions_notification ON notification_reactions(notification_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_handout_reactions_handout ON handout_reactions(handout_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_shared_file_reactions_shared_file ON shared_file_reactions(shared_file_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_message_participants_user_thread ON message_participants(username, thread_id)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at)");
  await runMigrationSql("CREATE INDEX IF NOT EXISTS idx_message_threads_updated_at ON message_threads(updated_at)");

  await run(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      username TEXT PRIMARY KEY,
      display_name TEXT,
      nickname TEXT,
      profile_image_url TEXT,
      email TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_username TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content_id INTEGER,
      target_owner TEXT,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const userColumns = await all("PRAGMA table_info(users)");
  if (!userColumns.some((column) => column.name === "role")) {
    await run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student'");
  }

  const profileColumns = await all("PRAGMA table_info(user_profiles)");
  if (!profileColumns.some((column) => column.name === "email")) {
    await run("ALTER TABLE user_profiles ADD COLUMN email TEXT");
  }

  const notificationColumns = await all("PRAGMA table_info(notifications)");
  if (!notificationColumns.some((column) => column.name === "is_pinned")) {
    await run("ALTER TABLE notifications ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (!notificationColumns.some((column) => column.name === "expires_at")) {
    await run("ALTER TABLE notifications ADD COLUMN expires_at TEXT");
  }
  if (!notificationColumns.some((column) => column.name === "related_payment_item_id")) {
    await run("ALTER TABLE notifications ADD COLUMN related_payment_item_id INTEGER");
  }
  if (!notificationColumns.some((column) => column.name === "auto_generated")) {
    await run("ALTER TABLE notifications ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0");
  }
  if (!notificationColumns.some((column) => column.name === "user_id")) {
    await run("ALTER TABLE notifications ADD COLUMN user_id TEXT");
  }
  if (!notificationColumns.some((column) => column.name === "type")) {
    await run("ALTER TABLE notifications ADD COLUMN type TEXT");
  }
  if (!notificationColumns.some((column) => column.name === "payload_json")) {
    await run("ALTER TABLE notifications ADD COLUMN payload_json TEXT");
  }
  if (!notificationColumns.some((column) => column.name === "read_at")) {
    await run("ALTER TABLE notifications ADD COLUMN read_at TEXT");
  }

  const paymentItemsColumns = await all("PRAGMA table_info(payment_items)");
  if (!paymentItemsColumns.some((column) => column.name === "description")) {
    await run("ALTER TABLE payment_items ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!paymentItemsColumns.some((column) => column.name === "currency")) {
    await run("ALTER TABLE payment_items ADD COLUMN currency TEXT NOT NULL DEFAULT 'NGN'");
  }
  if (!paymentItemsColumns.some((column) => column.name === "due_date")) {
    await run("ALTER TABLE payment_items ADD COLUMN due_date TEXT");
  }
  if (!paymentItemsColumns.some((column) => column.name === "available_until")) {
    await run("ALTER TABLE payment_items ADD COLUMN available_until TEXT");
  }
  if (!paymentItemsColumns.some((column) => column.name === "availability_days")) {
    await run("ALTER TABLE payment_items ADD COLUMN availability_days INTEGER");
  }

  const paymentReceiptColumns = await all("PRAGMA table_info(payment_receipts)");
  if (!paymentReceiptColumns.some((column) => column.name === "reviewed_by")) {
    await run("ALTER TABLE payment_receipts ADD COLUMN reviewed_by TEXT");
  }
  if (!paymentReceiptColumns.some((column) => column.name === "assigned_reviewer")) {
    await run("ALTER TABLE payment_receipts ADD COLUMN assigned_reviewer TEXT");
  }
  if (!paymentReceiptColumns.some((column) => column.name === "assigned_at")) {
    await run("ALTER TABLE payment_receipts ADD COLUMN assigned_at TEXT");
  }
  if (!paymentReceiptColumns.some((column) => column.name === "reviewed_at")) {
    await run("ALTER TABLE payment_receipts ADD COLUMN reviewed_at TEXT");
  }
  if (!paymentReceiptColumns.some((column) => column.name === "rejection_reason")) {
    await run("ALTER TABLE payment_receipts ADD COLUMN rejection_reason TEXT");
  }
  if (!paymentReceiptColumns.some((column) => column.name === "verification_notes")) {
    await run("ALTER TABLE payment_receipts ADD COLUMN verification_notes TEXT");
  }
  if (!paymentReceiptColumns.some((column) => column.name === "extracted_text")) {
    await run("ALTER TABLE payment_receipts ADD COLUMN extracted_text TEXT");
  }

  const obligationColumns = await all("PRAGMA table_info(payment_obligations)");
  if (obligationColumns.length) {
    if (!obligationColumns.some((column) => column.name === "payment_reference")) {
      await run("ALTER TABLE payment_obligations ADD COLUMN payment_reference TEXT");
    }
    if (!obligationColumns.some((column) => column.name === "status")) {
      await run("ALTER TABLE payment_obligations ADD COLUMN status TEXT NOT NULL DEFAULT 'unpaid'");
    }
    if (!obligationColumns.some((column) => column.name === "amount_paid_total")) {
      await run("ALTER TABLE payment_obligations ADD COLUMN amount_paid_total REAL NOT NULL DEFAULT 0");
    }
    if (!obligationColumns.some((column) => column.name === "updated_at")) {
      await run("ALTER TABLE payment_obligations ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    }
    await run(`
      UPDATE payment_obligations
      SET payment_reference = COALESCE(NULLIF(payment_reference, ''), 'LEGACY-' || payment_item_id || '-' || student_username)
      WHERE payment_reference IS NULL OR payment_reference = ''
    `);
  }

  const transactionColumns = await all("PRAGMA table_info(payment_transactions)");
  if (transactionColumns.length) {
    if (!transactionColumns.some((column) => column.name === "checksum")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN checksum TEXT");
    }
    if (!transactionColumns.some((column) => column.name === "raw_payload_json")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN raw_payload_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!transactionColumns.some((column) => column.name === "source")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'statement_upload'");
    }
    if (!transactionColumns.some((column) => column.name === "source_event_id")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN source_event_id TEXT");
    }
    if (!transactionColumns.some((column) => column.name === "normalized_txn_ref")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN normalized_txn_ref TEXT");
    }
    if (!transactionColumns.some((column) => column.name === "normalized_paid_date")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN normalized_paid_date TEXT");
    }
    if (!transactionColumns.some((column) => column.name === "normalized_payer_name")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN normalized_payer_name TEXT");
    }
    if (!transactionColumns.some((column) => column.name === "status")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'unmatched'");
    }
    if (!transactionColumns.some((column) => column.name === "matched_obligation_id")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN matched_obligation_id INTEGER");
    }
    if (!transactionColumns.some((column) => column.name === "confidence")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN confidence REAL NOT NULL DEFAULT 0");
    }
    if (!transactionColumns.some((column) => column.name === "reasons_json")) {
      await run("ALTER TABLE payment_transactions ADD COLUMN reasons_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  // Ensure at least one admin account exists.
  const adminUser = await get("SELECT username FROM users WHERE username = ?", [ADMIN_USERNAME]);
  if (!adminUser) {
    const adminPassword = ADMIN_PASSWORD || "admin123";
    const adminHash = await bcrypt.hash(adminPassword, 12);
    await run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", [
      ADMIN_USERNAME,
      adminHash,
      "admin",
    ]);
  }

  await importRoster(STUDENT_ROSTER_PATH, "student", "matric_number");
  await importRoster(LECTURER_ROSTER_PATH, "teacher", "teacher_code");
  await migrateLegacyReceiptsToReconciliation();
}

if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use(
  express.json({
    limit: "2mb",
    verify(req, _res, buf) {
      req.rawBody = buf ? Buffer.from(buf) : Buffer.alloc(0);
    },
  })
);

const sessionStore = new SQLiteStore({
  db: "sessions.sqlite",
  dir: dataDir,
  concurrentDB: true,
});

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "replace-this-in-production",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 2,
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
    },
  })
);

app.get("/api/csrf-token", (req, res) => {
  const csrfToken = ensureCsrfToken(req);
  return res.json({ csrfToken });
});

app.use(requireCsrf);

app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use("/users", express.static(usersDir));

app.get("/content-files/:folder/:filename", requireAuth, (req, res) => {
  const folder = String(req.params.folder || "").toLowerCase();
  const filename = path.basename(String(req.params.filename || ""));
  if (!folder || !filename || !["handouts", "shared"].includes(folder)) {
    return res.status(400).json({ error: "Invalid file path." });
  }
  const absolutePath = path.resolve(contentFilesDir, folder, filename);
  const relativeCheck = path.relative(contentFilesDir, absolutePath);
  if (!relativeCheck || relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    return res.status(400).json({ error: "Invalid file path." });
  }
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: "File not found." });
  }
  return res.sendFile(absolutePath);
});

function isAuthenticated(req) {
  return !!(req.session && req.session.user);
}

function isValidHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(value);
}

function isValidLocalContentUrl(value) {
  return /^\/content-files\/(handouts|shared)\/[a-z0-9._-]+$/i.test(String(value || ""));
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }
  return res.redirect("/login");
}

function requireAdmin(req, res, next) {
  if (isAuthenticated(req) && req.session.user && req.session.user.role === "admin") {
    return next();
  }
  return res.status(403).redirect("/");
}

function requireTeacher(req, res, next) {
  if (!isAuthenticated(req) || !req.session.user) {
    return res.status(401).redirect("/login");
  }
  if (req.session.user.role === "teacher" || req.session.user.role === "admin") {
    return next();
  }
  return res.status(403).redirect("/");
}

function requireStudent(req, res, next) {
  if (!isAuthenticated(req) || !req.session.user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  if (req.session.user.role === "student") {
    return next();
  }
  return res.status(403).json({ error: "Only students can perform this action." });
}

function isAdminSession(req) {
  return !!(req.session && req.session.user && req.session.user.role === "admin");
}

function parseResourceId(rawValue) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function parseBooleanEnv(rawValue, defaultValue = false) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return defaultValue;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function createSystemActorRequest(username = "system-reconciliation", role = "system-reconciliation") {
  const actorUsername = normalizeIdentifier(username) || "system-reconciliation";
  const actorRole = String(role || "system-reconciliation")
    .trim()
    .toLowerCase()
    .slice(0, 40) || "system-reconciliation";
  return {
    session: {
      user: {
        username: actorUsername,
        role: actorRole,
      },
    },
  };
}

function buildAutoReceiptRefBase(transactionRow) {
  const txId = String(parseResourceId(transactionRow?.id) || "").trim();
  const paymentItemId = String(parseResourceId(transactionRow?.payment_item_id) || "").trim();
  const studentToken = normalizeIdentifier(transactionRow?.student_username || "").replace(/[^a-z0-9]/g, "");
  const parts = ["AUTO", "TXN", txId, paymentItemId, studentToken.slice(0, 20)].filter(Boolean);
  return sanitizeTransactionRef(parts.join("-")) || `AUTO-TXN-${txId || Date.now()}`;
}

async function resolveUniquePaymentReceiptReference(preferredReference, fallbackBase) {
  const maxLen = 120;
  const preferred = sanitizeTransactionRef(preferredReference || "").slice(0, maxLen);
  if (preferred) {
    const existing = await get("SELECT id FROM payment_receipts WHERE transaction_ref = ? LIMIT 1", [preferred]);
    if (!existing) {
      return preferred;
    }
  }

  const base = sanitizeTransactionRef(fallbackBase || "AUTO-TXN").slice(0, 96) || "AUTO-TXN";
  for (let i = 0; i < 100; i += 1) {
    const suffix = i === 0 ? "" : `-${i}`;
    const candidate = sanitizeTransactionRef(`${base}${suffix}`).slice(0, maxLen);
    if (!candidate) {
      continue;
    }
    const existing = await get("SELECT id FROM payment_receipts WHERE transaction_ref = ? LIMIT 1", [candidate]);
    if (!existing) {
      return candidate;
    }
  }

  return sanitizeTransactionRef(`AUTO-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`).slice(0, maxLen);
}

async function upsertApprovedReceiptFromTransaction(transactionId, options = {}) {
  const id = parseResourceId(transactionId);
  if (!id) {
    return { ok: false, error: "Invalid transaction ID." };
  }

  const tx = await get(
    `
      SELECT
        pt.id,
        pt.txn_ref,
        pt.amount,
        pt.paid_at,
        pt.source,
        pt.source_event_id,
        pt.status,
        pt.matched_obligation_id,
        po.student_username,
        po.payment_item_id
      FROM payment_transactions pt
      LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
      WHERE pt.id = ?
      LIMIT 1
    `,
    [id]
  );
  if (!tx) {
    return { ok: false, error: "Transaction not found." };
  }
  if (String(tx.status || "").toLowerCase() !== "approved") {
    return { ok: false, skipped: true, reason: "Transaction is not approved." };
  }

  const paymentItemId = parseResourceId(tx.payment_item_id);
  const studentUsername = normalizeIdentifier(tx.student_username || "");
  if (!paymentItemId || !studentUsername) {
    return {
      ok: false,
      skipped: true,
      reason: "Approved transaction is not linked to a student payment item.",
    };
  }

  const actorReq =
    options.actorReq && options.actorReq.session && options.actorReq.session.user
      ? options.actorReq
      : createSystemActorRequest(options.actorUsername || "system-reconciliation", options.actorRole || "system-reconciliation");
  const actorUsername = normalizeIdentifier(actorReq.session.user.username);
  const sourceReason = String(options.reason || "approved_transaction").trim().slice(0, 120) || "approved_transaction";
  const preferredRef = sanitizeTransactionRef(tx.txn_ref || "");

  let existingReceipt = null;
  if (preferredRef) {
    const byReference = await get("SELECT * FROM payment_receipts WHERE transaction_ref = ? LIMIT 1", [preferredRef]);
    if (
      byReference &&
      normalizeIdentifier(byReference.student_username) === studentUsername &&
      Number(byReference.payment_item_id || 0) === paymentItemId
    ) {
      existingReceipt = byReference;
    }
  }

  if (!existingReceipt) {
    existingReceipt = await get(
      `
        SELECT *
        FROM payment_receipts
        WHERE payment_item_id = ?
          AND student_username = ?
          AND status = 'approved'
        ORDER BY COALESCE(reviewed_at, submitted_at) DESC, id DESC
        LIMIT 1
      `,
      [paymentItemId, studentUsername]
    );
  }

  if (existingReceipt) {
    const mergedNotes = {
      ...parseJsonObject(existingReceipt.verification_notes || "{}", {}),
      source_transaction_id: id,
      auto_generated_from_transaction: true,
      source: String(tx.source || "").trim().toLowerCase(),
      source_reason: sourceReason,
    };
    await run(
      `
        UPDATE payment_receipts
        SET status = 'approved',
            reviewed_by = COALESCE(reviewed_by, ?),
            reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP),
            rejection_reason = NULL,
            verification_notes = ?
        WHERE id = ?
      `,
      [actorUsername || "system-reconciliation", JSON.stringify(mergedNotes), existingReceipt.id]
    );
    return { ok: true, receiptId: Number(existingReceipt.id), created: false };
  }

  const paidAtIso = isValidIsoLikeDate(tx.paid_at) ? new Date(String(tx.paid_at)).toISOString() : new Date().toISOString();
  const syntheticPath = path.join(receiptsDir, `auto-generated-transaction-${id}.txt`);
  try {
    if (!fs.existsSync(syntheticPath)) {
      await fs.promises.writeFile(
        syntheticPath,
        `Auto-generated placeholder for approved transaction #${id}.\n`,
        "utf8"
      );
    }
  } catch (_err) {
    // Keep going even if placeholder write fails.
  }

  const transactionRef = await resolveUniquePaymentReceiptReference(preferredRef, buildAutoReceiptRefBase({
    id,
    payment_item_id: paymentItemId,
    student_username: studentUsername,
  }));
  const notes = {
    source_transaction_id: id,
    auto_generated_from_transaction: true,
    source: String(tx.source || "").trim().toLowerCase(),
    source_event_id: String(tx.source_event_id || "").trim(),
    source_reason: sourceReason,
  };
  const insert = await run(
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
        reviewed_at,
        rejection_reason,
        verification_notes,
        extracted_text
      )
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP, NULL, ?, '')
    `,
    [
      paymentItemId,
      studentUsername,
      Number(tx.amount || 0),
      paidAtIso,
      transactionRef,
      syntheticPath,
      paidAtIso,
      actorUsername || "system-reconciliation",
      JSON.stringify(notes),
    ]
  );
  await logReceiptEvent(
    insert.lastID,
    actorReq,
    "auto_generate_from_transaction",
    null,
    "approved",
    `Auto-generated from approved transaction #${id}.`
  );
  return { ok: true, receiptId: Number(insert.lastID), created: true };
}

async function ensureApprovedReceiptGeneratedForTransaction(transactionId, options = {}) {
  const receipt = await upsertApprovedReceiptFromTransaction(transactionId, options);
  if (!receipt.ok || !receipt.receiptId) {
    return {
      ok: false,
      attempted: false,
      ...receipt,
    };
  }
  const delivery = await triggerApprovedReceiptDispatchForReceipt(receipt.receiptId, {
    actorUsername:
      options.actorReq?.session?.user?.username ||
      options.actorUsername ||
      "system-reconciliation",
    forceEnabled: true,
  });
  return {
    ok: !(delivery && delivery.failed > 0),
    attempted: true,
    receiptId: receipt.receiptId,
    createdReceipt: !!receipt.created,
    delivery,
  };
}

async function triggerApprovedReceiptDispatchForReceipt(paymentReceiptId, options = {}) {
  const receiptId = parseResourceId(paymentReceiptId);
  if (!receiptId) {
    return {
      attempted: false,
      sent: false,
      failed: true,
      error: "Invalid receipt ID.",
    };
  }
  const immediateEnabled = options.forceEnabled
    ? true
    : parseBooleanEnv(process.env.RECEIPT_IMMEDIATE_ON_APPROVE, true);
  if (!immediateEnabled) {
    return {
      attempted: false,
      sent: false,
      failed: false,
      skipped: true,
      reason: "Immediate approved-receipt generation is disabled.",
    };
  }

  const templateHtmlPath = path.resolve(
    process.env.RECEIPT_TEMPLATE_HTML || path.join(__dirname, "templates", "approved-student-receipt.html")
  );
  const templateCssPath = path.resolve(
    process.env.RECEIPT_TEMPLATE_CSS || path.join(__dirname, "templates", "approved-student-receipt.css")
  );

  try {
    const summary = await generateApprovedStudentReceipts({
      db: { run, get, all },
      deliveryMode: "download",
      force: !!options.forceRegenerate,
      paymentReceiptId: receiptId,
      limit: 1,
      dataDir,
      outputDir: approvedReceiptsDir,
      templateHtmlPath,
      templateCssPath,
      logger: console,
    });
    return {
      attempted: true,
      mode: "download",
      eligible: Number(summary.eligible || 0),
      sent: Number(summary.sent || 0),
      failed: Number(summary.failed || 0),
    };
  } catch (err) {
    const reason = String(err && err.message ? err.message : err || "Unknown error");
    console.error(
      `[approved-receipts] immediate generation failed payment_receipt_id=${receiptId} actor=${String(
        options.actorUsername || "system"
      )} reason=${reason}`
    );
    return {
      attempted: true,
      mode: "download",
      eligible: 0,
      sent: 0,
      failed: 1,
      error: reason,
    };
  }
}

async function getApprovedReceiptDispatchByReceiptId(paymentReceiptId) {
  const receiptId = parseResourceId(paymentReceiptId);
  if (!receiptId) {
    return null;
  }
  const row = await get(
    `
      SELECT
        payment_receipt_id,
        COALESCE(receipt_sent, 0) AS receipt_sent,
        COALESCE(receipt_file_path, '') AS receipt_file_path,
        last_error
      FROM approved_receipt_dispatches
      WHERE payment_receipt_id = ?
      LIMIT 1
    `,
    [receiptId]
  );
  if (!row) {
    return null;
  }
  return {
    payment_receipt_id: parseResourceId(row.payment_receipt_id),
    receipt_sent: Number(row.receipt_sent || 0),
    receipt_file_path: String(row.receipt_file_path || "").trim(),
    last_error: row.last_error ? String(row.last_error) : "",
  };
}

function isValidIsoLikeDate(value) {
  if (!value) {
    return false;
  }
  const date = new Date(String(value));
  return !Number.isNaN(date.getTime());
}

function parseMoneyValue(value) {
  const amount = Number.parseFloat(String(value));
  if (!Number.isFinite(amount)) {
    return null;
  }
  return amount;
}

function parseAvailabilityDays(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const days = Number.parseInt(raw, 10);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    return null;
  }
  return days;
}

function computeAvailableUntil(availabilityDays) {
  if (!Number.isFinite(availabilityDays) || availabilityDays <= 0) {
    return null;
  }
  const now = new Date();
  const end = new Date(now.getTime() + availabilityDays * 24 * 60 * 60 * 1000);
  return end.toISOString();
}

function parseCurrency(value) {
  const text = String(value || "NGN").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(text)) {
    return null;
  }
  return text;
}

function sanitizeTransactionRef(value) {
  return String(value || "").trim().slice(0, 120);
}

function sanitizeReceiptStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  const allowed = new Set(["submitted", "under_review", "approved", "rejected"]);
  return allowed.has(status) ? status : "";
}

function sanitizeAssignmentFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set(["all", "mine", "unassigned"]);
  return allowed.has(normalized) ? normalized : "all";
}

function sanitizeBulkReceiptAction(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set(["assign", "under_review", "approve", "reject", "note", "bulk_verify"]);
  return allowed.has(normalized) ? normalized : "";
}

function sanitizeReconciliationStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "all",
    "approved",
    "needs_review",
    "unmatched",
    "duplicate",
    "rejected",
    "needs_student_confirmation",
  ]);
  return allowed.has(normalized) ? normalized : "all";
}

function sanitizeReconciliationReason(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "all",
    "exact_reference",
    "amount_match",
    "payer_hint_match",
    "item_hint_match",
    "student_hint_match",
    "date_proximity_match",
    "ambiguous_candidate",
    "no_candidate",
    "duplicate_transaction",
    "manual_approved",
    "manual_rejected",
    "needs_student_confirmation",
  ]);
  return allowed.has(normalized) ? normalized : "all";
}

function sanitizeReconciliationBulkAction(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set(["approve", "reject", "request_student_confirmation", "merge_duplicates"]);
  return allowed.has(normalized) ? normalized : "";
}

function normalizeReasonCodes(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20)
    )
  );
}

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = value ? JSON.parse(value) : fallback;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }
    return parsed;
  } catch (_err) {
    return fallback;
  }
}

function parseJsonArray(value, fallback = []) {
  try {
    const parsed = value ? JSON.parse(value) : fallback;
    if (!Array.isArray(parsed)) {
      return fallback;
    }
    return parsed;
  } catch (_err) {
    return fallback;
  }
}

function toSafeConfidence(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function buildDeterministicPaymentReference(paymentItemId, studentUsername, attempt = 0) {
  const itemToken = Number.parseInt(paymentItemId, 10);
  const studentToken = normalizeIdentifier(studentUsername).replace(/[^a-z0-9]/g, "") || "student";
  const base = `${String(PAYMENT_REFERENCE_PREFIX || "PAYTEC")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10)}-${String(itemToken || 0).padStart(4, "0")}`;
  const digest = crypto
    .createHash("sha1")
    .update(`${PAYMENT_REFERENCE_TENANT_ID}|${itemToken}:${studentToken}|${Number.parseInt(attempt, 10) || 0}`)
    .digest("hex")
    .slice(0, 14)
    .toUpperCase();
  const shortStudent = studentToken.slice(0, 8).toUpperCase() || "STUDENT";
  if (!attempt) {
    return `${base}-${shortStudent}-${digest}`.slice(0, 120);
  }
  const suffix = digest.slice(0, Math.min(4 + attempt, 8));
  return `${base}-${shortStudent}-${digest}-${suffix}`.slice(0, 120);
}

function buildDeterministicReferenceCandidates(paymentItemId, studentUsername, maxAttempts = 8) {
  const candidates = [];
  const safeAttempts = Math.max(1, Math.min(12, Number.parseInt(maxAttempts, 10) || 1));
  for (let i = 0; i < safeAttempts; i += 1) {
    candidates.push(buildDeterministicPaymentReference(paymentItemId, studentUsername, i));
  }
  return candidates;
}

function parseReceiptIdList(rawValues, limit = 50) {
  if (!Array.isArray(rawValues)) {
    return [];
  }
  const ids = [];
  const seen = new Set();
  for (const rawValue of rawValues) {
    const id = parseResourceId(rawValue);
    if (!id || seen.has(id)) {
      continue;
    }
    ids.push(id);
    seen.add(id);
    if (ids.length >= limit) {
      break;
    }
  }
  return ids;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeStatementName(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeReference(value) {
  return String(value || "").trim().toLowerCase().slice(0, 120);
}

function toDateOnly(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

function almostSameAmount(left, right, tolerance = 0.01) {
  const l = Number(left);
  const r = Number(right);
  if (!Number.isFinite(l) || !Number.isFinite(r)) {
    return false;
  }
  return Math.abs(l - r) <= tolerance;
}

function buildTransactionChecksum(input = {}) {
  const source = String(input.source || "statement_upload")
    .trim()
    .toLowerCase()
    .slice(0, 40);
  const txnRef = normalizeReference(input.txn_ref || input.reference || "");
  const amount = Number(input.amount);
  const amountToken = Number.isFinite(amount) ? amount.toFixed(2) : "";
  const dateToken = parseDateToken(input.date || input.paid_at || input.paidAt || input.normalized_paid_date || "");
  const payerToken = normalizeStatementName(input.payer_name || input.payerName || input.name || "");
  if (!amountToken || !dateToken) {
    return "";
  }
  const key = `${txnRef}|${amountToken}|${dateToken}|${payerToken}|${source}`;
  return crypto.createHash("sha1").update(key).digest("hex");
}

function toKoboFromAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed * 100);
}

function toAmountFromKobo(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed / 100;
}

function buildPaystackGatewayReference(obligationId, studentUsername) {
  const idToken = String(Number.parseInt(obligationId, 10) || 0).padStart(6, "0");
  const studentToken = normalizeIdentifier(studentUsername)
    .replace(/[^a-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 8) || "STUDENT";
  const timestampToken = Date.now().toString(36).toUpperCase();
  const randomToken = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `PSTK-${idToken}-${studentToken}-${timestampToken}-${randomToken}`.slice(0, 120);
}

function parsePaystackMetadata(rawMetadata) {
  if (!rawMetadata) {
    return {};
  }
  if (typeof rawMetadata === "string") {
    return parseJsonObject(rawMetadata, {});
  }
  if (typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    return rawMetadata;
  }
  return {};
}

function extractPaystackPayerName(transaction, metadata) {
  const customer = transaction && transaction.customer && typeof transaction.customer === "object" ? transaction.customer : {};
  const first = String(customer.first_name || "").trim();
  const last = String(customer.last_name || "").trim();
  const full = [first, last].filter(Boolean).join(" ").trim();
  return (
    full ||
    String(customer.name || "").trim() ||
    String(metadata.student_username || metadata.studentUsername || metadata.student || "").trim() ||
    String(customer.email || "").trim() ||
    "unknown payer"
  );
}

function buildPaystackSourceEventId(payload, transaction) {
  const event = String(payload?.event || "charge.success").trim().toLowerCase();
  const baseToken =
    payload?.id ||
    payload?.event_id ||
    transaction?.id ||
    transaction?.reference ||
    crypto.createHash("sha1").update(JSON.stringify(payload || {})).digest("hex").slice(0, 40);
  return `paystack-${event}-${String(baseToken).trim().slice(0, 120)}`.slice(0, 160);
}

function normalizePaystackTransactionForIngestion(payload, options = {}) {
  const transaction = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const metadata = parsePaystackMetadata(transaction.metadata);
  const gatewayReference = sanitizeTransactionRef(transaction.reference || transaction.gateway_response || "");
  const amount = toAmountFromKobo(transaction.amount);
  const paidAt =
    String(transaction.paid_at || transaction.created_at || transaction.transaction_date || payload?.paid_at || "").trim() ||
    new Date().toISOString();
  const txnReference = sanitizeTransactionRef(metadata.payment_reference || metadata.paymentReference || gatewayReference);
  const sourceEventId = String(options.sourceEventId || buildPaystackSourceEventId(payload, transaction))
    .trim()
    .slice(0, 160);
  const studentHint = normalizeIdentifier(
    metadata.student_username || metadata.studentUsername || metadata.student || metadata.student_id || ""
  );
  const paymentItemHint = parseResourceId(metadata.payment_item_id || metadata.paymentItemId || "");
  const payerName = extractPaystackPayerName(transaction, metadata);

  if (!amount || !paidAt || !sourceEventId || !gatewayReference) {
    return null;
  }

  const checksum = buildTransactionChecksum({
    source: PAYSTACK_SOURCE,
    txn_ref: gatewayReference,
    amount,
    date: paidAt,
    payer_name: payerName,
  });

  return {
    payload: {
      source: PAYSTACK_SOURCE,
      source_event_id: sourceEventId,
      txn_ref: txnReference,
      amount,
      date: paidAt,
      payer_name: payerName,
      payment_item_id: paymentItemHint || null,
      student_username: studentHint || null,
      checksum,
      raw_payload: payload,
    },
    gatewayReference,
    metadata,
    transaction,
    sourceEventId,
    amount,
  };
}

function isValidPaystackSignature(rawBody, headerSignature, secret) {
  const signature = String(headerSignature || "").trim().toLowerCase();
  const secretKey = String(secret || "").trim();
  if (!signature || !secretKey || !rawBody || !rawBody.length) {
    return false;
  }
  const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function normalizeStatementRowsText(rawText) {
  const rows = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rows.length) {
    return [];
  }

  const headerCells = parseCsvLine(rows[0]).map((cell) =>
    String(cell || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_")
  );
  const findIndex = (...aliases) => {
    for (const alias of aliases) {
      const idx = headerCells.indexOf(alias);
      if (idx !== -1) {
        return idx;
      }
    }
    return -1;
  };

  const nameIndex = findIndex("name", "student", "student_name", "student_username", "matric_number", "username");
  const descriptionIndex = findIndex(
    "description",
    "transaction_description",
    "transaction_details",
    "narration",
    "details",
    "remark",
    "remarks",
    "note"
  );
  const amountIndex = findIndex("amount", "amount_paid", "paid_amount");
  const creditIndex = findIndex("credit", "credit_amount", "amount_credit");
  const debitIndex = findIndex("debit", "debit_amount", "amount_debit");
  const dateIndex = findIndex(
    "date",
    "paid_at",
    "payment_date",
    "paid_date",
    "transaction_date",
    "value_date",
    "posted_date"
  );
  const refIndex = findIndex(
    "reference",
    "reference_no",
    "reference_number",
    "transaction_ref",
    "transaction_reference",
    "transaction_id",
    "session_id",
    "order_no",
    "order_number"
  );
  if ((nameIndex === -1 && descriptionIndex === -1) || (amountIndex === -1 && creditIndex === -1 && debitIndex === -1) || dateIndex === -1) {
    return [];
  }

  const normalized = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = parseCsvLine(rows[i]);
    const rawName = nameIndex === -1 ? "" : cells[nameIndex];
    const rawDescription = descriptionIndex === -1 ? "" : cells[descriptionIndex];
    const rawAmount = amountIndex === -1 ? "" : cells[amountIndex];
    const rawCredit = creditIndex === -1 ? "" : cells[creditIndex];
    const rawDebit = debitIndex === -1 ? "" : cells[debitIndex];
    const rawDate = cells[dateIndex];
    const rawRef = refIndex === -1 ? "" : cells[refIndex];
    const name = normalizeStatementName(rawName);
    const description = normalizeStatementName(rawDescription);
    const creditAmount = parseMoneyValue(rawCredit);
    const debitAmount = parseMoneyValue(rawDebit);
    const genericAmount = parseMoneyValue(rawAmount);
    let amount = null;
    if (Number.isFinite(creditAmount) && creditAmount > 0) {
      amount = creditAmount;
    } else if (Number.isFinite(genericAmount)) {
      amount = Math.abs(genericAmount);
    } else if (Number.isFinite(debitAmount)) {
      amount = Math.abs(debitAmount);
    }
    const date = toDateOnly(rawDate);
    const normalizedName = name || description;
    if (!normalizedName || !Number.isFinite(amount) || !date) {
      continue;
    }
    normalized.push({
      row_number: i + 1,
      raw_name: normalizeWhitespace(rawName),
      raw_description: normalizeWhitespace(rawDescription),
      raw_credit: String(rawCredit || rawAmount || "").trim(),
      raw_debit: String(rawDebit || "").trim(),
      raw_amount: String(rawAmount || "").trim(),
      raw_date: String(rawDate || "").trim(),
      raw_reference: String(rawRef || "").trim(),
      normalized_name: normalizedName,
      normalized_description: description,
      normalized_amount: amount,
      normalized_date: date,
      normalized_reference: normalizeReference(rawRef),
    });
  }
  return normalized;
}

function normalizeStatementRowsTextDetailed(rawText) {
  const parsedRows = normalizeStatementRowsText(rawText);
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return { parsedRows: [], invalidRows: [] };
  }
  const parsedLineNumbers = new Set(parsedRows.map((row) => Number(row.row_number || 0)));
  const invalidRows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const rowNumber = i + 1;
    if (!parsedLineNumbers.has(rowNumber)) {
      invalidRows.push({
        row_number: rowNumber,
        raw: lines[i],
        reasons: ["parse_failed_or_missing_required_fields"],
      });
    }
  }
  return { parsedRows, invalidRows };
}

function parseDateToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  const isoCandidate = token.replace(/\./g, "-").replace(/\//g, "-");
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(isoCandidate)) {
    const [y, m, d] = isoCandidate.split("-").map((entry) => Number.parseInt(entry, 10));
    if (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(isoCandidate)) {
    const [a, b, y] = isoCandidate.split("-").map((entry) => Number.parseInt(entry, 10));
    if (y > 1900) {
      const asDayFirst = `${String(y).padStart(4, "0")}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
      const parsed = new Date(asDayFirst);
      if (!Number.isNaN(parsed.getTime())) {
        return asDayFirst;
      }
    }
  }
  const parsed = new Date(token);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function parseAmountToken(value) {
  const token = String(value || "");
  if (!token) {
    return null;
  }
  const normalized = token.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount)) {
    return null;
  }
  return amount;
}

function parseStatementRowsFromLooseText(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 6);
  const parsedRows = [];
  const dateRegex = /\b(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})\b/;
  const amountRegex = /\b(?:credit|cr|amount|ngn|n|usd|eur|gbp)?\s*[:\-]?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))\b/i;
  const refRegex = /\b(?:transaction(?:\s+reference)?|transaction_ref|tx|ref|rrr|session[_\s-]?id|order[_\s-]?(?:no|number))[-:\s]*([A-Z0-9-]{4,})\b/i;

  lines.forEach((line, idx) => {
    const dateMatch = line.match(dateRegex);
    const amountMatch = line.match(amountRegex);
    if (!dateMatch || !amountMatch) {
      return;
    }
    const normalizedDate = parseDateToken(dateMatch[1]);
    const normalizedAmount = parseAmountToken(amountMatch[1]);
    if (!normalizedDate || !Number.isFinite(normalizedAmount)) {
      return;
    }
    let nameToken = line;
    nameToken = nameToken.replace(dateMatch[0], " ");
    nameToken = nameToken.replace(amountMatch[0], " ");
    const refMatch = line.match(refRegex);
    if (refMatch) {
      nameToken = nameToken.replace(refMatch[0], " ");
    }
    const cleanedName = normalizeWhitespace(nameToken.replace(/[_|,:;]+/g, " "));
    if (!cleanedName) {
      return;
    }
    parsedRows.push({
      row_number: idx + 1,
      raw_name: cleanedName,
      raw_description: cleanedName,
      raw_credit: amountMatch[1],
      raw_amount: amountMatch[1],
      raw_date: dateMatch[1],
      raw_reference: refMatch ? refMatch[1] : "",
      normalized_name: normalizeStatementName(cleanedName),
      normalized_description: normalizeStatementName(cleanedName),
      normalized_amount: normalizedAmount,
      normalized_date: normalizedDate,
      normalized_reference: normalizeReference(refMatch ? refMatch[1] : ""),
    });
  });

  return parsedRows;
}

function escapeCsvCell(value) {
  const text = String(value == null ? "" : value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function parseStatementRowsFromExcelFile(filePath) {
  if (!xlsx) {
    return { extractedText: "", parsedRows: [], invalidRows: [] };
  }
  try {
    const workbook = xlsx.readFile(filePath, {
      cellDates: true,
      raw: false,
      dense: false,
    });
    if (!workbook || !Array.isArray(workbook.SheetNames) || !workbook.SheetNames.length) {
      return { extractedText: "", parsedRows: [], invalidRows: [] };
    }

    let combinedCsv = "";
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        continue;
      }
      const rows = xlsx.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
        blankrows: false,
      });
      if (!Array.isArray(rows) || !rows.length) {
        continue;
      }
      const csvLines = rows.map((row) =>
        (Array.isArray(row) ? row : [row]).map((cell) => escapeCsvCell(cell)).join(",")
      );
      if (csvLines.length) {
        combinedCsv += (combinedCsv ? "\n" : "") + csvLines.join("\n");
      }
    }

    const extractedText = combinedCsv.slice(0, 300000);
    if (!extractedText) {
      return { extractedText: "", parsedRows: [], invalidRows: [] };
    }
    let detailed = normalizeStatementRowsTextDetailed(extractedText);
    let parsedRows = detailed.parsedRows;
    let invalidRows = detailed.invalidRows;
    if (!parsedRows.length) {
      parsedRows = parseStatementRowsFromLooseText(extractedText);
      invalidRows = [];
    }
    return {
      extractedText,
      parsedRows,
      invalidRows,
    };
  } catch (_err) {
    return { extractedText: "", parsedRows: [], invalidRows: [] };
  }
}

function isLikelyOcrFileExtension(ext) {
  return [".pdf", ".png", ".jpg", ".jpeg", ".webp"].includes(String(ext || "").toLowerCase());
}

function isLikelyTextStatementExtension(ext) {
  return [
    ".csv",
    ".txt",
    ".tsv",
    ".json",
    ".xml",
    ".rtf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
  ].includes(String(ext || "").toLowerCase());
}

function parseAiStatementPayload(content) {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }
  try {
    return JSON.parse(content);
  } catch (_err) {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fenced || !fenced[1]) {
      return null;
    }
    try {
      return JSON.parse(fenced[1]);
    } catch (__err) {
      return null;
    }
  }
}

function normalizeStatementRowsFromAi(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  const normalized = [];
  rows.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const rawName = String(entry.name || entry.student || "").trim();
    const rawDescription = String(entry.description || entry.narration || "").trim();
    const rawAmount = String(entry.amount || entry.credit || "").trim();
    const rawDate = String(entry.date || "").trim();
    const rawReference = String(entry.reference || entry.transaction_ref || entry.ref || "").trim();
    const name = normalizeStatementName(rawName || rawDescription);
    const amount = parseAmountToken(rawAmount);
    const date = parseDateToken(rawDate);
    if (!name || !Number.isFinite(amount) || !date) {
      return;
    }
    normalized.push({
      row_number: Number.parseInt(entry.line_number, 10) || idx + 1,
      raw_name: normalizeWhitespace(rawName),
      raw_description: normalizeWhitespace(rawDescription),
      raw_credit: rawAmount,
      raw_debit: "",
      raw_amount: rawAmount,
      raw_date: rawDate,
      raw_reference: rawReference,
      normalized_name: name,
      normalized_description: normalizeStatementName(rawDescription),
      normalized_amount: Math.abs(amount),
      normalized_date: date,
      normalized_reference: normalizeReference(rawReference),
    });
  });
  return normalized;
}

async function parseStatementRowsWithAi(rawText, context = {}) {
  if (STATEMENT_PARSER_PROVIDER !== "openai" || !OPENAI_API_KEY) {
    return [];
  }
  const text = String(rawText || "").trim();
  if (!text) {
    return [];
  }
  const promptText = text.slice(0, 50000);
  const instructions = [
    "Extract payment statement rows from the text.",
    "Return strict JSON with shape: {\"rows\":[{\"line_number\":number,\"name\":string,\"description\":string,\"amount\":string,\"date\":string,\"reference\":string}]}",
    "Keep only rows that look like actual payment credits relevant to students.",
    "date must be original token from input; amount should be a number-like string.",
    "Do not include explanations or markdown.",
  ].join(" ");
  const filename = String(context.filename || "").trim();

  try {
    const response = await fetch(`${OPENAI_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_STATEMENT_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: instructions },
          {
            role: "user",
            content: `filename=${filename || "unknown"}\n\nstatement_text:\n${promptText}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      return [];
    }
    const payload = await response.json();
    const content = String(payload?.choices?.[0]?.message?.content || "");
    const parsed = parseAiStatementPayload(content);
    const candidateRows = parsed?.rows;
    return normalizeStatementRowsFromAi(candidateRows);
  } catch (_err) {
    return [];
  }
}

async function parseStatementRowsFromUpload(statementPath, originalFilename) {
  const ext = path.extname(String(originalFilename || statementPath || "")).toLowerCase();
  let extractedText = "";
  let parsedRows = [];
  let invalidRows = [];
  const parseStages = [];

  if (ext === ".xls" || ext === ".xlsx") {
    const excelResult = await parseStatementRowsFromExcelFile(statementPath);
    extractedText = excelResult.extractedText;
    parsedRows = excelResult.parsedRows;
    invalidRows = excelResult.invalidRows || [];
    parseStages.push("structured_excel");
  } else if (isLikelyOcrFileExtension(ext)) {
    const ocrResult = await extractReceiptText(statementPath);
    extractedText = String(ocrResult?.text || "");
    parseStages.push("ocr_text_extraction");
  } else {
    try {
      extractedText = await fs.promises.readFile(statementPath, "utf8");
      parseStages.push("structured_text_read");
    } catch (_err) {
      extractedText = "";
    }
  }
  if (!parsedRows.length) {
    const detailed = normalizeStatementRowsTextDetailed(extractedText);
    parsedRows = detailed.parsedRows;
    invalidRows = invalidRows.concat(detailed.invalidRows || []);
    if (parsedRows.length) {
      parseStages.push("structured_table_parse");
    }
    if (!parsedRows.length) {
      parsedRows = parseStatementRowsFromLooseText(extractedText);
      if (parsedRows.length) {
        parseStages.push("loose_text_parse");
      }
    }
  }
  if (!parsedRows.length) {
    const aiRows = await parseStatementRowsWithAi(extractedText, { filename: originalFilename, extension: ext });
    if (aiRows.length) {
      parsedRows = aiRows;
      parseStages.push("ai_fallback_parse");
    }
  }
  if (!parsedRows.length && isLikelyTextStatementExtension(ext)) {
    try {
      const fallbackText = await fs.promises.readFile(statementPath, { encoding: "latin1" });
      const bestEffortText = String(fallbackText || "");
      if (bestEffortText && bestEffortText !== extractedText) {
        extractedText = extractedText || bestEffortText;
        const aiRows = await parseStatementRowsWithAi(bestEffortText, { filename: originalFilename, extension: ext });
        if (aiRows.length) {
          parsedRows = aiRows;
          parseStages.push("ai_fallback_parse_latin1");
        }
      }
    } catch (_err) {
      // Ignore fallback read errors.
    }
  }
  return {
    extractedText,
    parsedRows,
    invalidRows,
    parseStages,
  };
}

function parseReceiptTextCandidates(rawText) {
  const text = String(rawText || "");
  const names = [];
  const amounts = [];
  const dates = [];
  const references = [];

  const amountRegex = /\b(?:NGN|N|USD|EUR|GBP)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))\b/gi;
  let amountMatch = amountRegex.exec(text);
  while (amountMatch) {
    const parsed = parseAmountToken(amountMatch[1]);
    if (Number.isFinite(parsed)) {
      amounts.push(parsed);
    }
    amountMatch = amountRegex.exec(text);
  }

  const dateRegex = /\b(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})\b/g;
  let dateMatch = dateRegex.exec(text);
  while (dateMatch) {
    const parsed = parseDateToken(dateMatch[1]);
    if (parsed) {
      dates.push(parsed);
    }
    dateMatch = dateRegex.exec(text);
  }

  const refRegex = /\b(?:TX|REF|RRR)[-:\s]*([A-Z0-9-]{4,})\b/gi;
  let refMatch = refRegex.exec(text);
  while (refMatch) {
    references.push(normalizeReference(refMatch[1]));
    refMatch = refRegex.exec(text);
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  lines.forEach((line) => {
    if (/name|paid|amount|date|ref|receipt/i.test(line)) {
      return;
    }
    if (line.length >= 4 && line.length <= 80 && /[a-z]/i.test(line)) {
      names.push(normalizeStatementName(line));
    }
  });

  return {
    names: Array.from(new Set(names)),
    amounts: Array.from(new Set(amounts)),
    dates: Array.from(new Set(dates)),
    references: Array.from(new Set(references)),
  };
}

function detectMimeTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".csv") return "text/csv";
  if (ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

async function extractTextWithLocalTesseract(filePath) {
  const outBase = `${filePath}-ocr-${Date.now()}`;
  try {
    await execFileAsync("tesseract", [filePath, outBase, "--dpi", "300"]);
    const outPath = `${outBase}.txt`;
    if (!fs.existsSync(outPath)) {
      return { text: "", confidence: 0, provider: "tesseract-local" };
    }
    const text = fs.readFileSync(outPath, "utf8");
    fs.unlink(outPath, () => {});
    return {
      text: String(text || ""),
      confidence: text ? 0.6 : 0,
      provider: "tesseract-local",
    };
  } catch (_err) {
    return { text: "", confidence: 0, provider: "tesseract-local" };
  }
}

async function extractTextWithOcrSpace(filePath) {
  if (!OCR_SPACE_API_KEY) {
    return { text: "", confidence: 0, provider: "ocr-space" };
  }
  try {
    const buffer = await fs.promises.readFile(filePath);
    const mimeType = detectMimeTypeFromPath(filePath);
    const form = new FormData();
    form.append("language", "eng");
    form.append("isOverlayRequired", "false");
    form.append("OCREngine", "2");
    form.append("file", new Blob([buffer], { type: mimeType }), path.basename(filePath));

    const response = await fetch(OCR_SPACE_ENDPOINT, {
      method: "POST",
      headers: {
        apikey: OCR_SPACE_API_KEY,
      },
      body: form,
    });
    const payload = await response.json();
    if (!response.ok) {
      return { text: "", confidence: 0, provider: "ocr-space" };
    }
    const lines = Array.isArray(payload?.ParsedResults) ? payload.ParsedResults : [];
    const text = lines.map((entry) => String(entry?.ParsedText || "")).join("\n").trim();
    const hasError = Boolean(payload?.IsErroredOnProcessing);
    if (hasError) {
      return { text: "", confidence: 0, provider: "ocr-space" };
    }
    return {
      text,
      confidence: text ? 0.75 : 0,
      provider: "ocr-space",
    };
  } catch (_err) {
    return { text: "", confidence: 0, provider: "ocr-space" };
  }
}

async function getStudentNameVariants(username) {
  const normalizedUsername = normalizeIdentifier(username);
  const variants = new Set();
  if (normalizedUsername) {
    variants.add(normalizedUsername);
  }
  const profile = await getUserProfile(normalizedUsername);
  if (profile && profile.display_name) {
    variants.add(normalizeStatementName(profile.display_name));
  }
  return variants;
}

async function ensureCanManageContent(req, table, id) {
  const row = await get(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [id]);
  if (!row) {
    return { error: "not_found" };
  }
  if (isAdminSession(req) || row.created_by === req.session.user.username) {
    return { row };
  }
  return { error: "forbidden" };
}

function sanitizeMessageSubject(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 120);
}

function sanitizeMessageBody(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

const MESSAGE_SUBJECT_MAX_LENGTH = 120;
const MESSAGE_BODY_MAX_LENGTH = 4000;

function canCreateMessageThreads(role) {
  return role === "teacher" || role === "admin";
}

function validateMessageSubjectOrThrow(rawSubject) {
  const normalized = String(rawSubject || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length > MESSAGE_SUBJECT_MAX_LENGTH) {
    throw { status: 400, error: `Subject cannot be longer than ${MESSAGE_SUBJECT_MAX_LENGTH} characters.` };
  }
  return sanitizeMessageSubject(normalized);
}

function validateMessageBodyOrThrow(rawBody, { allowEmpty = false } = {}) {
  const message = sanitizeMessageBody(rawBody);
  if (!allowEmpty && !message) {
    throw { status: 400, error: "Message body is required." };
  }
  if (message.length > MESSAGE_BODY_MAX_LENGTH) {
    throw { status: 400, error: `Message body cannot be longer than ${MESSAGE_BODY_MAX_LENGTH} characters.` };
  }
  return message;
}

function parseMessageParticipantsCsv(rawValue) {
  if (!rawValue) {
    return [];
  }
  return String(rawValue)
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => {
      const [username, role] = entry.split("|");
      return {
        username: String(username || "").trim(),
        role: String(role || "").trim().toLowerCase() || "student",
      };
    })
    .filter((entry) => entry.username);
}

function normalizeMessageRecipients(rawRecipients) {
  if (!Array.isArray(rawRecipients)) {
    return [];
  }
  const unique = new Set();
  const recipients = [];
  rawRecipients.forEach((entry) => {
    const username = normalizeIdentifier(entry);
    if (!username || unique.has(username)) {
      return;
    }
    unique.add(username);
    recipients.push(username);
  });
  return recipients;
}

async function validateMessageRecipients(rawRecipients) {
  const recipients = normalizeMessageRecipients(rawRecipients);
  if (!recipients.length) {
    throw { status: 400, error: "At least one student recipient is required." };
  }
  if (recipients.length > 200) {
    throw { status: 400, error: "Too many recipients. Maximum is 200." };
  }
  const invalid = recipients.filter((username) => !isValidIdentifier(username));
  if (invalid.length) {
    throw { status: 400, error: "One or more recipient usernames are invalid." };
  }
  const placeholders = recipients.map(() => "?").join(",");
  const rows = await all(
    `SELECT auth_id FROM auth_roster WHERE role = 'student' AND auth_id IN (${placeholders})`,
    recipients
  );
  const existing = new Set(rows.map((row) => normalizeIdentifier(row.auth_id)));
  const missing = recipients.filter((username) => !existing.has(username));
  if (missing.length) {
    throw { status: 400, error: `Recipients must be valid student accounts: ${missing.join(", ")}` };
  }
  return recipients;
}

async function listMessageStudentDirectory() {
  const rows = await all(
    `
      SELECT
        ar.auth_id AS username,
        COALESCE(NULLIF(TRIM(up.display_name), ''), ar.auth_id) AS display_name
      FROM auth_roster ar
      LEFT JOIN user_profiles up ON up.username = ar.auth_id
      WHERE ar.role = 'student'
      ORDER BY ar.auth_id ASC
    `
  );
  return rows.map((row) => ({
    username: String(row.username || ""),
    display_name: String(row.display_name || row.username || ""),
  }));
}

async function getMessageThreadAccess(threadId, username) {
  const thread = await get("SELECT * FROM message_threads WHERE id = ? LIMIT 1", [threadId]);
  if (!thread) {
    throw { status: 404, error: "Message thread not found." };
  }
  const participant = await get(
    `
      SELECT thread_id, username, role, joined_at, last_read_message_id, last_read_at
      FROM message_participants
      WHERE thread_id = ? AND username = ?
      LIMIT 1
    `,
    [threadId, username]
  );
  if (!participant) {
    throw { status: 403, error: "You do not have access to this thread." };
  }
  return { thread, participant };
}

async function listMessageThreadSummariesForUser(username) {
  const rows = await all(
    `
      SELECT
        mt.id,
        COALESCE(mt.subject, '') AS subject,
        mt.created_by,
        mt.created_at,
        mt.updated_at,
        COALESCE(last_msg.id, 0) AS last_message_id,
        COALESCE(last_msg.body, '') AS last_message_body,
        COALESCE(last_msg.created_at, '') AS last_message_at,
        COALESCE(last_msg.sender_username, '') AS last_message_sender_username,
        COALESCE(participant_rollup.participants_csv, '') AS participants_csv,
        COALESCE(unread_rollup.unread_count, 0) AS unread_count
      FROM message_participants mp_self
      JOIN message_threads mt ON mt.id = mp_self.thread_id
      LEFT JOIN messages last_msg ON last_msg.id = (
        SELECT m2.id
        FROM messages m2
        WHERE m2.thread_id = mt.id
        ORDER BY m2.id DESC
        LIMIT 1
      )
      LEFT JOIN (
        SELECT
          mp2.thread_id,
          GROUP_CONCAT(mp2.username || '|' || mp2.role, ',') AS participants_csv
        FROM message_participants mp2
        GROUP BY mp2.thread_id
      ) participant_rollup ON participant_rollup.thread_id = mt.id
      LEFT JOIN (
        SELECT
          mp3.thread_id,
          COUNT(m3.id) AS unread_count
        FROM message_participants mp3
        LEFT JOIN messages m3
          ON m3.thread_id = mp3.thread_id
         AND m3.id > COALESCE(mp3.last_read_message_id, 0)
         AND LOWER(COALESCE(m3.sender_username, '')) <> LOWER(mp3.username)
        WHERE mp3.username = ?
        GROUP BY mp3.thread_id
      ) unread_rollup ON unread_rollup.thread_id = mt.id
      WHERE mp_self.username = ?
      ORDER BY datetime(COALESCE(last_msg.created_at, mt.updated_at, mt.created_at)) DESC, mt.id DESC
    `,
    [username, username]
  );
  return rows.map((row) => ({
    id: Number(row.id || 0),
    subject: String(row.subject || ""),
    created_by: String(row.created_by || ""),
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
    unread_count: Math.max(0, Number.parseInt(row.unread_count, 10) || 0),
    last_message: {
      id: Number(row.last_message_id || 0),
      body: String(row.last_message_body || ""),
      created_at: row.last_message_at || "",
      sender_username: String(row.last_message_sender_username || ""),
    },
    participants: parseMessageParticipantsCsv(row.participants_csv || ""),
  }));
}

async function getMessageThreadPayloadForUser(threadId, username) {
  const access = await getMessageThreadAccess(threadId, username);
  const [participants, messages, unreadRow] = await Promise.all([
    all(
      `
        SELECT thread_id, username, role, joined_at, last_read_message_id, last_read_at
        FROM message_participants
        WHERE thread_id = ?
        ORDER BY
          CASE WHEN username = ? THEN 0 ELSE 1 END,
          username ASC
      `,
      [threadId, username]
    ),
    all(
      `
        SELECT id, thread_id, sender_username, sender_role, body, created_at
        FROM messages
        WHERE thread_id = ?
        ORDER BY id ASC
      `,
      [threadId]
    ),
    get(
      `
        SELECT COUNT(m.id) AS unread_count
        FROM message_participants mp
        LEFT JOIN messages m
          ON m.thread_id = mp.thread_id
         AND m.id > COALESCE(mp.last_read_message_id, 0)
         AND LOWER(COALESCE(m.sender_username, '')) <> LOWER(mp.username)
        WHERE mp.thread_id = ?
          AND mp.username = ?
      `,
      [threadId, username]
    ),
  ]);
  return {
    thread: {
      id: Number(access.thread.id || 0),
      subject: String(access.thread.subject || ""),
      created_by: String(access.thread.created_by || ""),
      created_at: access.thread.created_at || "",
      updated_at: access.thread.updated_at || "",
    },
    participants: participants.map((row) => ({
      thread_id: Number(row.thread_id || 0),
      username: String(row.username || ""),
      role: String(row.role || "").toLowerCase(),
      joined_at: row.joined_at || "",
      last_read_message_id: row.last_read_message_id ? Number(row.last_read_message_id) : null,
      last_read_at: row.last_read_at || null,
    })),
    messages: messages.map((row) => ({
      id: Number(row.id || 0),
      thread_id: Number(row.thread_id || 0),
      sender_username: String(row.sender_username || ""),
      sender_role: String(row.sender_role || "").toLowerCase(),
      body: String(row.body || ""),
      created_at: row.created_at || "",
    })),
    unread_count: Math.max(0, Number.parseInt(unreadRow?.unread_count, 10) || 0),
  };
}

async function markMessageThreadReadForUser(threadId, username) {
  const latest = await get(
    `
      SELECT id
      FROM messages
      WHERE thread_id = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [threadId]
  );
  const latestMessageId = latest ? Number(latest.id || 0) : 0;
  if (latestMessageId > 0) {
    await run(
      `
        UPDATE message_participants
        SET last_read_message_id = ?,
            last_read_at = CURRENT_TIMESTAMP
        WHERE thread_id = ?
          AND username = ?
      `,
      [latestMessageId, threadId, username]
    );
  } else {
    await run(
      `
        UPDATE message_participants
        SET last_read_at = CURRENT_TIMESTAMP
        WHERE thread_id = ?
          AND username = ?
      `,
      [threadId, username]
    );
  }
  return latestMessageId || null;
}

async function getMessageUnreadCounts(username) {
  const row = await get(
    `
      SELECT
        COALESCE(SUM(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END), 0) AS unread_threads,
        COALESCE(SUM(unread_count), 0) AS unread_messages
      FROM (
        SELECT
          mp.thread_id,
          COUNT(m.id) AS unread_count
        FROM message_participants mp
        LEFT JOIN messages m
          ON m.thread_id = mp.thread_id
         AND m.id > COALESCE(mp.last_read_message_id, 0)
         AND LOWER(COALESCE(m.sender_username, '')) <> LOWER(mp.username)
        WHERE mp.username = ?
        GROUP BY mp.thread_id
      ) counts
    `,
    [username]
  );
  return {
    unread_threads: Math.max(0, Number.parseInt(row?.unread_threads, 10) || 0),
    unread_messages: Math.max(0, Number.parseInt(row?.unread_messages, 10) || 0),
  };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function logAuditEvent(req, action, contentType, contentId, targetOwner, summary) {
  if (!req || !req.session || !req.session.user) {
    return;
  }
  try {
    await run(
      `
        INSERT INTO audit_logs (
          actor_username,
          actor_role,
          action,
          content_type,
          content_id,
          target_owner,
          summary
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        req.session.user.username,
        req.session.user.role,
        action,
        contentType,
        contentId || null,
        targetOwner || null,
        summary || null,
      ]
    );
  } catch (err) {
    console.error("Audit logging failed:", err);
  }
}

async function logReceiptEvent(receiptId, req, action, fromStatus, toStatus, notes) {
  if (!req || !req.session || !req.session.user) {
    return;
  }
  await run(
    `
      INSERT INTO payment_receipt_events (
        receipt_id,
        actor_username,
        actor_role,
        action,
        from_status,
        to_status,
        notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      receiptId,
      req.session.user.username,
      req.session.user.role,
      action,
      fromStatus || null,
      toStatus || null,
      notes || null,
    ]
  );
}

async function buildVerificationFlags(receiptRow, paymentItemRow) {
  const expected = Number(paymentItemRow?.expected_amount || 0);
  const paid = Number(receiptRow?.amount_paid || 0);
  const amountMatchesExpected = Number.isFinite(expected) && Number.isFinite(paid) && Math.abs(paid - expected) < 0.01;
  const paidAtDate = new Date(receiptRow?.paid_at || "");
  const dueDateValue = paymentItemRow?.due_date ? new Date(paymentItemRow.due_date) : null;
  let paidBeforeDue = null;
  if (dueDateValue && !Number.isNaN(dueDateValue.getTime()) && !Number.isNaN(paidAtDate.getTime())) {
    paidBeforeDue = paidAtDate.getTime() <= dueDateValue.getTime();
  }
  const duplicateRefRow = await get(
    `
      SELECT id
      FROM payment_receipts
      WHERE transaction_ref = ?
        AND id != ?
      LIMIT 1
    `,
    [receiptRow.transaction_ref, receiptRow.id]
  );
  return {
    amount_matches_expected: !!amountMatchesExpected,
    paid_before_due: paidBeforeDue,
    duplicate_reference: !!duplicateRefRow,
  };
}

async function extractReceiptText(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!resolved || !fs.existsSync(resolved)) {
    return {
      text: "",
      confidence: 0,
      provider: "none",
    };
  }

  if (OCR_PROVIDER === "ocrspace") {
    const remote = await extractTextWithOcrSpace(resolved);
    if (remote.text) {
      return remote;
    }
  }

  const local = await extractTextWithLocalTesseract(resolved);
  if (local.text) {
    return local;
  }

  return {
    text: "",
    confidence: 0,
    provider: OCR_PROVIDER === "ocrspace" ? "ocr-space" : "none",
  };
}

function ensureStatusTransition(fromStatus, toStatus) {
  const transitions = {
    submitted: new Set(["under_review"]),
    under_review: new Set(["approved", "rejected"]),
  };
  const allowed = transitions[fromStatus];
  return !!(allowed && allowed.has(toStatus));
}

function parseQueueFilters(query) {
  return {
    status: sanitizeReceiptStatus(query.status || ""),
    student: normalizeIdentifier(query.student || ""),
    dateFrom: String(query.dateFrom || "").trim(),
    dateTo: String(query.dateTo || "").trim(),
    paymentItemId: parseResourceId(query.paymentItemId),
    assignment: sanitizeAssignmentFilter(query.assignment || "all"),
  };
}

function buildReceiptQueueQuery(filters, limit = 100, options = {}) {
  const conditions = [];
  const params = [];
  const reviewerUsername = normalizeIdentifier(options.reviewerUsername || "");

  if (filters.status) {
    conditions.push("pr.status = ?");
    params.push(filters.status);
  }
  if (filters.student) {
    conditions.push("pr.student_username = ?");
    params.push(filters.student);
  }
  if (filters.dateFrom && isValidIsoLikeDate(filters.dateFrom)) {
    conditions.push("DATE(pr.submitted_at) >= DATE(?)");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo && isValidIsoLikeDate(filters.dateTo)) {
    conditions.push("DATE(pr.submitted_at) <= DATE(?)");
    params.push(filters.dateTo);
  }
  if (filters.paymentItemId) {
    conditions.push("pr.payment_item_id = ?");
    params.push(filters.paymentItemId);
  }
  if (filters.assignment === "mine" && reviewerUsername) {
    conditions.push("pr.assigned_reviewer = ?");
    params.push(reviewerUsername);
  }
  if (filters.assignment === "unassigned") {
    conditions.push("(pr.assigned_reviewer IS NULL OR pr.assigned_reviewer = '')");
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT
      pr.id,
      pr.payment_item_id,
      pr.student_username,
      pr.amount_paid,
      pr.paid_at,
      pr.transaction_ref,
      pr.status,
      pr.submitted_at,
      pr.assigned_reviewer,
      pr.assigned_at,
      pr.reviewed_by,
      pr.reviewed_at,
      pr.rejection_reason,
      pr.verification_notes,
      pr.extracted_text,
      pi.title AS payment_item_title,
      pi.expected_amount,
      pi.currency,
      pi.due_date,
      pi.available_until,
      pi.availability_days,
      pi.created_by AS payment_item_owner
    FROM payment_receipts pr
    JOIN payment_items pi ON pi.id = pr.payment_item_id
    ${whereClause}
    ORDER BY pr.submitted_at DESC, pr.id DESC
    LIMIT ${Number(limit) > 0 ? Number(limit) : 100}
  `;
  return { sql, params };
}

function getDaysUntilDue(dueDateValue) {
  if (!dueDateValue || !isValidIsoLikeDate(dueDateValue)) {
    return null;
  }
  const dueDate = new Date(String(dueDateValue));
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const diffMs = dueDate.getTime() - startOfToday.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function getReminderMetadata(daysUntilDue, outstandingAmount) {
  if (!Number.isFinite(outstandingAmount) || outstandingAmount <= 0) {
    return { level: "settled", text: "Settled" };
  }
  if (!Number.isFinite(daysUntilDue)) {
    return { level: "no_due_date", text: "No due date" };
  }
  if (daysUntilDue < 0) {
    return { level: "overdue", text: `Overdue by ${Math.abs(daysUntilDue)} day(s)` };
  }
  if (daysUntilDue === 0) {
    return { level: "today", text: "Due today" };
  }
  if (daysUntilDue <= 3) {
    return { level: "urgent", text: `Due in ${daysUntilDue} day(s)` };
  }
  if (daysUntilDue <= 7) {
    return { level: "soon", text: `Due in ${daysUntilDue} day(s)` };
  }
  return { level: "upcoming", text: `Due in ${daysUntilDue} day(s)` };
}

async function syncPaymentItemNotification(req, paymentItem) {
  if (!paymentItem || !paymentItem.id) {
    return;
  }
  const title = `New Payment Item: ${String(paymentItem.title || "").slice(0, 90)}`;
  const duePart = paymentItem.due_date ? `Due: ${paymentItem.due_date}. ` : "";
  let availabilityPart = "Available until removed by lecturer.";
  if (paymentItem.available_until) {
    const availableDate = new Date(paymentItem.available_until);
    if (!Number.isNaN(availableDate.getTime())) {
      availabilityPart = `Available until: ${availableDate.toISOString().slice(0, 10)}.`;
    }
  }
  const body = `${duePart}Amount: ${paymentItem.currency} ${Number(paymentItem.expected_amount || 0).toFixed(
    2
  )}. ${availabilityPart} ${String(paymentItem.description || "").trim()}`.trim();
  const existing = await get(
    "SELECT id FROM notifications WHERE related_payment_item_id = ? AND auto_generated = 1 LIMIT 1",
    [paymentItem.id]
  );
  if (existing) {
    await run(
      `
        UPDATE notifications
        SET title = ?,
            body = ?,
            category = 'Payments',
            is_urgent = 0,
            is_pinned = 0,
            expires_at = ?,
            created_by = ?
        WHERE id = ?
      `,
      [title.slice(0, 120), body.slice(0, 2000), paymentItem.available_until || null, req.session.user.username, existing.id]
    );
    return existing.id;
  }
  const result = await run(
    `
      INSERT INTO notifications (
        title,
        body,
        category,
        is_urgent,
        is_pinned,
        expires_at,
        related_payment_item_id,
        auto_generated,
        created_by
      )
      VALUES (?, ?, 'Payments', 0, 0, ?, ?, 1, ?)
    `,
    [title.slice(0, 120), body.slice(0, 2000), paymentItem.available_until || null, paymentItem.id, req.session.user.username]
  );
  return result.lastID;
}

async function getTeacherStatement(teacherUsername) {
  const row = await get(
    `
      SELECT teacher_username, original_filename, statement_file_path, parsed_rows_json, uploaded_at
      FROM teacher_payment_statements
      WHERE teacher_username = ?
      LIMIT 1
    `,
    [normalizeIdentifier(teacherUsername)]
  );
  if (!row) {
    return null;
  }
  let parsedRows = [];
  let extractedText = "";
  let unparsedRows = [];
  let parseStages = [];
  try {
    const payload = JSON.parse(row.parsed_rows_json || "[]");
    if (Array.isArray(payload)) {
      parsedRows = payload;
    } else if (payload && Array.isArray(payload.parsed_rows)) {
      parsedRows = payload.parsed_rows;
      extractedText = String(payload.extracted_text || "");
      unparsedRows = Array.isArray(payload.unparsed_rows) ? payload.unparsed_rows : [];
      parseStages = Array.isArray(payload.parse_stages) ? payload.parse_stages : [];
    }
  } catch (_err) {
    parsedRows = [];
  }
  return {
    ...row,
    parsed_rows: Array.isArray(parsedRows) ? parsedRows : [],
    extracted_text: extractedText,
    unparsed_rows: unparsedRows,
    parse_stages: parseStages,
  };
}

async function evaluateReceiptAgainstStatement(receiptRow, statementRows) {
  const studentVariants = await getStudentNameVariants(receiptRow.student_username);
  const parsedFromReceiptText = parseReceiptTextCandidates(receiptRow.extracted_text || "");
  const receiptDate = toDateOnly(receiptRow.paid_at);
  const normalizedRef = normalizeReference(receiptRow.transaction_ref || "");
  const paidAmount = Number(receiptRow.amount_paid || 0);
  const candidateRefs = Array.from(
    new Set([normalizedRef].concat(parsedFromReceiptText.references || []).filter(Boolean))
  );
  const candidateDates = Array.from(
    new Set([receiptDate].concat(parsedFromReceiptText.dates || []).filter(Boolean))
  );
  const candidateAmounts = Array.from(
    new Set([paidAmount].concat(parsedFromReceiptText.amounts || []).filter((value) => Number.isFinite(value)))
  );
  const candidateNames = new Set([...studentVariants, ...(parsedFromReceiptText.names || [])]);
  let matchedRow = null;

  for (const reference of candidateRefs) {
    matchedRow = statementRows.find((entry) => entry.normalized_reference === reference) || null;
    if (matchedRow) {
      break;
    }
  }
  if (!matchedRow) {
    matchedRow =
      statementRows.find((entry) => {
        const nameMatch =
          candidateNames.has(entry.normalized_name) ||
          (entry.normalized_description && candidateNames.has(entry.normalized_description));
        const amountMatch = candidateAmounts.some((amount) => almostSameAmount(entry.normalized_amount, amount));
        const dateMatch = candidateDates.includes(entry.normalized_date);
        return nameMatch && amountMatch && dateMatch;
      }) || null;
  }

  if (!matchedRow) {
    return {
      matched: false,
      compared_by_reference: candidateRefs.length > 0,
      name_match: false,
      amount_match: false,
      date_match: false,
      match_row_number: null,
      details: "No matching statement row found for this receipt.",
    };
  }

  const nameMatch =
    candidateNames.has(matchedRow.normalized_name) ||
    (matchedRow.normalized_description && candidateNames.has(matchedRow.normalized_description));
  const amountMatch = candidateAmounts.some((amount) => almostSameAmount(matchedRow.normalized_amount, amount));
  const dateMatch = candidateDates.includes(matchedRow.normalized_date);
  const refMatch = candidateRefs.length && matchedRow.normalized_reference
    ? candidateRefs.includes(matchedRow.normalized_reference)
    : null;

  return {
    matched: !!(nameMatch && amountMatch && dateMatch),
    compared_by_reference: candidateRefs.length > 0,
    name_match: nameMatch,
    amount_match: amountMatch,
    date_match: dateMatch,
    reference_match: refMatch,
    match_row_number: matchedRow.row_number,
    details: `Matched statement row ${matchedRow.row_number}.`,
  };
}

function getReconcileThresholds() {
  return {
    auto: toSafeConfidence(AUTO_RECONCILE_CONFIDENCE, 0.9),
    review: toSafeConfidence(REVIEW_RECONCILE_CONFIDENCE, 0.65),
  };
}

async function listStudentUsernames() {
  const rows = await all("SELECT auth_id FROM auth_roster WHERE role = 'student' ORDER BY auth_id ASC");
  return rows.map((row) => normalizeIdentifier(row.auth_id || "")).filter(Boolean);
}

async function resolveUniquePaymentReference(paymentItemId, studentUsername, existingObligationId) {
  const candidates = buildDeterministicReferenceCandidates(paymentItemId, studentUsername, 8);
  for (const candidate of candidates) {
    const conflict = await get(
      `
        SELECT id
        FROM payment_obligations
        WHERE payment_reference = ?
          AND id != COALESCE(?, -1)
        LIMIT 1
      `,
      [candidate, existingObligationId || null]
    );
    if (!conflict) {
      return candidate;
    }
  }
  throw new Error("Could not resolve unique deterministic payment reference.");
}

async function upsertPaymentObligation(paymentItemRow, studentUsername) {
  if (!paymentItemRow || !paymentItemRow.id) {
    return null;
  }
  const normalizedStudent = normalizeIdentifier(studentUsername);
  if (!normalizedStudent) {
    return null;
  }
  const existing = await get(
    `
      SELECT id
      FROM payment_obligations
      WHERE payment_item_id = ?
        AND student_username = ?
      LIMIT 1
    `,
    [paymentItemRow.id, normalizedStudent]
  );
  const reference = await resolveUniquePaymentReference(paymentItemRow.id, normalizedStudent, existing?.id || null);
  await run(
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
      VALUES (?, ?, ?, ?, ?, 'unpaid', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(payment_item_id, student_username) DO UPDATE SET
        expected_amount = excluded.expected_amount,
        due_date = excluded.due_date,
        payment_reference = excluded.payment_reference,
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      paymentItemRow.id,
      normalizedStudent,
      Number(paymentItemRow.expected_amount || 0),
      paymentItemRow.due_date || null,
      reference,
    ]
  );
  return get(
    `
      SELECT *
      FROM payment_obligations
      WHERE payment_item_id = ?
        AND student_username = ?
      LIMIT 1
    `,
    [paymentItemRow.id, normalizedStudent]
  );
}

async function ensurePaymentObligationsForPaymentItem(paymentItemId) {
  const paymentItem = await get("SELECT * FROM payment_items WHERE id = ? LIMIT 1", [paymentItemId]);
  if (!paymentItem) {
    return 0;
  }
  const students = await listStudentUsernames();
  let count = 0;
  for (const student of students) {
    const row = await upsertPaymentObligation(paymentItem, student);
    if (row) {
      count += 1;
    }
  }
  return count;
}

async function ensurePaymentObligationsForAllPaymentItems() {
  const items = await all("SELECT * FROM payment_items ORDER BY id ASC");
  let total = 0;
  for (const item of items) {
    total += await ensurePaymentObligationsForPaymentItem(item.id);
  }
  return total;
}

async function ensurePaymentObligationsForStudent(studentUsername) {
  const normalized = normalizeIdentifier(studentUsername);
  if (!normalized) {
    return 0;
  }
  const items = await all("SELECT * FROM payment_items ORDER BY id ASC");
  let total = 0;
  for (const item of items) {
    const row = await upsertPaymentObligation(item, normalized);
    if (row) {
      total += 1;
    }
  }
  return total;
}

function normalizeTransactionInput(input = {}) {
  const amount = parseMoneyValue(input.amount);
  const paidAtRaw = String(input.date || input.paid_at || input.paidAt || "").trim();
  const paidAt = paidAtRaw && isValidIsoLikeDate(paidAtRaw) ? new Date(paidAtRaw).toISOString() : "";
  const normalizedPaidDate = toDateOnly(paidAt || paidAtRaw);
  const txnRef = sanitizeTransactionRef(input.txn_ref || input.transactionRef || input.reference || "");
  const normalizedTxnRef = normalizeReference(txnRef);
  const payerName = normalizeWhitespace(input.payer_name || input.payerName || input.name || "");
  const normalizedPayerName = normalizeStatementName(payerName);
  const source = String(input.source || "statement_upload")
    .trim()
    .toLowerCase()
    .slice(0, 40);
  const sourceEventId = String(input.source_event_id || input.sourceEventId || "").trim().slice(0, 160);
  const sourceFileName = String(input.source_file_name || input.sourceFileName || "").trim().slice(0, 255);
  const studentHintUsername = normalizeIdentifier(input.student_username || input.studentUsername || "");
  const paymentItemHintId = parseResourceId(input.payment_item_id || input.paymentItemId || "");
  const rawPayload = input.raw_payload ?? input.rawPayload ?? input;
  const checksum = String(input.checksum || "").trim() || buildTransactionChecksum({
    source,
    txn_ref: txnRef,
    amount,
    date: normalizedPaidDate,
    payer_name: payerName,
  });
  if (!Number.isFinite(amount) || amount <= 0 || !normalizedPaidDate) {
    return null;
  }
  return {
    source,
    sourceEventId,
    sourceFileName,
    txnRef,
    amount,
    paidAt: paidAt || normalizedPaidDate,
    payerName,
    normalizedTxnRef,
    normalizedPaidDate,
    normalizedPayerName,
    studentHintUsername,
    paymentItemHintId,
    rawPayload,
    checksum: checksum || null,
  };
}

function toTransactionCandidateRow(normalized) {
  return {
    id: 0,
    source: normalized.source,
    amount: normalized.amount,
    paid_at: normalized.paidAt,
    normalized_paid_date: normalized.normalizedPaidDate,
    txn_ref: normalized.txnRef,
    normalized_txn_ref: normalized.normalizedTxnRef,
    payer_name: normalized.payerName,
    normalized_payer_name: normalized.normalizedPayerName,
    student_hint_username: normalized.studentHintUsername,
    payment_item_hint_id: normalized.paymentItemHintId,
  };
}

async function findDuplicateTransactionCandidate(transactionRow) {
  if (!transactionRow) {
    return null;
  }
  const currentId = Number(transactionRow.id || 0);
  if (transactionRow.normalized_txn_ref) {
    const byRef = await get(
      `
        SELECT *
        FROM payment_transactions
        WHERE id != ?
          AND normalized_txn_ref = ?
          AND status IN ('approved', 'needs_review', 'needs_student_confirmation', 'duplicate')
        ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END ASC, id DESC
        LIMIT 1
      `,
      [currentId, transactionRow.normalized_txn_ref]
    );
    if (byRef) {
      return byRef;
    }
  }
  if (!transactionRow.normalized_paid_date || !Number.isFinite(Number(transactionRow.amount || 0))) {
    return null;
  }
  return get(
    `
      SELECT *
      FROM payment_transactions
      WHERE id != ?
        AND normalized_paid_date = ?
        AND ABS(amount - ?) <= 0.01
        AND normalized_payer_name = ?
        AND status IN ('approved', 'needs_review', 'needs_student_confirmation', 'duplicate')
      ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END ASC, id DESC
      LIMIT 1
    `,
    [
      currentId,
      transactionRow.normalized_paid_date,
      Number(transactionRow.amount || 0),
      String(transactionRow.normalized_payer_name || ""),
    ]
  );
}

async function scoreObligationCandidate(transactionRow, obligationRow, variantsCache) {
  const reasons = [];
  let score = 0;
  const amount = Number(transactionRow.amount || 0);
  if (!Number.isFinite(amount) || !obligationRow) {
    return { score: 0, reasons: [] };
  }
  const expectedAmount = Number(obligationRow.expected_amount || 0);
  const outstanding = Math.max(0, expectedAmount - Number(obligationRow.amount_paid_total || 0));
  if (
    transactionRow.student_hint_username &&
    normalizeIdentifier(transactionRow.student_hint_username) === normalizeIdentifier(obligationRow.student_username)
  ) {
    score += 0.25;
    reasons.push("student_hint_match");
  }
  if (transactionRow.payment_item_hint_id && Number(transactionRow.payment_item_hint_id) === Number(obligationRow.payment_item_id)) {
    score += 0.2;
    reasons.push("item_hint_match");
  }
  if (almostSameAmount(amount, outstanding) || almostSameAmount(amount, expectedAmount)) {
    score += 0.3;
    reasons.push("amount_match");
  } else if (amount > expectedAmount * 0.5 && amount < expectedAmount * 1.5) {
    score += 0.1;
    reasons.push("amount_match");
  }
  const payer = String(transactionRow.normalized_payer_name || "");
  if (payer) {
    const studentKey = normalizeIdentifier(obligationRow.student_username);
    if (!variantsCache.has(studentKey)) {
      variantsCache.set(studentKey, await getStudentNameVariants(obligationRow.student_username));
    }
    const variants = variantsCache.get(studentKey) || new Set();
    const usernameToken = normalizeStatementName(String(obligationRow.student_username || "").replace(/[_-]+/g, " "));
    let nameMatch = usernameToken && payer.includes(usernameToken);
    if (!nameMatch) {
      for (const variant of variants) {
        const normalized = normalizeStatementName(variant);
        if (normalized && payer.includes(normalized)) {
          nameMatch = true;
          break;
        }
      }
    }
    if (nameMatch) {
      score += 0.2;
      reasons.push("payer_hint_match");
    }
  }
  const dueDate = toDateOnly(obligationRow.due_date);
  if (dueDate && transactionRow.normalized_paid_date) {
    const due = new Date(`${dueDate}T00:00:00.000Z`);
    const paid = new Date(`${transactionRow.normalized_paid_date}T00:00:00.000Z`);
    const diffDays = Math.abs((paid.getTime() - due.getTime()) / (24 * 60 * 60 * 1000));
    if (Number.isFinite(diffDays) && diffDays <= 45) {
      score += 0.1;
      reasons.push("date_proximity_match");
    }
  }
  return {
    score: Math.min(0.99, score),
    reasons: normalizeReasonCodes(reasons),
  };
}

async function pickBestObligationCandidate(transactionRow) {
  if (!transactionRow) {
    return null;
  }
  const normalizedRef = normalizeReference(transactionRow.normalized_txn_ref || transactionRow.txn_ref || "");
  if (normalizedRef) {
    const exact = await get(
      `
        SELECT po.*, pi.title AS payment_item_title
        FROM payment_obligations po
        JOIN payment_items pi ON pi.id = po.payment_item_id
        WHERE LOWER(po.payment_reference) = ?
        LIMIT 1
      `,
      [normalizedRef]
    );
    if (exact) {
      return { obligation: exact, score: 1, reasons: ["exact_reference"] };
    }
  }
  const conditions = [];
  const params = [];
  if (transactionRow.student_hint_username) {
    conditions.push("po.student_username = ?");
    params.push(normalizeIdentifier(transactionRow.student_hint_username));
  }
  if (transactionRow.payment_item_hint_id) {
    conditions.push("po.payment_item_id = ?");
    params.push(Number(transactionRow.payment_item_hint_id));
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  let candidates = await all(
    `
      SELECT po.*, pi.title AS payment_item_title
      FROM payment_obligations po
      JOIN payment_items pi ON pi.id = po.payment_item_id
      ${whereClause}
      ORDER BY po.updated_at DESC, po.id DESC
      LIMIT 300
    `,
    params
  );
  if (!candidates.length) {
    candidates = await all(
      `
        SELECT po.*, pi.title AS payment_item_title
        FROM payment_obligations po
        JOIN payment_items pi ON pi.id = po.payment_item_id
        ORDER BY po.updated_at DESC, po.id DESC
        LIMIT 300
      `
    );
  }
  if (!candidates.length) {
    return null;
  }
  const variantsCache = new Map();
  const scored = [];
  for (const candidate of candidates) {
    const scoreResult = await scoreObligationCandidate(transactionRow, candidate, variantsCache);
    if (scoreResult.score > 0) {
      scored.push({
        obligation: candidate,
        score: scoreResult.score,
        reasons: scoreResult.reasons,
      });
    }
  }
  if (!scored.length) {
    return null;
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (second && Math.abs(best.score - second.score) <= 0.05) {
    return {
      obligation: best.obligation,
      score: Math.max(0, best.score - 0.1),
      reasons: normalizeReasonCodes(best.reasons.concat("ambiguous_candidate")),
    };
  }
  return best;
}

async function recomputeObligationSnapshotById(obligationId) {
  if (!obligationId) {
    return null;
  }
  await run(
    `
      UPDATE payment_obligations
      SET amount_paid_total = COALESCE(
            (
              SELECT SUM(pt.amount)
              FROM payment_transactions pt
              WHERE pt.matched_obligation_id = payment_obligations.id
                AND pt.status = 'approved'
            ),
            0
          ),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [obligationId]
  );
  await run(
    `
      UPDATE payment_obligations
      SET status = CASE
        WHEN amount_paid_total <= 0.00001 THEN 'unpaid'
        WHEN amount_paid_total + 0.01 < expected_amount THEN 'partially_paid'
        WHEN amount_paid_total >= expected_amount - 0.01 AND amount_paid_total <= expected_amount + 0.01 THEN 'paid'
        ELSE 'overpaid'
      END,
      updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [obligationId]
  );
  return get("SELECT * FROM payment_obligations WHERE id = ? LIMIT 1", [obligationId]);
}

async function recomputeAllObligationSnapshots() {
  const rows = await all("SELECT id FROM payment_obligations");
  for (const row of rows) {
    await recomputeObligationSnapshotById(row.id);
  }
}

async function getReconciliationTransactionById(id) {
  return get(
    `
      SELECT
        pt.*,
        po.student_username,
        po.payment_item_id,
        po.expected_amount,
        po.payment_reference,
        pi.title AS payment_item_title,
        pi.currency
      FROM payment_transactions pt
      LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
      LEFT JOIN payment_items pi ON pi.id = po.payment_item_id
      WHERE pt.id = ?
      LIMIT 1
    `,
    [id]
  );
}

async function logReconciliationEvent(transactionId, obligationId, req, action, note) {
  const actorUsername = req?.session?.user?.username || "system";
  const actorRole = req?.session?.user?.role || "system";
  await run(
    `
      INSERT INTO reconciliation_events (
        transaction_id,
        obligation_id,
        actor_username,
        actor_role,
        action,
        note
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [transactionId || null, obligationId || null, actorUsername, actorRole, String(action || "").slice(0, 80), String(note || "").slice(0, 500)]
  );
  await run(
    `
      INSERT INTO audit_events (
        actor_id,
        actor_role,
        event_type,
        entity_type,
        entity_id,
        before_json,
        after_json
      )
      VALUES (?, ?, ?, 'payment_transaction', ?, NULL, ?)
    `,
    [actorUsername, actorRole, String(action || "").slice(0, 80), transactionId || null, JSON.stringify({ obligationId: obligationId || null, note: note || "" })]
  );
}

async function createReconciliationStatusNotification(studentUsername, paymentItemId, title, body, options = {}) {
  const student = normalizeIdentifier(studentUsername);
  if (!student) {
    return;
  }
  const finalTitle = `${String(title || "Payment Update").slice(0, 90)} (${student})`;
  const finalBody = String(body || "").slice(0, 1800);
  const createdBy = String(options.createdBy || "system-reconciliation")
    .trim()
    .slice(0, 80) || "system-reconciliation";
  await run(
    `
      INSERT INTO notifications (
        title,
        body,
        category,
        type,
        payload_json,
        user_id,
        read_at,
        is_urgent,
        is_pinned,
        expires_at,
        related_payment_item_id,
        auto_generated,
        created_by
      )
      VALUES (?, ?, 'Payments', ?, ?, ?, NULL, 0, 0, NULL, ?, 1, ?)
    `,
    [
      finalTitle,
      finalBody,
      "payment_status",
      JSON.stringify({ student, payment_item_id: paymentItemId || null }),
      student,
      paymentItemId || null,
      createdBy,
    ]
  );
}

function mapPaystackSessionStatusFromTransactionStatus(transactionStatus) {
  const normalized = String(transactionStatus || "").trim().toLowerCase();
  if (normalized === "approved") {
    return "approved";
  }
  if (!normalized) {
    return "pending_webhook";
  }
  if (normalized === "needs_review" || normalized === "needs_student_confirmation" || normalized === "unmatched") {
    return "under_review";
  }
  if (normalized === "duplicate" || normalized === "rejected") {
    return "failed";
  }
  return "under_review";
}

function getPaystackSystemRequest() {
  return {
    session: {
      user: {
        username: "system-paystack",
        role: "system-paystack",
      },
    },
  };
}

async function upsertPaystackSession(input = {}) {
  const obligationId = parseResourceId(input.obligationId || input.obligation_id);
  const studentId = normalizeIdentifier(input.studentId || input.student_id || "");
  const gatewayReference = sanitizeTransactionRef(input.gatewayReference || input.gateway_reference || "");
  const amount = Number(input.amount || 0);
  const status = String(input.status || "initiated")
    .trim()
    .toLowerCase()
    .slice(0, 40) || "initiated";
  const payload = input.payload || input.init_payload || {};
  if (!obligationId || !studentId || !gatewayReference || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
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
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(gateway_reference) DO UPDATE SET
        obligation_id = excluded.obligation_id,
        student_id = excluded.student_id,
        amount = excluded.amount,
        status = excluded.status,
        init_payload_json = excluded.init_payload_json,
        updated_at = CURRENT_TIMESTAMP
    `,
    [obligationId, studentId, gatewayReference, amount, status, JSON.stringify(payload)]
  );
  return get("SELECT * FROM paystack_sessions WHERE gateway_reference = ? LIMIT 1", [gatewayReference]);
}

async function updatePaystackSessionStatusByReference(reference, nextStatus, payload = null) {
  const gatewayReference = sanitizeTransactionRef(reference || "");
  const status = String(nextStatus || "").trim().toLowerCase().slice(0, 40);
  if (!gatewayReference || !status) {
    return null;
  }
  const existing = await get("SELECT * FROM paystack_sessions WHERE gateway_reference = ? LIMIT 1", [gatewayReference]);
  if (!existing) {
    return null;
  }
  const nextPayload = payload
    ? JSON.stringify(payload)
    : existing.init_payload_json || "{}";
  await run(
    `
      UPDATE paystack_sessions
      SET status = ?,
          init_payload_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [status, nextPayload, existing.id]
  );
  return get("SELECT * FROM paystack_sessions WHERE id = ? LIMIT 1", [existing.id]);
}

function normalizePaystackReferenceRequestStatus(value, fallback = "pending") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "pending" || normalized === "verified" || normalized === "failed") {
    return normalized;
  }
  return fallback;
}

function formatPaystackReferenceRequestRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id || 0),
    student_username: String(row.student_username || ""),
    obligation_id: parseResourceId(row.obligation_id),
    payment_item_id: parseResourceId(row.payment_item_id),
    payment_item_title: String(row.payment_item_title || ""),
    payment_item_owner: String(row.payment_item_owner || ""),
    reference: String(row.reference || ""),
    note: String(row.note || ""),
    status: normalizePaystackReferenceRequestStatus(row.status),
    result: parseJsonObject(row.result_json || "{}", {}),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    resolved_at: row.resolved_at || null,
    resolved_by: row.resolved_by || null,
    resolved_by_role: row.resolved_by_role || null,
  };
}

async function getPaystackReferenceRequestDetailsById(id) {
  const requestId = parseResourceId(id);
  if (!requestId) {
    return null;
  }
  const row = await get(
    `
      SELECT
        prr.*,
        po.payment_item_id,
        pi.title AS payment_item_title,
        pi.created_by AS payment_item_owner
      FROM paystack_reference_requests prr
      LEFT JOIN payment_obligations po ON po.id = prr.obligation_id
      LEFT JOIN payment_items pi ON pi.id = po.payment_item_id
      WHERE prr.id = ?
      LIMIT 1
    `,
    [requestId]
  );
  return formatPaystackReferenceRequestRow(row);
}

async function updatePaystackReferenceRequestById(id, input = {}) {
  const requestId = parseResourceId(id);
  if (!requestId) {
    return null;
  }
  const status = normalizePaystackReferenceRequestStatus(input.status, "pending");
  const result =
    input.result && typeof input.result === "object" && !Array.isArray(input.result)
      ? input.result
      : {};
  const resultJson = JSON.stringify(result);
  const shouldResolve = status !== "pending";
  const resolvedBy = shouldResolve
    ? normalizeIdentifier(input.resolvedBy || "").slice(0, 80) || "system-paystack"
    : null;
  const resolvedByRole = shouldResolve
    ? String(input.resolvedByRole || "")
        .trim()
        .toLowerCase()
        .slice(0, 40) || "system-paystack"
    : null;
  await run(
    `
      UPDATE paystack_reference_requests
      SET status = ?,
          result_json = ?,
          resolved_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
          resolved_by = ?,
          resolved_by_role = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [status, resultJson, shouldResolve ? 1 : 0, resolvedBy, resolvedByRole, requestId]
  );
  return getPaystackReferenceRequestDetailsById(requestId);
}

async function resolvePendingPaystackReferenceRequestsByReference(reference, input = {}) {
  const normalizedReference = normalizeReference(reference);
  if (!normalizedReference) {
    return [];
  }
  const rows = await all(
    `
      SELECT id
      FROM paystack_reference_requests
      WHERE normalized_reference = ?
        AND status = 'pending'
      ORDER BY id ASC
    `,
    [normalizedReference]
  );
  const updates = [];
  for (const row of rows) {
    const updated = await updatePaystackReferenceRequestById(row.id, input);
    if (updated) {
      updates.push(updated);
    }
  }
  return updates;
}

async function listPaystackReferenceRequests(options = {}) {
  const filters = [];
  const params = [];
  const status = normalizePaystackReferenceRequestStatus(options.status, "all");
  if (status !== "all") {
    filters.push("prr.status = ?");
    params.push(status);
  }
  const studentUsername = normalizeIdentifier(options.studentUsername || "");
  if (studentUsername) {
    filters.push("prr.student_username = ?");
    params.push(studentUsername);
  }
  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const requestedLimit = Number.parseInt(options.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 200;
  const rows = await all(
    `
      SELECT
        prr.*,
        po.payment_item_id,
        pi.title AS payment_item_title,
        pi.created_by AS payment_item_owner
      FROM paystack_reference_requests prr
      LEFT JOIN payment_obligations po ON po.id = prr.obligation_id
      LEFT JOIN payment_items pi ON pi.id = po.payment_item_id
      ${whereSql}
      ORDER BY
        CASE
          WHEN prr.status = 'pending' THEN 0
          WHEN prr.status = 'failed' THEN 1
          ELSE 2
        END ASC,
        prr.created_at DESC,
        prr.id DESC
      LIMIT ?
    `,
    params.concat(limit)
  );
  return rows.map((row) => formatPaystackReferenceRequestRow(row));
}

async function verifyAndIngestPaystackReference(reference, options = {}) {
  const safeReference = sanitizeTransactionRef(reference || "");
  if (!safeReference) {
    const err = new Error("A Paystack reference is required.");
    err.status = 400;
    err.code = "paystack_verify_reference_required";
    throw err;
  }
  if (!paystackClient.hasSecretKey) {
    const err = new Error("Paystack is not configured on this server.");
    err.status = 503;
    err.code = "paystack_verify_not_configured";
    throw err;
  }

  const verifyPayload = await paystackClient.verifyTransaction(safeReference);
  const verifyData = verifyPayload?.data || {};
  const gatewayStatus = String(verifyData.status || "")
    .trim()
    .toLowerCase();
  if (gatewayStatus !== "success") {
    const err = new Error(`Paystack transaction is ${gatewayStatus || "not successful"}.`);
    err.status = 409;
    err.code = "paystack_verify_not_successful";
    err.gateway_status = gatewayStatus || null;
    throw err;
  }

  const normalized = normalizePaystackTransactionForIngestion(
    {
      id: `verify-${verifyData.id || safeReference}`,
      event: "charge.success",
      data: verifyData,
    },
    {
      sourceEventId: `paystack-verify-${String(verifyData.id || safeReference).trim().slice(0, 120)}`,
    }
  );
  if (!normalized) {
    const err = new Error("Could not normalize verified Paystack transaction.");
    err.status = 400;
    err.code = "paystack_verify_invalid_payload";
    throw err;
  }

  const actorReq = options.actorReq || getPaystackSystemRequest();
  const ingest = await ingestNormalizedTransaction(normalized.payload, {
    actorReq,
    allowAutoApprove: true,
  });
  if (!ingest.ok) {
    const err = new Error(ingest.error || "Could not ingest verified transaction.");
    err.status = 400;
    err.code = "paystack_verify_ingest_failed";
    throw err;
  }

  const transactionId = parseResourceId(ingest.transaction?.id);
  const transaction = transactionId ? await getReconciliationTransactionById(transactionId) : ingest.transaction || null;
  const nextSessionStatus = mapPaystackSessionStatusFromTransactionStatus(transaction?.status);
  const gatewayReference = sanitizeTransactionRef(normalized.gatewayReference || safeReference);
  const existingSession = await get("SELECT * FROM paystack_sessions WHERE gateway_reference = ? LIMIT 1", [gatewayReference]);
  if (existingSession) {
    const verifiedBy =
      String(options.verifiedBy || actorReq?.session?.user?.username || "")
        .trim()
        .slice(0, 80) || "system-paystack";
    const verifiedByRole =
      String(options.verifiedByRole || actorReq?.session?.user?.role || "")
        .trim()
        .slice(0, 40) || "system-paystack";
    await updatePaystackSessionStatusByReference(gatewayReference, nextSessionStatus, {
      verified_at: new Date().toISOString(),
      verified_by: verifiedBy,
      verified_by_role: verifiedByRole,
      transaction_id: transaction?.id || null,
    });
  }

  return {
    reference: gatewayReference,
    gatewayStatus,
    ingest,
    transaction,
    sessionStatus: nextSessionStatus,
  };
}

function reconciliationDecisionFromStatus(statusValue) {
  const status = String(statusValue || "").toLowerCase();
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "duplicate") return "duplicate";
  if (status === "needs_review" || status === "needs_student_confirmation" || status === "unmatched") return "exception";
  return "pending";
}

function reconciliationExceptionStatus(statusValue) {
  const status = String(statusValue || "").toLowerCase();
  if (status === "needs_student_confirmation") return "pending_student";
  if (status === "approved" || status === "rejected") return "resolved";
  return "open";
}

function primaryExceptionReason(reasons, statusValue) {
  const normalized = Array.isArray(reasons) ? reasons : [];
  if (normalized.length) {
    return String(normalized[0]).slice(0, 80);
  }
  const status = String(statusValue || "").toLowerCase();
  if (status === "duplicate") return "duplicate_transaction";
  if (status === "needs_student_confirmation") return "needs_student_confirmation";
  if (status === "unmatched") return "no_candidate";
  return "manual_review";
}

async function syncPaymentMatchAndExceptionRecords(transactionId, req, decidedByOverride, options = {}) {
  const id = parseResourceId(transactionId);
  if (!id) {
    return;
  }
  const tx = await get("SELECT * FROM payment_transactions WHERE id = ? LIMIT 1", [id]);
  if (!tx) {
    return;
  }
  const reasons = normalizeReasonCodes(parseJsonArray(tx.reasons_json || "[]", []));
  const decision = reconciliationDecisionFromStatus(tx.status);
  const decidedBy = decidedByOverride || tx.reviewed_by || req?.session?.user?.username || (decision === "pending" ? null : "system");
  const decidedAt = decision === "pending" ? null : tx.reviewed_at || new Date().toISOString();
  await run(
    `
      INSERT INTO payment_matches (
        obligation_id,
        transaction_id,
        confidence,
        reasons_json,
        decision,
        decided_by,
        decided_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET
        obligation_id = excluded.obligation_id,
        confidence = excluded.confidence,
        reasons_json = excluded.reasons_json,
        decision = excluded.decision,
        decided_by = excluded.decided_by,
        decided_at = excluded.decided_at
    `,
    [
      tx.matched_obligation_id || null,
      id,
      toSafeConfidence(tx.confidence, 0),
      JSON.stringify(reasons),
      decision,
      decidedBy,
      decidedAt,
    ]
  );
  const matchRow = await get("SELECT id FROM payment_matches WHERE transaction_id = ? LIMIT 1", [id]);
  if (!matchRow) {
    return;
  }
  const status = String(tx.status || "").toLowerCase();
  if (["needs_review", "needs_student_confirmation", "unmatched", "duplicate"].includes(status)) {
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
        VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(match_id) DO UPDATE SET
          reason = excluded.reason,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `,
      [matchRow.id, primaryExceptionReason(reasons, status), reconciliationExceptionStatus(status)]
    );
    return;
  }
  await run(
    `
      UPDATE reconciliation_exceptions
      SET status = 'resolved',
          updated_at = CURRENT_TIMESTAMP
      WHERE match_id = ?
    `,
    [matchRow.id]
  );

  if (status === "approved" && !options.skipApprovedReceiptGeneration) {
    const receiptGeneration = await ensureApprovedReceiptGeneratedForTransaction(id, {
      actorReq:
        req && req.session && req.session.user
          ? req
          : createSystemActorRequest("system-reconciliation", "system-reconciliation"),
      reason: String(options.approvedReceiptReason || "approved_status_written").trim().slice(0, 120) || "approved_status_written",
    });
    if (!receiptGeneration.ok && receiptGeneration.attempted) {
      console.error(
        `[approved-receipts] status-based generation failed transaction_id=${id} reason=${
          receiptGeneration.delivery?.error || receiptGeneration.reason || receiptGeneration.error || "unknown"
        }`
      );
    }
  }
}

async function reconcileTransactionById(transactionId, options = {}) {
  const id = parseResourceId(transactionId);
  if (!id) {
    return null;
  }
  const allowAutoApprove = options.allowAutoApprove !== false;
  const row = await get("SELECT * FROM payment_transactions WHERE id = ? LIMIT 1", [id]);
  if (!row) {
    return null;
  }
  if (!options.force && ["approved", "rejected"].includes(String(row.status || "").toLowerCase())) {
    return getReconciliationTransactionById(id);
  }
  const duplicate = await findDuplicateTransactionCandidate(row);
  if (duplicate) {
    const reasonCodes = normalizeReasonCodes(["duplicate_transaction"]);
    await run(
      `
        UPDATE payment_transactions
        SET status = 'duplicate',
            matched_obligation_id = ?,
            confidence = 0.2,
            reasons_json = ?,
            reviewed_by = NULL,
            reviewed_at = NULL
        WHERE id = ?
      `,
      [duplicate.matched_obligation_id || null, JSON.stringify(reasonCodes), id]
    );
    await logReconciliationEvent(id, duplicate.matched_obligation_id || null, options.actorReq, "duplicate_detected", `Duplicate of #${duplicate.id}`);
    await syncPaymentMatchAndExceptionRecords(id, options.actorReq);
    return getReconciliationTransactionById(id);
  }
  const best = await pickBestObligationCandidate(row);
  const thresholds = getReconcileThresholds();
  if (!best || !best.obligation) {
    const reasons = normalizeReasonCodes(["no_candidate"]);
    await run(
      `
        UPDATE payment_transactions
        SET status = 'unmatched',
            matched_obligation_id = NULL,
            confidence = 0,
            reasons_json = ?,
            reviewed_by = NULL,
            reviewed_at = NULL
        WHERE id = ?
      `,
      [JSON.stringify(reasons), id]
    );
    await logReconciliationEvent(id, null, options.actorReq, "no_match", "No obligation candidate found.");
    await syncPaymentMatchAndExceptionRecords(id, options.actorReq);
    return getReconciliationTransactionById(id);
  }
  const reasons = normalizeReasonCodes(best.reasons || []);
  if (best.score < thresholds.review) {
    const lowScoreReasons = normalizeReasonCodes(reasons.concat("low_confidence"));
    await run(
      `
        UPDATE payment_transactions
        SET status = 'unmatched',
            matched_obligation_id = ?,
            confidence = ?,
            reasons_json = ?,
            reviewed_by = NULL,
            reviewed_at = NULL
        WHERE id = ?
      `,
      [best.obligation.id, toSafeConfidence(best.score, 0), JSON.stringify(lowScoreReasons), id]
    );
    await logReconciliationEvent(
      id,
      best.obligation.id,
      options.actorReq,
      "low_confidence_unmatched",
      `Best score ${best.score.toFixed(2)} below threshold ${thresholds.review.toFixed(2)}.`
    );
    await syncPaymentMatchAndExceptionRecords(id, options.actorReq);
    return getReconciliationTransactionById(id);
  }
  const shouldAutoApprove = allowAutoApprove && best.score >= thresholds.auto;
  const nextStatus = shouldAutoApprove ? "approved" : "needs_review";
  await run(
    `
      UPDATE payment_transactions
      SET status = ?,
          matched_obligation_id = ?,
          confidence = ?,
          reasons_json = ?,
          reviewed_by = NULL,
          reviewed_at = NULL
      WHERE id = ?
    `,
    [nextStatus, best.obligation.id, toSafeConfidence(best.score, 0), JSON.stringify(reasons), id]
  );
  await logReconciliationEvent(
    id,
    best.obligation.id,
    options.actorReq,
    shouldAutoApprove ? "auto_approved" : "queued_for_review",
    shouldAutoApprove ? `Auto-approved with confidence ${best.score.toFixed(2)}` : `Queued for review (${best.score.toFixed(2)})`
  );
  await syncPaymentMatchAndExceptionRecords(id, options.actorReq, null, {
    approvedReceiptReason: shouldAutoApprove ? "auto_approved_transaction" : "",
  });
  if (shouldAutoApprove) {
    const obligation = await recomputeObligationSnapshotById(best.obligation.id);
    if (obligation) {
      await createReconciliationStatusNotification(
        obligation.student_username,
        obligation.payment_item_id,
        "Payment auto-confirmed",
        `A transaction was auto-matched to ${best.obligation.payment_item_title || "your payment item"} and approved.`
      );
    }
  }
  return getReconciliationTransactionById(id);
}

async function ingestNormalizedTransaction(input, options = {}) {
  const normalized = normalizeTransactionInput(input);
  if (!normalized) {
    return { ok: false, error: "Invalid transaction payload." };
  }
  try {
    return await withSqlTransaction(async () => {
      if (normalized.sourceEventId) {
        const byEvent = await get("SELECT * FROM payment_transactions WHERE source_event_id = ? LIMIT 1", [normalized.sourceEventId]);
        if (byEvent) {
          return { ok: true, inserted: false, idempotent: true, duplicateKey: "source_event_id", transaction: byEvent };
        }
      }
      if ((normalized.source === "statement_upload" || normalized.source === PAYSTACK_SOURCE) && normalized.checksum) {
        const byChecksum = await get(
          "SELECT * FROM payment_transactions WHERE source = ? AND checksum = ? LIMIT 1",
          [normalized.source, normalized.checksum]
        );
        if (byChecksum) {
          return { ok: true, inserted: false, idempotent: true, duplicateKey: "checksum", transaction: byChecksum };
        }
      }
      const insert = await run(
        `
          INSERT INTO payment_transactions (
            txn_ref,
            amount,
            paid_at,
            payer_name,
            source,
            source_event_id,
            source_file_name,
            normalized_txn_ref,
            normalized_paid_date,
            normalized_payer_name,
            student_hint_username,
            payment_item_hint_id,
            checksum,
            raw_payload_json,
            status,
            reasons_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', '[]')
        `,
        [
          normalized.txnRef || "",
          normalized.amount,
          normalized.paidAt,
          normalized.payerName || "",
          normalized.source,
          normalized.sourceEventId || null,
          normalized.sourceFileName || "",
          normalized.normalizedTxnRef || "",
          normalized.normalizedPaidDate || "",
          normalized.normalizedPayerName || "",
          normalized.studentHintUsername || null,
          normalized.paymentItemHintId || null,
          normalized.checksum || null,
          JSON.stringify(normalized.rawPayload || {}),
        ]
      );
      const reconciled = await reconcileTransactionById(insert.lastID, {
        actorReq: options.actorReq || null,
        allowAutoApprove: options.allowAutoApprove !== false,
        force: true,
      });
      return {
        ok: true,
        inserted: true,
        idempotent: false,
        transaction: reconciled || (await get("SELECT * FROM payment_transactions WHERE id = ? LIMIT 1", [insert.lastID])),
      };
    });
  } catch (err) {
    const message = String(err?.message || "");
    if (message.includes("source_event_id")) {
      const row = await get("SELECT * FROM payment_transactions WHERE source_event_id = ? LIMIT 1", [normalized.sourceEventId]);
      return { ok: true, inserted: false, idempotent: true, duplicateKey: "source_event_id", transaction: row };
    }
    if (message.includes("source, checksum")) {
      const row = await get("SELECT * FROM payment_transactions WHERE source = ? AND checksum = ? LIMIT 1", [
        normalized.source,
        normalized.checksum,
      ]);
      return { ok: true, inserted: false, idempotent: true, duplicateKey: "checksum", transaction: row };
    }
    return { ok: false, error: "Could not ingest transaction." };
  }
}

function normalizeStatementRowForIngestion(row, rowIndex, actorUsername, sourceFileName) {
  const rowNumber = Number.parseInt(row?.row_number, 10) || rowIndex + 1;
  const reference = String(row?.raw_reference || row?.normalized_reference || "").trim();
  const amount = Number(row?.normalized_amount || parseAmountToken(row?.raw_amount || row?.raw_credit || ""));
  const date = parseDateToken(row?.normalized_date || row?.raw_date || "");
  const payerName = String(row?.raw_name || row?.raw_description || row?.normalized_name || "").trim();
  const reasons = [];
  if (!reference) reasons.push("missing_reference");
  if (!Number.isFinite(amount) || amount <= 0) reasons.push("invalid_amount");
  if (!date) reasons.push("invalid_date");
  if (!payerName) reasons.push("missing_payer_name");
  if (reasons.length) {
    return {
      ok: false,
      rowNumber,
      invalid: {
        row_number: rowNumber,
        raw: row,
        reasons,
      },
    };
  }
  const checksum = buildTransactionChecksum({
    source: "statement_upload",
    txn_ref: reference,
    amount,
    date,
    payer_name: payerName,
  });
  const eventHash = crypto
    .createHash("sha1")
    .update(`${actorUsername}|${sourceFileName}|${checksum || rowNumber}`)
    .digest("hex")
    .slice(0, 40);
  return {
    ok: true,
    rowNumber,
    payload: {
      source: "statement_upload",
      source_event_id: `statement-${eventHash}`,
      txn_ref: reference,
      amount,
      date,
      payer_name: payerName,
      student_username: normalizeIdentifier(String(row?.normalized_name || "").trim()),
      source_file_name: sourceFileName,
      raw_payload: row,
      checksum,
    },
  };
}

async function previewStatementTransactionDecision(input) {
  const normalized = normalizeTransactionInput(input);
  if (!normalized) {
    return { status: "invalid", confidence: 0, reasons: ["invalid_payload"], matched_obligation_id: null };
  }
  if (normalized.checksum) {
    const existing = await get("SELECT id, status FROM payment_transactions WHERE source = ? AND checksum = ? LIMIT 1", [
      normalized.source,
      normalized.checksum,
    ]);
    if (existing) {
      return {
        status: String(existing.status || "idempotent"),
        confidence: 1,
        reasons: ["checksum_idempotent"],
        matched_obligation_id: null,
        existing_transaction_id: existing.id,
      };
    }
  }
  const candidate = toTransactionCandidateRow(normalized);
  const duplicate = await findDuplicateTransactionCandidate(candidate);
  if (duplicate) {
    return {
      status: "duplicate",
      confidence: 0.2,
      reasons: ["duplicate_transaction"],
      matched_obligation_id: duplicate.matched_obligation_id || null,
      existing_transaction_id: duplicate.id,
    };
  }
  const best = await pickBestObligationCandidate(candidate);
  const thresholds = getReconcileThresholds();
  if (!best || !best.obligation) {
    return {
      status: "unmatched",
      confidence: 0,
      reasons: ["no_candidate"],
      matched_obligation_id: null,
    };
  }
  if (best.score < thresholds.review) {
    return {
      status: "unmatched",
      confidence: toSafeConfidence(best.score, 0),
      reasons: normalizeReasonCodes((best.reasons || []).concat("low_confidence")),
      matched_obligation_id: best.obligation.id,
    };
  }
  if (best.score >= thresholds.auto) {
    return {
      status: "approved",
      confidence: toSafeConfidence(best.score, 0),
      reasons: normalizeReasonCodes(best.reasons || []),
      matched_obligation_id: best.obligation.id,
    };
  }
  return {
    status: "needs_review",
    confidence: toSafeConfidence(best.score, 0),
    reasons: normalizeReasonCodes(best.reasons || []),
    matched_obligation_id: best.obligation.id,
  };
}

async function ingestStatementRowsAsTransactions(req, parsedRows, originalFilename, options = {}) {
  const dryRun = options.dryRun === true;
  const actor = normalizeIdentifier(req?.session?.user?.username || "teacher");
  const sourceFileName = String(originalFilename || "").slice(0, 255);
  const summary = {
    dryRun,
    totalRows: Array.isArray(parsedRows) ? parsedRows.length : 0,
    inserted: 0,
    idempotent: 0,
    invalid: 0,
    autoApproved: 0,
    exceptions: 0,
    rowResults: [],
    unparsedRows: [],
  };
  for (let i = 0; i < (parsedRows || []).length; i += 1) {
    const normalizedRow = normalizeStatementRowForIngestion(parsedRows[i], i, actor, sourceFileName);
    if (!normalizedRow.ok) {
      summary.invalid += 1;
      summary.unparsedRows.push(normalizedRow.invalid);
      summary.rowResults.push({
        row_number: normalizedRow.rowNumber,
        ok: false,
        code: "invalid_row",
        reasons: normalizedRow.invalid.reasons,
      });
      continue;
    }
    if (dryRun) {
      const preview = await previewStatementTransactionDecision(normalizedRow.payload);
      const status = String(preview.status || "").toLowerCase();
      if (status === "approved") {
        summary.autoApproved += 1;
      } else if (["needs_review", "unmatched", "duplicate", "needs_student_confirmation"].includes(status)) {
        summary.exceptions += 1;
      }
      summary.rowResults.push({ row_number: normalizedRow.rowNumber, ok: true, code: "dry_run_preview", preview });
      continue;
    }
    const ingest = await ingestNormalizedTransaction(normalizedRow.payload, { actorReq: req, allowAutoApprove: true });
    if (!ingest.ok) {
      summary.rowResults.push({
        row_number: normalizedRow.rowNumber,
        ok: false,
        code: "ingest_failed",
        error: ingest.error || "Could not ingest row.",
      });
      continue;
    }
    if (ingest.inserted) {
      summary.inserted += 1;
    } else if (ingest.idempotent) {
      summary.idempotent += 1;
    }
    const status = String(ingest.transaction?.status || "").toLowerCase();
    if (status === "approved") {
      summary.autoApproved += 1;
    } else if (["needs_review", "unmatched", "duplicate", "needs_student_confirmation"].includes(status)) {
      summary.exceptions += 1;
    }
    summary.rowResults.push({
      row_number: normalizedRow.rowNumber,
      ok: true,
      code: ingest.idempotent ? "idempotent" : "ingested",
      transaction_id: ingest.transaction?.id || null,
      status: ingest.transaction?.status || null,
      reasons: parseJsonArray(ingest.transaction?.reasons_json || "[]", []),
    });
  }
  return summary;
}

const ANALYTICS_TOP_ITEM_SORT_TO_ORDER_BY = Object.freeze({
  collected_desc: "collected_total DESC, transaction_count DESC, pi.id ASC",
  collected_asc: "collected_total ASC, transaction_count DESC, pi.id ASC",
  transactions_desc: "transaction_count DESC, collected_total DESC, pi.id ASC",
  transactions_asc: "transaction_count ASC, collected_total DESC, pi.id ASC",
  outstanding_desc: "outstanding_amount DESC, collected_total DESC, pi.id ASC",
  outstanding_asc: "outstanding_amount ASC, collected_total DESC, pi.id ASC",
  title_asc: "pi.title COLLATE NOCASE ASC, pi.id ASC",
});

function asFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toAnalyticsAmount(value) {
  return Number(asFiniteNumber(value, 0).toFixed(2));
}

function toAnalyticsPercent(value) {
  return Number(asFiniteNumber(value, 0).toFixed(2));
}

function getAnalyticsDefaultDateRange(days = 30) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  const toDate = new Date();
  toDate.setHours(0, 0, 0, 0);
  const fromDate = new Date(toDate.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
  };
}

function isStrictIsoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  if (!isValidIsoLikeDate(text)) {
    return false;
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function parseAnalyticsGranularity(rawValue, options = {}) {
  const value = String(rawValue || "").trim().toLowerCase();
  const required = options.required === true;
  if (!value) {
    if (required) {
      throw { status: 400, error: "Query parameter 'granularity' is required (day, week, month)." };
    }
    return "day";
  }
  if (!["day", "week", "month"].includes(value)) {
    throw { status: 400, error: "Query parameter 'granularity' must be one of: day, week, month." };
  }
  return value;
}

function parseAnalyticsLimit(rawValue, defaultLimit = 10, maxLimit = 50) {
  const text = String(rawValue ?? "").trim();
  if (!text) {
    return defaultLimit;
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxLimit) {
    throw {
      status: 400,
      error: `Query parameter 'limit' must be an integer between 1 and ${maxLimit}.`,
    };
  }
  return parsed;
}

function parseAnalyticsTopItemsSort(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) {
    return "collected_desc";
  }
  if (!ANALYTICS_TOP_ITEM_SORT_TO_ORDER_BY[value]) {
    throw {
      status: 400,
      error:
        "Query parameter 'sort' must be one of: collected_desc, collected_asc, transactions_desc, transactions_asc, outstanding_desc, outstanding_asc, title_asc.",
    };
  }
  return value;
}

async function parseAnalyticsFilters(req, queryInput, options = {}) {
  const query = queryInput || {};
  const defaultRange = getAnalyticsDefaultDateRange();
  const fromRaw = String(query.from || "").trim();
  const toRaw = String(query.to || "").trim();
  const from = fromRaw || defaultRange.from;
  const to = toRaw || defaultRange.to;
  if (!isStrictIsoDate(from)) {
    throw { status: 400, error: "Query parameter 'from' must be a valid date in YYYY-MM-DD format." };
  }
  if (!isStrictIsoDate(to)) {
    throw { status: 400, error: "Query parameter 'to' must be a valid date in YYYY-MM-DD format." };
  }
  if (from > to) {
    throw { status: 400, error: "Query parameter 'from' must be less than or equal to 'to'." };
  }

  const paymentItemRaw = String(query.paymentItemId || "").trim();
  const paymentItemId = paymentItemRaw ? parseResourceId(paymentItemRaw) : null;
  if (paymentItemRaw && !paymentItemId) {
    throw { status: 400, error: "Query parameter 'paymentItemId' must be a positive integer." };
  }
  if (paymentItemId) {
    const row = await get("SELECT id, created_by FROM payment_items WHERE id = ? LIMIT 1", [paymentItemId]);
    if (!row) {
      throw { status: 400, error: "Query parameter 'paymentItemId' is invalid." };
    }
    if (!isAdminSession(req) && normalizeIdentifier(row.created_by) !== normalizeIdentifier(req.session.user.username)) {
      throw { status: 400, error: "Query parameter 'paymentItemId' is invalid." };
    }
  }

  const filters = {
    from,
    to,
    paymentItemId,
    granularity: parseAnalyticsGranularity(query.granularity, {
      required: options.requireGranularity === true,
    }),
  };

  if (options.includeLimit) {
    filters.limit = parseAnalyticsLimit(
      query.limit,
      Number.isFinite(options.defaultLimit) ? Number(options.defaultLimit) : 10,
      Number.isFinite(options.maxLimit) ? Number(options.maxLimit) : 50
    );
  }
  if (options.includeSort) {
    filters.sort = parseAnalyticsTopItemsSort(query.sort);
  }
  return filters;
}

function buildAnalyticsScopedWhereClause(req, filters, options = {}) {
  const conditions = [];
  const params = [];
  const includeDateRange = options.includeDateRange !== false;
  const includePaymentItemFilter = options.includePaymentItemFilter !== false;
  const dateExpression = String(options.dateExpression || "COALESCE(pt.paid_at, pt.created_at)");
  const paymentItemExpression = String(options.paymentItemExpression || "pi.id");
  const paymentItemOwnerExpression = String(options.paymentItemOwnerExpression || "pi.created_by");

  if (includeDateRange) {
    conditions.push(`DATE(${dateExpression}) >= DATE(?)`);
    params.push(filters.from);
    conditions.push(`DATE(${dateExpression}) <= DATE(?)`);
    params.push(filters.to);
  }
  if (includePaymentItemFilter && filters.paymentItemId) {
    conditions.push(`${paymentItemExpression} = ?`);
    params.push(filters.paymentItemId);
  }
  if (!isAdminSession(req)) {
    conditions.push(`${paymentItemOwnerExpression} = ?`);
    params.push(req.session.user.username);
  }
  if (Array.isArray(options.extraConditions)) {
    options.extraConditions
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .forEach((entry) => conditions.push(entry));
  }
  if (Array.isArray(options.extraParams) && options.extraParams.length) {
    params.push(...options.extraParams);
  }

  return {
    conditions,
    params,
    whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
  };
}

function getAnalyticsBucketExpression(granularity, dateExpression) {
  const normalized = String(granularity || "day").trim().toLowerCase();
  const safeDateExpression = `DATE(${String(dateExpression || "CURRENT_TIMESTAMP")})`;
  if (normalized === "week") {
    return `strftime('%Y-W%W', ${safeDateExpression})`;
  }
  if (normalized === "month") {
    return `strftime('%Y-%m', ${safeDateExpression})`;
  }
  return `strftime('%Y-%m-%d', ${safeDateExpression})`;
}

async function getAnalyticsOverviewPayload(req, filters) {
  const transactionScoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
    paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
    paymentItemOwnerExpression: "pi.created_by",
  });
  const obligationScoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(po.due_date, po.created_at)",
    paymentItemExpression: "po.payment_item_id",
    paymentItemOwnerExpression: "pi.created_by",
  });
  const exceptionScoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
    paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
    paymentItemOwnerExpression: "pi.created_by",
    extraConditions: ["re.status = 'open'"],
  });
  const receiptScoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(pr.reviewed_at, pr.submitted_at)",
    paymentItemExpression: "pr.payment_item_id",
    paymentItemOwnerExpression: "pi.created_by",
  });
  const receiptConditions = ["pr.status = 'approved'"].concat(receiptScoped.conditions);
  const receiptWhere = receiptConditions.length ? `WHERE ${receiptConditions.join(" AND ")}` : "";

  const [collectedRow, obligationRow, exceptionRow, receiptRow] = await Promise.all([
    get(
      `
        SELECT
          COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN pt.amount ELSE 0 END), 0) AS total_collected,
          COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_count,
          COALESCE(
            SUM(
              CASE
                WHEN pt.status = 'approved' AND COALESCE(pt.reasons_json, '[]') NOT LIKE '%manual_approved%' THEN 1
                ELSE 0
              END
            ),
            0
          ) AS auto_approved_count
        FROM payment_transactions pt
        LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
        LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
        ${transactionScoped.whereClause}
      `,
      transactionScoped.params
    ),
    get(
      `
        SELECT
          COALESCE(SUM(po.expected_amount), 0) AS expected_total,
          COALESCE(
            SUM(
              CASE
                WHEN po.expected_amount - COALESCE(po.amount_paid_total, 0) > 0.01 THEN po.expected_amount - COALESCE(po.amount_paid_total, 0)
                ELSE 0
              END
            ),
            0
          ) AS outstanding_total
        FROM payment_obligations po
        JOIN payment_items pi ON pi.id = po.payment_item_id
        ${obligationScoped.whereClause}
      `,
      obligationScoped.params
    ),
    get(
      `
        SELECT COUNT(*) AS open_exceptions
        FROM reconciliation_exceptions re
        JOIN payment_matches pm ON pm.id = re.match_id
        JOIN payment_transactions pt ON pt.id = pm.transaction_id
        LEFT JOIN payment_obligations po ON po.id = COALESCE(pm.obligation_id, pt.matched_obligation_id)
        LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
        ${exceptionScoped.whereClause}
      `,
      exceptionScoped.params
    ),
    get(
      `
        SELECT
          COUNT(*) AS approved_receipt_total,
          COALESCE(
            SUM(
              CASE
                WHEN COALESCE(ard.receipt_sent, 0) = 1 AND COALESCE(ard.receipt_file_path, '') != '' THEN 1
                ELSE 0
              END
            ),
            0
          ) AS approved_receipt_success
        FROM payment_receipts pr
        JOIN payment_items pi ON pi.id = pr.payment_item_id
        LEFT JOIN approved_receipt_dispatches ard ON ard.payment_receipt_id = pr.id
        ${receiptWhere}
      `,
      receiptScoped.params
    ),
  ]);

  const totalCollected = toAnalyticsAmount(collectedRow?.total_collected);
  const expectedAmount = toAnalyticsAmount(obligationRow?.expected_total);
  const outstandingAmount = toAnalyticsAmount(obligationRow?.outstanding_total);
  const approvedCount = asFiniteNumber(collectedRow?.approved_count, 0);
  const autoApprovedCount = asFiniteNumber(collectedRow?.auto_approved_count, 0);
  const openExceptionsCount = Math.max(0, Math.floor(asFiniteNumber(exceptionRow?.open_exceptions, 0)));
  const approvedReceiptTotal = asFiniteNumber(receiptRow?.approved_receipt_total, 0);
  const approvedReceiptSuccess = asFiniteNumber(receiptRow?.approved_receipt_success, 0);

  const collectionRate = expectedAmount > 0 ? toAnalyticsPercent((totalCollected / expectedAmount) * 100) : 0;
  const autoApprovalRate = approvedCount > 0 ? toAnalyticsPercent((autoApprovedCount / approvedCount) * 100) : 0;
  const approvedReceiptGenerationSuccessRate =
    approvedReceiptTotal > 0 ? toAnalyticsPercent((approvedReceiptSuccess / approvedReceiptTotal) * 100) : 0;

  return {
    filters: {
      from: filters.from,
      to: filters.to,
      paymentItemId: filters.paymentItemId || null,
      granularity: filters.granularity,
    },
    kpis: {
      totalCollected,
      expectedAmount,
      outstandingAmount,
      collectionRate,
      openExceptionsCount,
      autoApprovalRate,
      approvedReceiptGenerationSuccessRate,
    },
  };
}

async function getAnalyticsRevenueSeriesPayload(req, filters) {
  const bucketExpression = getAnalyticsBucketExpression(filters.granularity, "COALESCE(pt.paid_at, pt.created_at)");
  const scoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
    paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
    paymentItemOwnerExpression: "pi.created_by",
    extraConditions: ["pt.status = 'approved'"],
  });
  const rows = await all(
    `
      SELECT
        ${bucketExpression} AS bucket,
        COALESCE(SUM(pt.amount), 0) AS collected_amount,
        COUNT(*) AS transaction_count
      FROM payment_transactions pt
      LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
      LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
      ${scoped.whereClause}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
    scoped.params
  );
  const series = rows.map((row) => ({
    bucket: String(row.bucket || ""),
    collectedAmount: toAnalyticsAmount(row.collected_amount),
    transactionCount: Math.max(0, Math.floor(asFiniteNumber(row.transaction_count, 0))),
  }));
  const totalCollected = toAnalyticsAmount(series.reduce((acc, row) => acc + asFiniteNumber(row.collectedAmount, 0), 0));
  return {
    filters: {
      from: filters.from,
      to: filters.to,
      paymentItemId: filters.paymentItemId || null,
      granularity: filters.granularity,
    },
    series,
    totals: {
      totalCollected,
    },
  };
}

async function getAnalyticsStatusBreakdownPayload(req, filters) {
  const scoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
    paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
    paymentItemOwnerExpression: "pi.created_by",
  });
  const rows = await all(
    `
      SELECT
        COALESCE(NULLIF(TRIM(pt.status), ''), 'unknown') AS status,
        COUNT(*) AS count
      FROM payment_transactions pt
      LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
      LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
      ${scoped.whereClause}
      GROUP BY status
      ORDER BY count DESC, status ASC
    `,
    scoped.params
  );
  const breakdown = rows.map((row) => ({
    status: String(row.status || "unknown"),
    count: Math.max(0, Math.floor(asFiniteNumber(row.count, 0))),
  }));
  return {
    filters: {
      from: filters.from,
      to: filters.to,
      paymentItemId: filters.paymentItemId || null,
      granularity: filters.granularity,
    },
    total: breakdown.reduce((acc, row) => acc + row.count, 0),
    breakdown,
  };
}

async function getAnalyticsReconciliationFunnelPayload(req, filters) {
  const scoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(pt.paid_at, pt.created_at)",
    paymentItemExpression: "COALESCE(po.payment_item_id, pt.payment_item_hint_id)",
    paymentItemOwnerExpression: "pi.created_by",
  });
  const row = await get(
    `
      SELECT
        COUNT(*) AS ingested,
        COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
        COALESCE(SUM(CASE WHEN pt.status = 'needs_review' THEN 1 ELSE 0 END), 0) AS needs_review,
        COALESCE(SUM(CASE WHEN pt.status = 'unmatched' THEN 1 ELSE 0 END), 0) AS unmatched,
        COALESCE(SUM(CASE WHEN pt.status = 'duplicate' THEN 1 ELSE 0 END), 0) AS duplicate,
        COALESCE(SUM(CASE WHEN pt.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
        COALESCE(SUM(CASE WHEN pt.status = 'needs_student_confirmation' THEN 1 ELSE 0 END), 0) AS needs_student_confirmation
      FROM payment_transactions pt
      LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
      LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
      ${scoped.whereClause}
    `,
    scoped.params
  );
  const stages = [
    ["ingested", row?.ingested],
    ["approved", row?.approved],
    ["needs_review", row?.needs_review],
    ["unmatched", row?.unmatched],
    ["duplicate", row?.duplicate],
    ["rejected", row?.rejected],
    ["needs_student_confirmation", row?.needs_student_confirmation],
  ].map(([stage, count]) => ({
    stage,
    count: Math.max(0, Math.floor(asFiniteNumber(count, 0))),
  }));
  return {
    filters: {
      from: filters.from,
      to: filters.to,
      paymentItemId: filters.paymentItemId || null,
      granularity: filters.granularity,
    },
    stages,
  };
}

async function getAnalyticsTopItemsPayload(req, filters) {
  const outerScoped = buildAnalyticsScopedWhereClause(req, filters, {
    includeDateRange: false,
    paymentItemExpression: "pi.id",
    paymentItemOwnerExpression: "pi.created_by",
  });
  const orderBy = ANALYTICS_TOP_ITEM_SORT_TO_ORDER_BY[filters.sort] || ANALYTICS_TOP_ITEM_SORT_TO_ORDER_BY.collected_desc;
  const rows = await all(
    `
      WITH approved_range AS (
        SELECT
          COALESCE(po.payment_item_id, pt.payment_item_hint_id) AS payment_item_id,
          COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN pt.amount ELSE 0 END), 0) AS collected_total,
          COALESCE(SUM(CASE WHEN pt.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_count,
          COUNT(*) AS transaction_count
        FROM payment_transactions pt
        LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
        WHERE DATE(COALESCE(pt.paid_at, pt.created_at)) >= DATE(?)
          AND DATE(COALESCE(pt.paid_at, pt.created_at)) <= DATE(?)
        GROUP BY COALESCE(po.payment_item_id, pt.payment_item_hint_id)
      ),
      obligation_totals AS (
        SELECT
          po.payment_item_id,
          COALESCE(SUM(po.expected_amount), 0) AS expected_total,
          COALESCE(
            SUM(
              CASE
                WHEN po.expected_amount - COALESCE(po.amount_paid_total, 0) > 0.01 THEN po.expected_amount - COALESCE(po.amount_paid_total, 0)
                ELSE 0
              END
            ),
            0
          ) AS outstanding_amount
        FROM payment_obligations po
        GROUP BY po.payment_item_id
      )
      SELECT
        pi.id AS payment_item_id,
        pi.title,
        pi.currency,
        COALESCE(approved_range.collected_total, 0) AS collected_total,
        COALESCE(approved_range.approved_count, 0) AS approved_count,
        COALESCE(approved_range.transaction_count, 0) AS transaction_count,
        COALESCE(obligation_totals.expected_total, 0) AS expected_total,
        COALESCE(obligation_totals.outstanding_amount, 0) AS outstanding_amount
      FROM payment_items pi
      LEFT JOIN approved_range ON approved_range.payment_item_id = pi.id
      LEFT JOIN obligation_totals ON obligation_totals.payment_item_id = pi.id
      ${outerScoped.whereClause}
      ORDER BY ${orderBy}
      LIMIT ${Math.max(1, Math.floor(asFiniteNumber(filters.limit, 10)))}
    `,
    [filters.from, filters.to].concat(outerScoped.params)
  );
  const items = rows.map((row) => ({
    paymentItemId: parseResourceId(row.payment_item_id),
    title: String(row.title || ""),
    currency: String(row.currency || "NGN"),
    collectedTotal: toAnalyticsAmount(row.collected_total),
    approvedCount: Math.max(0, Math.floor(asFiniteNumber(row.approved_count, 0))),
    transactionCount: Math.max(0, Math.floor(asFiniteNumber(row.transaction_count, 0))),
    expectedAmount: toAnalyticsAmount(row.expected_total),
    outstandingAmount: toAnalyticsAmount(row.outstanding_amount),
  }));
  return {
    filters: {
      from: filters.from,
      to: filters.to,
      paymentItemId: filters.paymentItemId || null,
      granularity: filters.granularity,
    },
    sort: filters.sort,
    limit: filters.limit,
    items,
  };
}

async function getAnalyticsPaystackFunnelPayload(req, filters) {
  const scoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(ps.updated_at, ps.created_at)",
    paymentItemExpression: "po.payment_item_id",
    paymentItemOwnerExpression: "pi.created_by",
  });
  const row = await get(
    `
      SELECT
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) = 'initiated' THEN 1 ELSE 0 END), 0) AS initiated,
        COALESCE(
          SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) IN ('pending_webhook', 'pending', 'processing') THEN 1 ELSE 0 END),
          0
        ) AS pending_webhook,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) = 'under_review' THEN 1 ELSE 0 END), 0) AS under_review,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(ps.status, '')) = 'failed' THEN 1 ELSE 0 END), 0) AS failed
      FROM paystack_sessions ps
      JOIN payment_obligations po ON po.id = ps.obligation_id
      JOIN payment_items pi ON pi.id = po.payment_item_id
      ${scoped.whereClause}
    `,
    scoped.params
  );
  const stages = [
    ["initiated", row?.initiated],
    ["pending_webhook", row?.pending_webhook],
    ["approved", row?.approved],
    ["under_review", row?.under_review],
    ["failed", row?.failed],
  ].map(([stage, count]) => ({
    stage,
    count: Math.max(0, Math.floor(asFiniteNumber(count, 0))),
  }));
  return {
    filters: {
      from: filters.from,
      to: filters.to,
      paymentItemId: filters.paymentItemId || null,
      granularity: filters.granularity,
    },
    stages,
  };
}

async function getAnalyticsAgingPayload(req, filters) {
  const scoped = buildAnalyticsScopedWhereClause(req, filters, {
    dateExpression: "COALESCE(po.due_date, po.created_at)",
    paymentItemExpression: "po.payment_item_id",
    paymentItemOwnerExpression: "pi.created_by",
  });
  const rows = await all(
    `
      SELECT
        CASE
          WHEN po.expected_amount - COALESCE(po.amount_paid_total, 0) <= 0.01 THEN 'settled'
          WHEN po.due_date IS NULL OR TRIM(po.due_date) = '' THEN 'current'
          WHEN CAST(julianday(DATE(?)) - julianday(DATE(po.due_date)) AS INTEGER) <= 0 THEN 'current'
          WHEN CAST(julianday(DATE(?)) - julianday(DATE(po.due_date)) AS INTEGER) BETWEEN 1 AND 7 THEN 'overdue_1_7'
          WHEN CAST(julianday(DATE(?)) - julianday(DATE(po.due_date)) AS INTEGER) BETWEEN 8 AND 30 THEN 'overdue_8_30'
          ELSE 'overdue_31_plus'
        END AS bucket,
        COUNT(*) AS obligations_count,
        COALESCE(
          SUM(
            CASE
              WHEN po.expected_amount - COALESCE(po.amount_paid_total, 0) > 0.01 THEN po.expected_amount - COALESCE(po.amount_paid_total, 0)
              ELSE 0
            END
          ),
          0
        ) AS outstanding_amount
      FROM payment_obligations po
      JOIN payment_items pi ON pi.id = po.payment_item_id
      ${scoped.whereClause}
      GROUP BY bucket
    `,
    [filters.to, filters.to, filters.to].concat(scoped.params)
  );
  const bucketMap = new Map(
    rows.map((row) => [
      String(row.bucket || ""),
      {
        obligationsCount: Math.max(0, Math.floor(asFiniteNumber(row.obligations_count, 0))),
        outstandingAmount: toAnalyticsAmount(row.outstanding_amount),
      },
    ])
  );
  const buckets = [
    ["current", "Current"],
    ["overdue_1_7", "1-7 overdue"],
    ["overdue_8_30", "8-30 overdue"],
    ["overdue_31_plus", "31+ overdue"],
  ].map(([bucketKey, label]) => {
    const entry = bucketMap.get(bucketKey) || { obligationsCount: 0, outstandingAmount: 0 };
    return {
      bucket: bucketKey,
      label,
      obligationsCount: entry.obligationsCount,
      outstandingAmount: entry.outstandingAmount,
    };
  });
  return {
    filters: {
      from: filters.from,
      to: filters.to,
      paymentItemId: filters.paymentItemId || null,
      granularity: filters.granularity,
    },
    buckets,
    totals: {
      outstandingAmount: toAnalyticsAmount(
        buckets.reduce((acc, bucket) => acc + asFiniteNumber(bucket.outstandingAmount, 0), 0)
      ),
    },
  };
}

function appendAnalyticsCsvSection(lines, title, headers, rows) {
  lines.push(title);
  lines.push(headers.map((header) => escapeCsvCell(header)).join(","));
  if (!rows.length) {
    lines.push(escapeCsvCell("No data for selected range"));
    lines.push("");
    return;
  }
  rows.forEach((row) => {
    lines.push(row.map((cell) => escapeCsvCell(cell)).join(","));
  });
  lines.push("");
}

function buildAnalyticsExportCsv(filters, payload) {
  const lines = [];
  lines.push("Paytec Analytics Export");
  lines.push(`Generated At,${escapeCsvCell(new Date().toISOString())}`);
  lines.push(`From,${escapeCsvCell(filters.from)}`);
  lines.push(`To,${escapeCsvCell(filters.to)}`);
  lines.push(`Granularity,${escapeCsvCell(filters.granularity)}`);
  lines.push(`Payment Item ID,${escapeCsvCell(filters.paymentItemId || "all")}`);
  lines.push("");

  appendAnalyticsCsvSection(lines, "Overview", ["metric", "value"], [
    ["total_collected", payload.overview.kpis.totalCollected],
    ["expected_amount", payload.overview.kpis.expectedAmount],
    ["outstanding_amount", payload.overview.kpis.outstandingAmount],
    ["collection_rate_percent", payload.overview.kpis.collectionRate],
    ["open_exceptions_count", payload.overview.kpis.openExceptionsCount],
    ["auto_approval_rate_percent", payload.overview.kpis.autoApprovalRate],
    [
      "approved_receipt_generation_success_rate_percent",
      payload.overview.kpis.approvedReceiptGenerationSuccessRate,
    ],
  ]);

  appendAnalyticsCsvSection(
    lines,
    "Revenue Series",
    ["bucket", "collected_amount", "transaction_count"],
    payload.revenue.series.map((row) => [row.bucket, row.collectedAmount, row.transactionCount])
  );

  appendAnalyticsCsvSection(
    lines,
    "Transaction Status Breakdown",
    ["status", "count"],
    payload.statusBreakdown.breakdown.map((row) => [row.status, row.count])
  );

  appendAnalyticsCsvSection(
    lines,
    "Reconciliation Funnel",
    ["stage", "count"],
    payload.reconciliationFunnel.stages.map((row) => [row.stage, row.count])
  );

  appendAnalyticsCsvSection(
    lines,
    "Top Payment Items",
    [
      "payment_item_id",
      "title",
      "currency",
      "collected_total",
      "approved_count",
      "transaction_count",
      "expected_amount",
      "outstanding_amount",
    ],
    payload.topItems.items.map((row) => [
      row.paymentItemId,
      row.title,
      row.currency,
      row.collectedTotal,
      row.approvedCount,
      row.transactionCount,
      row.expectedAmount,
      row.outstandingAmount,
    ])
  );

  appendAnalyticsCsvSection(
    lines,
    "Aging Buckets",
    ["bucket", "label", "obligations_count", "outstanding_amount"],
    payload.aging.buckets.map((row) => [row.bucket, row.label, row.obligationsCount, row.outstandingAmount])
  );

  appendAnalyticsCsvSection(
    lines,
    "Paystack Funnel",
    ["stage", "count"],
    payload.paystackFunnel.stages.map((row) => [row.stage, row.count])
  );

  return lines.join("\n");
}

function isAnalyticsValidationError(err) {
  return Number(err?.status || 0) === 400;
}

function parseReconciliationFilters(query) {
  return {
    student: String(query.student || "").trim().slice(0, 120),
    reference: String(query.reference || "").trim().slice(0, 160),
    paymentItemId: parseResourceId(query.paymentItemId),
    dateFrom: String(query.dateFrom || "").trim(),
    dateTo: String(query.dateTo || "").trim(),
    page: Math.max(1, Number.parseInt(query.page, 10) || 1),
    pageSize: Math.max(1, Math.min(200, Number.parseInt(query.pageSize, 10) || 50)),
    legacy: String(query.legacy || "").trim() === "1",
  };
}

function buildReconciliationExceptionQuery(filters) {
  const params = [];
  const conditions = ["pt.status = 'approved'"];
  if (filters.student) {
    const studentSearch = `%${String(filters.student || "").toLowerCase()}%`;
    conditions.push(
      "(LOWER(COALESCE(up.display_name, '')) LIKE ? OR LOWER(COALESCE(po.student_username, pt.student_hint_username, '')) LIKE ?)"
    );
    params.push(studentSearch, studentSearch);
  }
  if (filters.reference) {
    const referenceSearch = `%${String(filters.reference || "").toLowerCase()}%`;
    conditions.push("(LOWER(COALESCE(pt.txn_ref, '')) LIKE ? OR LOWER(COALESCE(ps.gateway_reference, '')) LIKE ?)");
    params.push(referenceSearch, referenceSearch);
  }
  if (filters.paymentItemId) {
    conditions.push("COALESCE(po.payment_item_id, pt.payment_item_hint_id) = ?");
    params.push(filters.paymentItemId);
  }
  if (filters.dateFrom && isValidIsoLikeDate(filters.dateFrom)) {
    conditions.push("DATE(COALESCE(pt.reviewed_at, pt.created_at, pt.paid_at)) >= DATE(?)");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo && isValidIsoLikeDate(filters.dateTo)) {
    conditions.push("DATE(COALESCE(pt.reviewed_at, pt.created_at, pt.paid_at)) <= DATE(?)");
    params.push(filters.dateTo);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (filters.page - 1) * filters.pageSize;
  const baseFrom = `
      FROM payment_transactions pt
      LEFT JOIN payment_obligations po ON po.id = pt.matched_obligation_id
      LEFT JOIN payment_items pi ON pi.id = COALESCE(po.payment_item_id, pt.payment_item_hint_id)
      LEFT JOIN user_profiles up ON up.username = COALESCE(po.student_username, pt.student_hint_username)
      LEFT JOIN paystack_sessions ps ON ps.gateway_reference = pt.txn_ref
  `;
  return {
    sql: `
      SELECT
        pt.id,
        pt.txn_ref,
        pt.amount,
        pt.paid_at,
        pt.status,
        COALESCE(po.student_username, pt.student_hint_username, '') AS student_username,
        COALESCE(NULLIF(TRIM(up.display_name), ''), COALESCE(po.student_username, pt.student_hint_username), 'Unknown Student') AS student_full_name,
        COALESCE(po.payment_item_id, pt.payment_item_hint_id) AS payment_item_id,
        pi.title AS payment_item_title,
        COALESCE(pi.currency, 'NGN') AS currency,
        COALESCE(NULLIF(ps.gateway_reference, ''), pt.txn_ref, '') AS paystack_reference,
        COALESCE(pt.reviewed_at, pt.created_at) AS approved_at,
        pt.reasons_json,
        pt.created_at,
        pt.reviewed_by,
        pt.reviewed_at
      ${baseFrom}
      ${whereClause}
      ORDER BY datetime(COALESCE(pt.reviewed_at, pt.created_at)) DESC, pt.id DESC
      LIMIT ${filters.pageSize}
      OFFSET ${offset}
    `,
    countSql: `
      SELECT COUNT(*) AS total
      ${baseFrom}
      ${whereClause}
    `,
    params,
  };
}

async function getReconciliationSummary() {
  const [statusRows, unresolvedRow] = await Promise.all([
    all(
      `
        SELECT status, COUNT(*) AS total
        FROM payment_transactions
        GROUP BY status
      `
    ),
    get(
      `
        SELECT COUNT(*) AS total
        FROM payment_obligations
        WHERE expected_amount - amount_paid_total > 0.01
      `
    ),
  ]);
  const map = Object.create(null);
  statusRows.forEach((row) => {
    map[String(row.status || "unknown")] = Number(row.total || 0);
  });
  const exceptionStatuses = ["needs_review", "unmatched", "duplicate", "needs_student_confirmation"];
  const exceptions = exceptionStatuses.reduce((acc, status) => acc + Number(map[status] || 0), 0);
  return {
    auto_approved: Number(map.approved || 0),
    exceptions,
    unresolved_obligations: Number(unresolvedRow?.total || 0),
    duplicates: Number(map.duplicate || 0),
    needs_student_confirmation: Number(map.needs_student_confirmation || 0),
  };
}

async function applyReconciliationReviewAction(req, transactionId, action, options = {}) {
  const id = parseResourceId(transactionId);
  if (!id) {
    throw { status: 400, error: "Invalid transaction ID." };
  }
  const tx = await get("SELECT * FROM payment_transactions WHERE id = ? LIMIT 1", [id]);
  if (!tx) {
    throw { status: 404, error: "Transaction not found." };
  }
  const actor = req?.session?.user?.username || "system";
  let matchedObligationId = tx.matched_obligation_id ? Number(tx.matched_obligation_id) : null;
  const currentReasons = parseJsonArray(tx.reasons_json || "[]", []);
  if (action === "approve") {
    const requestedObligationId = parseResourceId(options.obligationId);
    if (requestedObligationId) {
      matchedObligationId = requestedObligationId;
    }
    if (!matchedObligationId) {
      const best = await pickBestObligationCandidate(tx);
      matchedObligationId = best?.obligation?.id || null;
    }
    if (!matchedObligationId) {
      throw { status: 400, error: "No obligation match was found for approval." };
    }
    const reasons = normalizeReasonCodes(currentReasons.concat("manual_approved"));
    await run(
      `
        UPDATE payment_transactions
        SET status = 'approved',
            matched_obligation_id = ?,
            confidence = ?,
            reasons_json = ?,
            reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [matchedObligationId, Math.max(0.75, toSafeConfidence(tx.confidence, 0.75)), JSON.stringify(reasons), actor, id]
    );
    const obligation = await recomputeObligationSnapshotById(matchedObligationId);
    await syncPaymentMatchAndExceptionRecords(id, req, actor, {
      approvedReceiptReason: "manual_approved_transaction",
    });
    await logReconciliationEvent(id, matchedObligationId, req, "manual_approve", options.note || "Manually approved.");
    if (obligation) {
      await createReconciliationStatusNotification(
        obligation.student_username,
        obligation.payment_item_id,
        "Payment approved",
        "Your payment was approved by your reviewer."
      );
    }
    return getReconciliationTransactionById(id);
  }
  if (action === "reject") {
    const reasons = normalizeReasonCodes(currentReasons.concat("manual_rejected"));
    await run(
      `
        UPDATE payment_transactions
        SET status = 'rejected',
            reasons_json = ?,
            reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [JSON.stringify(reasons), actor, id]
    );
    await syncPaymentMatchAndExceptionRecords(id, req, actor);
    await logReconciliationEvent(id, matchedObligationId, req, "manual_reject", options.note || "Manually rejected.");
    return getReconciliationTransactionById(id);
  }
  if (action === "request_student_confirmation") {
    const reasons = normalizeReasonCodes(currentReasons.concat("needs_student_confirmation"));
    await run(
      `
        UPDATE payment_transactions
        SET status = 'needs_student_confirmation',
            reasons_json = ?,
            reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [JSON.stringify(reasons), actor, id]
    );
    const obligation = matchedObligationId
      ? await get("SELECT * FROM payment_obligations WHERE id = ? LIMIT 1", [matchedObligationId])
      : null;
    if (obligation) {
      await createReconciliationStatusNotification(
        obligation.student_username,
        obligation.payment_item_id,
        "Payment confirmation requested",
        "Your payment needs additional confirmation. Please share your proof of payment with your lecturer."
      );
    }
    await syncPaymentMatchAndExceptionRecords(id, req, actor);
    await logReconciliationEvent(id, matchedObligationId, req, "request_student_confirmation", options.note || "Requested student confirmation.");
    return getReconciliationTransactionById(id);
  }
  if (action === "merge_duplicates") {
    const primaryTransactionId = parseResourceId(options.primaryTransactionId);
    if (!primaryTransactionId) {
      throw { status: 400, error: "primaryTransactionId is required for merge duplicates." };
    }
    if (primaryTransactionId === id) {
      throw { status: 400, error: "Duplicate transaction cannot be merged into itself." };
    }
    const primary = await get("SELECT * FROM payment_transactions WHERE id = ? LIMIT 1", [primaryTransactionId]);
    if (!primary) {
      throw { status: 404, error: "Primary transaction not found." };
    }
    const reasons = normalizeReasonCodes(currentReasons.concat("duplicate_transaction"));
    await run(
      `
        UPDATE payment_transactions
        SET status = 'duplicate',
            matched_obligation_id = ?,
            confidence = 0.2,
            reasons_json = ?,
            reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [primary.matched_obligation_id || null, JSON.stringify(reasons), actor, id]
    );
    if (tx.matched_obligation_id) {
      await recomputeObligationSnapshotById(tx.matched_obligation_id);
    }
    if (primary.matched_obligation_id) {
      await recomputeObligationSnapshotById(primary.matched_obligation_id);
    }
    await syncPaymentMatchAndExceptionRecords(id, req, actor);
    await logReconciliationEvent(id, primary.matched_obligation_id || null, req, "merge_duplicates", `Merged into #${primaryTransactionId}`);
    return getReconciliationTransactionById(id);
  }
  throw { status: 400, error: "Unsupported reconciliation action." };
}

async function migrateLegacyReceiptsToTransactions() {
  const rows = await all(
    `
      SELECT pr.*, pi.expected_amount, pi.due_date
      FROM payment_receipts pr
      LEFT JOIN payment_items pi ON pi.id = pr.payment_item_id
      ORDER BY pr.id ASC
    `
  );
  for (const receipt of rows) {
    const obligation = await upsertPaymentObligation(
      {
        id: receipt.payment_item_id,
        expected_amount: receipt.expected_amount || receipt.amount_paid,
        due_date: receipt.due_date || null,
      },
      receipt.student_username
    );
    const statusMap = {
      approved: "approved",
      rejected: "rejected",
      under_review: "needs_review",
      submitted: "needs_review",
    };
    const status = statusMap[String(receipt.status || "").toLowerCase()] || "needs_review";
    const reasons = normalizeReasonCodes(["legacy_migration", status === "approved" ? "manual_approved" : "amount_match"]);
    const normalizedPaidDate = toDateOnly(receipt.paid_at || receipt.submitted_at || "");
    const checksum = buildTransactionChecksum({
      source: "student_receipt",
      txn_ref: receipt.transaction_ref || "",
      amount: Number(receipt.amount_paid || 0),
      date: normalizedPaidDate,
      payer_name: receipt.student_username || "",
    });
    await run(
      `
        INSERT INTO payment_transactions (
          txn_ref,
          amount,
          paid_at,
          payer_name,
          source,
          source_event_id,
          source_file_name,
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
          reasons_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_event_id) DO NOTHING
      `,
      [
        String(receipt.transaction_ref || ""),
        Number(receipt.amount_paid || 0),
        String(receipt.paid_at || receipt.submitted_at || ""),
        String(receipt.student_username || ""),
        "student_receipt",
        `legacy-receipt-${receipt.id}`,
        path.basename(String(receipt.receipt_file_path || "")),
        normalizeReference(receipt.transaction_ref || ""),
        normalizedPaidDate,
        normalizeStatementName(receipt.student_username || ""),
        normalizeIdentifier(receipt.student_username || ""),
        receipt.payment_item_id || null,
        checksum || null,
        JSON.stringify({
          legacy_receipt_id: receipt.id,
          legacy_status: receipt.status,
          verification_notes: parseJsonObject(receipt.verification_notes || "{}", {}),
        }),
        status,
        obligation?.id || null,
        status === "approved" ? 1 : 0.6,
        JSON.stringify(reasons),
      ]
    );
  }
  const txRows = await all("SELECT id FROM payment_transactions WHERE source_event_id LIKE 'legacy-receipt-%'");
  for (const row of txRows) {
    await syncPaymentMatchAndExceptionRecords(row.id, null, "system-migration", {
      skipApprovedReceiptGeneration: true,
    });
  }
  await recomputeAllObligationSnapshots();
}

async function migrateLegacyReceiptsToReconciliation() {
  await ensurePaymentObligationsForAllPaymentItems();
  await migrateLegacyReceiptsToTransactions();
}

async function isValidReviewerAssignee(identifier) {
  const normalized = normalizeIdentifier(identifier);
  if (!normalized) {
    return false;
  }
  const [adminUser, teacherUser] = await Promise.all([
    get("SELECT username FROM users WHERE username = ? AND role = 'admin' LIMIT 1", [normalized]),
    get("SELECT auth_id FROM auth_roster WHERE auth_id = ? AND role = 'teacher' LIMIT 1", [normalized]),
  ]);
  return !!(adminUser || teacherUser);
}

async function appendReviewerNoteEvent(receiptId, req, noteText) {
  const normalized = String(noteText || "").trim().slice(0, 500);
  if (!normalized) {
    return "";
  }
  await logReceiptEvent(receiptId, req, "review_note", null, null, normalized);
  await logAuditEvent(
    req,
    "review_note",
    "payment_receipt",
    receiptId,
    null,
    `Added reviewer note to receipt #${receiptId}`
  );
  return normalized;
}

app.get("/robots.txt", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.type("text/plain");
  return res.send(`User-agent: *
Allow: /
Sitemap: ${baseUrl}/sitemap.xml
`);
});

app.get("/sitemap.xml", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const urls = ["/login"];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (url) => `  <url>
    <loc>${baseUrl}${url}</loc>
  </url>`
  )
  .join("\n")}
</urlset>`;

  res.type("application/xml");
  return res.send(xml);
});

app.get("/login", (req, res) => {
  if (isAuthenticated(req)) {
    return res.redirect("/");
  }
  return res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/login.html", (_req, res) => res.redirect("/login"));
app.get("/admin.html", (_req, res) => res.redirect("/admin"));
app.get("/admin-import.html", (_req, res) => res.redirect("/admin/import"));
app.get("/teacher.html", (_req, res) => res.redirect("/lecturer"));
app.get("/lecturer.html", (_req, res) => res.redirect("/lecturer"));
app.get("/analytics.html", (_req, res) => res.redirect("/analytics"));
app.get("/messages.html", (_req, res) => res.redirect("/messages"));

app.post("/login", async (req, res) => {
  const rawIdentifier = String(req.body.username || "");
  const rawPassword = String(req.body.password || "");
  const identifier = normalizeIdentifier(rawIdentifier);
  const surnamePassword = normalizeSurnamePassword(rawPassword);
  const failLogin = (code) => {
    recordFailedLogin(req, identifier || "*");
    return res.redirect(`/login?error=${code}`);
  };

  if (isLoginRateLimited(req, identifier || "*")) {
    return res.redirect("/login?error=rate_limited");
  }

  if (!isValidIdentifier(identifier) || !rawPassword.trim()) {
    return failLogin("invalid");
  }

  try {
    const adminUser = await get("SELECT username, password_hash, role FROM users WHERE username = ?", [identifier]);
    let authUser = null;
    let source = "login";

    if (adminUser && adminUser.role === "admin") {
      const validAdminPassword = await bcrypt.compare(rawPassword.trim(), adminUser.password_hash);
      if (validAdminPassword) {
        authUser = {
          username: adminUser.username,
          role: "admin",
        };
        source = "login-admin";
      }
    }

    if (!authUser) {
      if (!isValidSurnamePassword(surnamePassword)) {
        return failLogin("invalid");
      }
      const rosterUser = await get(
        "SELECT auth_id, role, password_hash FROM auth_roster WHERE auth_id = ? LIMIT 1",
        [identifier]
      );
      if (!rosterUser) {
        return failLogin("invalid");
      }

      const validRosterPassword = await bcrypt.compare(surnamePassword, rosterUser.password_hash);
      if (!validRosterPassword) {
        return failLogin("invalid");
      }
      authUser = {
        username: rosterUser.auth_id,
        role: rosterUser.role,
      };
      source = rosterUser.role === "teacher" ? "login-lecturer" : "login-student";
    }

    clearFailedLogins(req, identifier || "*");
    await regenerateSession(req);
    req.session.user = { username: authUser.username, role: authUser.role };
    ensureCsrfToken(req);
    await run("INSERT INTO login_events (username, source, ip, user_agent) VALUES (?, ?, ?, ?)", [
      authUser.username,
      source,
      req.ip || null,
      req.get("user-agent") || null,
    ]);
    await saveSession(req);
    if (authUser.role === "admin") {
      return res.redirect("/admin");
    }
    if (authUser.role === "teacher") {
      return res.redirect("/lecturer");
    }
    return res.redirect("/");
  } catch (_err) {
    return failLogin("session");
  }
});

function handleLogout(req, res) {
  if (!req.session) {
    return res.redirect("/login");
  }
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
  return undefined;
}

app.post("/logout", handleLogout);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const profile = await getUserProfile(req.session.user.username);
    const displayName =
      profile && profile.display_name
        ? profile.display_name
        : deriveDisplayNameFromIdentifier(req.session.user.username);
    const email = profile && isValidProfileEmail(profile.email) ? normalizeProfileEmail(profile.email) : null;
    return res.json({
      username: req.session.user.username,
      role: req.session.user.role,
      displayName,
      profileImageUrl: profile ? profile.profile_image_url : null,
      email,
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load profile." });
  }
});

app.get("/api/content-stream", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  contentStreamClientSequence += 1;
  const clientId = `${Date.now()}-${contentStreamClientSequence}`;
  const role = String(req.session?.user?.role || "")
    .trim()
    .toLowerCase();
  const keepAliveTimer = setInterval(() => {
    if (res.writableEnded) {
      removeContentStreamClient(clientId);
      return;
    }
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch (_err) {
      removeContentStreamClient(clientId);
    }
  }, CONTENT_STREAM_KEEPALIVE_MS);

  contentStreamClients.set(clientId, {
    role,
    res,
    keepAliveTimer,
  });

  writeContentStreamEvent(res, "stream:ready", {
    ok: true,
    at: new Date().toISOString(),
  });

  const cleanup = () => {
    removeContentStreamClient(clientId);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
});

app.post("/api/profile", requireAuth, async (req, res) => {
  const displayName = normalizeDisplayName(req.body.displayName || "");
  if (!displayName) {
    return res.status(400).json({ error: "Display name cannot be empty." });
  }
  if (displayName.length > 60) {
    return res.status(400).json({ error: "Display name cannot be longer than 60 characters." });
  }

  try {
    await upsertProfileDisplayName(req.session.user.username, displayName);
    return res.json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not update profile." });
  }
});

app.post("/api/profile/email", requireAuth, async (req, res) => {
  const email = normalizeProfileEmail(req.body?.email || "");
  if (!email) {
    return res.status(400).json({ error: "Email address cannot be empty." });
  }
  if (!isValidProfileEmail(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  try {
    await upsertProfileEmail(req.session.user.username, email);
    return res.json({ ok: true, email });
  } catch (_err) {
    return res.status(500).json({ error: "Could not update email address." });
  }
});

app.post("/api/profile/avatar", requireAuth, (req, res) => {
  avatarUpload.single("avatar")(req, res, async (err) => {
    if (err) {
      const message =
        err && err.message === "Only PNG, JPEG, and WEBP files are allowed."
          ? err.message
          : err && err.code === "LIMIT_FILE_SIZE"
          ? "Profile picture cannot be larger than 2 MB."
          : "Could not process the upload.";
      return res.status(400).json({ error: message });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Please select an image to upload." });
    }

    const relativeUrl = `/users/${req.file.filename}`;
    try {
      await upsertProfileImage(req.session.user.username, relativeUrl);
      return res.json({ ok: true, profileImageUrl: relativeUrl });
    } catch (_imageErr) {
      return res.status(500).json({ error: "Could not save profile picture." });
    }
  });
});

app.get("/api/messages/threads", requireAuth, async (req, res) => {
  const username = normalizeIdentifier(req.session?.user?.username || "");
  if (!username) {
    return res.status(401).json({ error: "Authentication required." });
  }
  try {
    const [threads, unread] = await Promise.all([
      listMessageThreadSummariesForUser(username),
      getMessageUnreadCounts(username),
    ]);
    return res.json({
      threads,
      unread,
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load message threads." });
  }
});

app.get("/api/messages/threads/:id", requireAuth, async (req, res) => {
  const threadId = parseResourceId(req.params.id);
  if (!threadId) {
    return res.status(400).json({ error: "Invalid message thread ID." });
  }
  const username = normalizeIdentifier(req.session?.user?.username || "");
  if (!username) {
    return res.status(401).json({ error: "Authentication required." });
  }
  try {
    const payload = await getMessageThreadPayloadForUser(threadId, username);
    return res.json(payload);
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    return res.status(500).json({ error: "Could not load message thread." });
  }
});

app.post("/api/messages/threads", requireAuth, async (req, res) => {
  const actorRole = String(req.session?.user?.role || "")
    .trim()
    .toLowerCase();
  if (!canCreateMessageThreads(actorRole)) {
    return res.status(403).json({ error: "Only lecturers or admins can create message threads." });
  }
  const actorUsername = normalizeIdentifier(req.session?.user?.username || "");
  if (!actorUsername || !isValidIdentifier(actorUsername)) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    const subject = validateMessageSubjectOrThrow(req.body?.subject || "");
    const messageBody = validateMessageBodyOrThrow(req.body?.message || "");
    const recipients = await validateMessageRecipients(req.body?.recipients);

    const result = await withSqlTransaction(async () => {
      const threadInsert = await run(
        `
          INSERT INTO message_threads (subject, created_by, created_at, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        [subject || null, actorUsername]
      );
      const threadId = Number(threadInsert.lastID || 0);

      const participants = [{ username: actorUsername, role: actorRole }];
      const seenParticipants = new Set([actorUsername]);
      recipients.forEach((username) => {
        if (seenParticipants.has(username)) {
          return;
        }
        seenParticipants.add(username);
        participants.push({
          username,
          role: "student",
        });
      });

      for (const participant of participants) {
        await run(
          `
            INSERT INTO message_participants (thread_id, username, role, joined_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          `,
          [threadId, participant.username, participant.role]
        );
      }

      const messageInsert = await run(
        `
          INSERT INTO messages (thread_id, sender_username, sender_role, body, created_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `,
        [threadId, actorUsername, actorRole, messageBody]
      );
      const messageId = Number(messageInsert.lastID || 0);

      await run(
        `
          UPDATE message_participants
          SET last_read_message_id = ?,
              last_read_at = CURRENT_TIMESTAMP
          WHERE thread_id = ?
            AND username = ?
        `,
        [messageId, threadId, actorUsername]
      );
      await run("UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [threadId]);

      return {
        threadId,
        messageId,
      };
    });

    const payload = await getMessageThreadPayloadForUser(result.threadId, actorUsername);
    return res.status(201).json({
      ok: true,
      threadId: result.threadId,
      messageId: result.messageId,
      ...payload,
    });
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    return res.status(500).json({ error: "Could not create message thread." });
  }
});

app.post("/api/messages/threads/:id/messages", requireAuth, async (req, res) => {
  const threadId = parseResourceId(req.params.id);
  if (!threadId) {
    return res.status(400).json({ error: "Invalid message thread ID." });
  }
  const actorUsername = normalizeIdentifier(req.session?.user?.username || "");
  const actorRole = String(req.session?.user?.role || "")
    .trim()
    .toLowerCase();
  if (!actorUsername || !isValidIdentifier(actorUsername)) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    const messageBody = validateMessageBodyOrThrow(req.body?.message || "");
    await getMessageThreadAccess(threadId, actorUsername);
    const inserted = await withSqlTransaction(async () => {
      const messageInsert = await run(
        `
          INSERT INTO messages (thread_id, sender_username, sender_role, body, created_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `,
        [threadId, actorUsername, actorRole, messageBody]
      );
      const messageId = Number(messageInsert.lastID || 0);
      await run("UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [threadId]);
      await run(
        `
          UPDATE message_participants
          SET last_read_message_id = ?,
              last_read_at = CURRENT_TIMESTAMP
          WHERE thread_id = ?
            AND username = ?
        `,
        [messageId, threadId, actorUsername]
      );
      return messageId;
    });

    const messageRow = await get(
      `
        SELECT id, thread_id, sender_username, sender_role, body, created_at
        FROM messages
        WHERE id = ?
        LIMIT 1
      `,
      [inserted]
    );
    return res.status(201).json({
      ok: true,
      message: {
        id: Number(messageRow?.id || 0),
        thread_id: Number(messageRow?.thread_id || threadId),
        sender_username: String(messageRow?.sender_username || actorUsername),
        sender_role: String(messageRow?.sender_role || actorRole),
        body: String(messageRow?.body || messageBody),
        created_at: messageRow?.created_at || "",
      },
    });
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    return res.status(500).json({ error: "Could not send message." });
  }
});

app.post("/api/messages/threads/:id/read", requireAuth, async (req, res) => {
  const threadId = parseResourceId(req.params.id);
  if (!threadId) {
    return res.status(400).json({ error: "Invalid message thread ID." });
  }
  const username = normalizeIdentifier(req.session?.user?.username || "");
  if (!username) {
    return res.status(401).json({ error: "Authentication required." });
  }
  try {
    await getMessageThreadAccess(threadId, username);
    const lastReadMessageId = await markMessageThreadReadForUser(threadId, username);
    const unread = await getMessageUnreadCounts(username);
    return res.json({
      ok: true,
      thread_id: threadId,
      last_read_message_id: lastReadMessageId,
      unread,
    });
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    return res.status(500).json({ error: "Could not update read state." });
  }
});

app.get("/api/messages/unread-count", requireAuth, async (req, res) => {
  const username = normalizeIdentifier(req.session?.user?.username || "");
  if (!username) {
    return res.status(401).json({ error: "Authentication required." });
  }
  try {
    const unread = await getMessageUnreadCounts(username);
    return res.json(unread);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load unread count." });
  }
});

app.get("/api/messages/students", requireAuth, async (req, res) => {
  const actorRole = String(req.session?.user?.role || "")
    .trim()
    .toLowerCase();
  if (!canCreateMessageThreads(actorRole)) {
    return res.status(403).json({ error: "Only lecturers or admins can list student recipients." });
  }
  try {
    const students = await listMessageStudentDirectory();
    return res.json({ students });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load students." });
  }
});

app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/admin/import", requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin-import.html"));
});

app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  try {
    const [rosterCounts, adminCount, loginCounts, todayCounts, recent, recentAuditLogs] = await Promise.all([
      get(
        `
          SELECT
            SUM(CASE WHEN role = 'teacher' THEN 1 ELSE 0 END) AS total_teachers,
            SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END) AS total_students
          FROM auth_roster
        `
      ),
      get(
        `
          SELECT COUNT(*) AS total_admins
          FROM users
          WHERE role = 'admin'
        `
      ),
      get(
        `
          SELECT
            COUNT(*) AS total_logins,
            COUNT(DISTINCT username) AS unique_logged_in_users
          FROM login_events
        `
      ),
      get(
        `
          SELECT COUNT(*) AS today_logins
          FROM login_events
          WHERE DATE(logged_in_at) = DATE('now')
        `
      ),
      all(
        `
          SELECT username, source, ip, logged_in_at
          FROM login_events
          ORDER BY logged_in_at DESC
          LIMIT 20
        `
      ),
      all(
        `
          SELECT actor_username, actor_role, action, content_type, content_id, target_owner, summary, created_at
          FROM audit_logs
          ORDER BY created_at DESC, id DESC
          LIMIT 50
        `
      ),
    ]);

    return res.json({
      totalUsers:
        Number(rosterCounts.total_students || 0) +
        Number(rosterCounts.total_teachers || 0) +
        Number(adminCount.total_admins || 0),
      totalStudents: Number(rosterCounts.total_students || 0),
      totalLecturers: Number(rosterCounts.total_teachers || 0),
      totalTeachers: Number(rosterCounts.total_teachers || 0),
      totalAdmins: Number(adminCount.total_admins || 0),
      totalLogins: Number(loginCounts.total_logins || 0),
      uniqueLoggedInUsers: Number(loginCounts.unique_logged_in_users || 0),
      todayLogins: Number(todayCounts.today_logins || 0),
      recentLogins: recent,
      recentAuditLogs,
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load admin stats" });
  }
});

app.get("/api/admin/audit-logs", requireAdmin, async (_req, res) => {
  try {
    const rows = await all(
      `
        SELECT actor_username, actor_role, action, content_type, content_id, target_owner, summary, created_at
        FROM audit_logs
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `
    );
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load audit logs" });
  }
});

app.get("/api/payment-items", requireAuth, async (_req, res) => {
  try {
    const isStudent = _req.session?.user?.role === "student";
    let rows = [];
    if (isStudent) {
      const student = normalizeIdentifier(_req.session.user.username);
      await ensurePaymentObligationsForStudent(student);
      rows = await all(
        `
          SELECT
            pi.id,
            pi.title,
            pi.description,
            pi.expected_amount,
            pi.currency,
            pi.due_date,
            pi.available_until,
            pi.availability_days,
            pi.created_by,
            pi.created_at,
            po.payment_reference AS my_reference,
            po.status AS obligation_status,
            COALESCE(po.amount_paid_total, 0) AS amount_paid_total
          FROM payment_items pi
          LEFT JOIN payment_obligations po
            ON po.payment_item_id = pi.id
           AND po.student_username = ?
          WHERE (pi.available_until IS NULL OR datetime(pi.available_until) > CURRENT_TIMESTAMP)
          ORDER BY pi.created_at DESC, pi.id DESC
        `,
        [student]
      );
    } else {
      rows = await all(
        `
          SELECT
            pi.id,
            pi.title,
            pi.description,
            pi.expected_amount,
            pi.currency,
            pi.due_date,
            pi.available_until,
            pi.availability_days,
            pi.created_by,
            pi.created_at
          FROM payment_items pi
          ORDER BY pi.created_at DESC, pi.id DESC
        `
      );
    }
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load payment items." });
  }
});

app.post("/api/payment-items", requireTeacher, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const expectedAmount = parseMoneyValue(req.body.expectedAmount);
  const currency = parseCurrency(req.body.currency || "NGN");
  const dueDateRaw = String(req.body.dueDate || "").trim();
  const dueDate = dueDateRaw || null;
  const hasAvailabilityDays = String(req.body.availabilityDays ?? "").trim() !== "";
  const availabilityDays = parseAvailabilityDays(req.body.availabilityDays);
  const availableUntil = hasAvailabilityDays ? computeAvailableUntil(availabilityDays) : null;

  if (!title || title.length > 120) {
    return res.status(400).json({ error: "Title is required and must be 120 characters or less." });
  }
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    return res.status(400).json({ error: "Expected amount must be greater than zero." });
  }
  if (!currency) {
    return res.status(400).json({ error: "Currency must be a 3-letter code (e.g. NGN)." });
  }
  if (dueDate && !isValidIsoLikeDate(dueDate)) {
    return res.status(400).json({ error: "Due date format is invalid." });
  }
  if (hasAvailabilityDays && !availabilityDays) {
    return res.status(400).json({ error: "Availability days must be a whole number between 1 and 3650." });
  }

  try {
    const result = await run(
      `
        INSERT INTO payment_items (
          title,
          description,
          expected_amount,
          currency,
          due_date,
          available_until,
          availability_days,
          created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [title, description, expectedAmount, currency, dueDate, availableUntil, availabilityDays, req.session.user.username]
    );
    const inserted = await get("SELECT * FROM payment_items WHERE id = ? LIMIT 1", [result.lastID]);
    await syncPaymentItemNotification(req, inserted);
    await ensurePaymentObligationsForPaymentItem(result.lastID);
    await logAuditEvent(
      req,
      "create",
      "payment_item",
      result.lastID,
      req.session.user.username,
      `Created payment item "${title.slice(0, 80)}" (${currency} ${expectedAmount})`
    );
    return res.status(201).json({ ok: true, id: result.lastID });
  } catch (_err) {
    return res.status(500).json({ error: "Could not create payment item." });
  }
});

app.put("/api/payment-items/:id", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const expectedAmount = parseMoneyValue(req.body.expectedAmount);
  const currency = parseCurrency(req.body.currency || "NGN");
  const dueDateRaw = String(req.body.dueDate || "").trim();
  const dueDate = dueDateRaw || null;
  const hasAvailabilityDays = String(req.body.availabilityDays ?? "").trim() !== "";
  const availabilityDays = parseAvailabilityDays(req.body.availabilityDays);
  const availableUntil = hasAvailabilityDays ? computeAvailableUntil(availabilityDays) : null;

  if (!id) {
    return res.status(400).json({ error: "Invalid payment item ID." });
  }
  if (!title || title.length > 120) {
    return res.status(400).json({ error: "Title is required and must be 120 characters or less." });
  }
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    return res.status(400).json({ error: "Expected amount must be greater than zero." });
  }
  if (!currency) {
    return res.status(400).json({ error: "Currency must be a 3-letter code (e.g. NGN)." });
  }
  if (dueDate && !isValidIsoLikeDate(dueDate)) {
    return res.status(400).json({ error: "Due date format is invalid." });
  }
  if (hasAvailabilityDays && !availabilityDays) {
    return res.status(400).json({ error: "Availability days must be a whole number between 1 and 3650." });
  }

  try {
    const access = await ensureCanManageContent(req, "payment_items", id);
    if (access.error === "not_found") {
      return res.status(404).json({ error: "Payment item not found." });
    }
    if (access.error === "forbidden") {
      return res.status(403).json({ error: "You can only edit your own payment item." });
    }

    await run(
      `
        UPDATE payment_items
        SET title = ?,
            description = ?,
            expected_amount = ?,
            currency = ?,
            due_date = ?,
            available_until = ?,
            availability_days = ?
        WHERE id = ?
      `,
      [title, description, expectedAmount, currency, dueDate, availableUntil, availabilityDays, id]
    );
    const updated = await get("SELECT * FROM payment_items WHERE id = ? LIMIT 1", [id]);
    await syncPaymentItemNotification(req, updated);
    await ensurePaymentObligationsForPaymentItem(id);
    await logAuditEvent(
      req,
      "edit",
      "payment_item",
      id,
      access.row.created_by,
      `Edited payment item "${title.slice(0, 80)}" (${currency} ${expectedAmount})`
    );
    return res.json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not update payment item." });
  }
});

app.delete("/api/payment-items/:id", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid payment item ID." });
  }

  try {
    const access = await ensureCanManageContent(req, "payment_items", id);
    if (access.error === "not_found") {
      return res.status(404).json({ error: "Payment item not found." });
    }
    if (access.error === "forbidden") {
      return res.status(403).json({ error: "You can only delete your own payment item." });
    }

    const receiptCount = await get("SELECT COUNT(*) AS total FROM payment_receipts WHERE payment_item_id = ?", [id]);
    if (Number(receiptCount?.total || 0) > 0) {
      return res.status(409).json({ error: "Cannot delete a payment item that already has receipts." });
    }
    const reconciledCount = await get(
      `
        SELECT COUNT(*) AS total
        FROM payment_transactions pt
        JOIN payment_obligations po ON po.id = pt.matched_obligation_id
        WHERE po.payment_item_id = ?
      `,
      [id]
    );
    if (Number(reconciledCount?.total || 0) > 0) {
      return res.status(409).json({ error: "Cannot delete a payment item that already has reconciled transactions." });
    }

    await run("DELETE FROM payment_obligations WHERE payment_item_id = ?", [id]);
    await run("DELETE FROM payment_items WHERE id = ?", [id]);
    await run("DELETE FROM notifications WHERE related_payment_item_id = ? AND auto_generated = 1", [id]);
    await logAuditEvent(
      req,
      "delete",
      "payment_item",
      id,
      access.row.created_by,
      `Deleted payment item "${String(access.row.title || "").slice(0, 80)}"`
    );
    return res.json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not delete payment item." });
  }
});

function sendPaystackOnlyGone(res, feature) {
  return res.status(410).json({
    error: `${feature} is no longer available. This deployment is Paystack-only.`,
    code: "paystack_only_deprecated_feature",
  });
}

app.get(["/api/lecturer/payment-statement", "/api/teacher/payment-statement"], requireTeacher, async (_req, res) => {
  return sendPaystackOnlyGone(res, "Statement upload");
});

app.post(["/api/lecturer/payment-statement", "/api/teacher/payment-statement"], requireTeacher, async (_req, res) => {
  return sendPaystackOnlyGone(res, "Statement upload");
});

app.delete(["/api/lecturer/payment-statement", "/api/teacher/payment-statement"], requireTeacher, async (_req, res) => {
  return sendPaystackOnlyGone(res, "Statement upload");
});

function normalizePaystackError(err, fallbackCode = "paystack_request_failed") {
  const status = Number(err?.status || 0);
  return {
    status: status >= 400 && status < 600 ? status : 502,
    code: String(err?.code || fallbackCode),
    message: String(err?.message || "Could not complete Paystack request."),
  };
}

app.post("/api/payments/paystack/initialize", requireStudent, async (req, res) => {
  const obligationId = parseResourceId(req.body?.obligationId);
  if (!obligationId) {
    return res.status(400).json({ error: "A valid obligationId is required.", code: "paystack_initialize_obligation_required" });
  }
  if (!paystackClient.hasSecretKey || !PAYSTACK_CALLBACK_URL) {
    return res.status(503).json({
      error: "Paystack is not configured on this server.",
      code: "paystack_initialize_not_configured",
    });
  }

  try {
    await ensurePaymentObligationsForStudent(req.session.user.username);
    await recomputeObligationSnapshotById(obligationId);
    const obligation = await get(
      `
        SELECT po.*, pi.currency, pi.title AS payment_item_title
        FROM payment_obligations po
        JOIN payment_items pi ON pi.id = po.payment_item_id
        WHERE po.id = ?
        LIMIT 1
      `,
      [obligationId]
    );
    if (!obligation) {
      return res.status(404).json({ error: "Payment obligation not found.", code: "paystack_initialize_obligation_not_found" });
    }
    if (normalizeIdentifier(obligation.student_username) !== normalizeIdentifier(req.session.user.username)) {
      return res.status(403).json({ error: "You can only pay your own obligations.", code: "paystack_initialize_forbidden" });
    }

    const expectedAmount = Number(obligation.expected_amount || 0);
    const paidAmount = Number(obligation.amount_paid_total || 0);
    const outstanding = Math.max(0, expectedAmount - paidAmount);
    if (outstanding <= 0.01) {
      return res.status(409).json({ error: "This obligation is already settled.", code: "paystack_initialize_settled" });
    }

    const amountProvided = String(req.body?.amount ?? "").trim();
    const requestedAmount = amountProvided ? parseMoneyValue(amountProvided) : outstanding;
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than zero.", code: "paystack_initialize_invalid_amount" });
    }
    if (requestedAmount - outstanding > 0.01) {
      return res.status(400).json({
        error: "Amount cannot exceed the outstanding balance.",
        code: "paystack_initialize_amount_exceeds_outstanding",
      });
    }
    const amount = Number(requestedAmount.toFixed(2));
    const amountKobo = toKoboFromAmount(amount);
    if (!amountKobo) {
      return res.status(400).json({ error: "Amount must be greater than zero.", code: "paystack_initialize_invalid_amount" });
    }

    let gatewayReference = buildPaystackGatewayReference(obligation.id, req.session.user.username);
    if (normalizeReference(gatewayReference) === normalizeReference(obligation.payment_reference)) {
      gatewayReference = `${gatewayReference}-P`;
    }
    const metadata = {
      tenant: PAYMENT_REFERENCE_TENANT_ID,
      school_id: PAYMENT_REFERENCE_TENANT_ID,
      student_username: normalizeIdentifier(req.session.user.username),
      payment_item_id: Number(obligation.payment_item_id),
      obligation_id: Number(obligation.id),
      payment_reference: String(obligation.payment_reference || ""),
    };
    const profile = await getUserProfile(req.session.user.username);
    const email = resolvePaystackCheckoutEmail(req.session.user.username, profile ? profile.email : "");
    if (!email) {
      return res.status(400).json({
        error: "Add a valid email address in your profile before paying with Paystack.",
        code: "paystack_initialize_email_required",
      });
    }
    const initializePayload = await paystackClient.initializeTransaction({
      email,
      amount: amountKobo,
      reference: gatewayReference,
      callback_url: PAYSTACK_CALLBACK_URL,
      currency: String(obligation.currency || "NGN").toUpperCase(),
      metadata,
    });
    const gatewayData = initializePayload?.data || {};
    const authorizationUrl = String(gatewayData.authorization_url || "").trim();
    const accessCode = String(gatewayData.access_code || "").trim();
    const reference = sanitizeTransactionRef(gatewayData.reference || gatewayReference);
    if (!authorizationUrl || !accessCode || !reference) {
      return res.status(502).json({
        error: "Paystack initialize response was incomplete.",
        code: "paystack_initialize_invalid_response",
      });
    }

    await withSqlTransaction(async () => {
      const session = await upsertPaystackSession({
        obligationId: obligation.id,
        studentId: req.session.user.username,
        gatewayReference: reference,
        amount,
        status: "initiated",
        payload: {
          request: {
            email,
            amount,
            amount_kobo: amountKobo,
            metadata,
            callback_url: PAYSTACK_CALLBACK_URL,
            currency: String(obligation.currency || "NGN").toUpperCase(),
          },
          response: initializePayload,
        },
      });
      await logAuditEvent(
        req,
        "initialize_paystack",
        "paystack_session",
        session?.id || null,
        req.session.user.username,
        `Initialized Paystack checkout ${reference} for obligation #${obligation.id}.`
      );
    });

    return res.status(200).json({
      ok: true,
      authorization_url: authorizationUrl,
      access_code: accessCode,
      reference,
    });
  } catch (err) {
    const normalizedError = normalizePaystackError(err, "paystack_initialize_failed");
    return res.status(normalizedError.status).json({
      error: normalizedError.message,
      code: normalizedError.code,
    });
  }
});

app.get("/api/payments/paystack/callback", async (req, res) => {
  const reference = sanitizeTransactionRef(req.query?.reference || req.query?.trxref || "");
  if (reference) {
    try {
      await updatePaystackSessionStatusByReference(reference, "pending_webhook", {
        callback_query: req.query || {},
        callback_received_at: new Date().toISOString(),
      });
    } catch (_err) {
      // Callback endpoint must stay non-blocking for UX redirects.
    }
  }
  const params = new URLSearchParams();
  params.set("paystack_status", "pending_webhook");
  if (reference) {
    params.set("paystack_reference", reference);
  }
  return res.redirect(`/payments.html?${params.toString()}`);
});

app.post("/api/payments/paystack/reference-requests", requireStudent, async (req, res) => {
  const reference = sanitizeTransactionRef(req.body?.reference || "");
  if (!reference) {
    return res.status(400).json({
      error: "A Paystack reference is required.",
      code: "paystack_reference_request_reference_required",
    });
  }

  const studentUsername = normalizeIdentifier(req.session?.user?.username || "");
  if (!studentUsername) {
    return res.status(401).json({
      error: "Authentication required.",
      code: "paystack_reference_request_auth_required",
    });
  }
  const note = String(req.body?.note || "")
    .trim()
    .slice(0, 500);
  let obligationId = parseResourceId(req.body?.obligationId);

  try {
    if (obligationId) {
      const obligation = await get("SELECT id, student_username FROM payment_obligations WHERE id = ? LIMIT 1", [obligationId]);
      if (!obligation) {
        return res.status(404).json({
          error: "Payment obligation not found.",
          code: "paystack_reference_request_obligation_not_found",
        });
      }
      if (normalizeIdentifier(obligation.student_username) !== studentUsername) {
        return res.status(403).json({
          error: "You can only post references for your own payment obligations.",
          code: "paystack_reference_request_forbidden",
        });
      }
    } else {
      const paystackSession = await get(
        `
          SELECT obligation_id
          FROM paystack_sessions
          WHERE gateway_reference = ?
            AND student_id = ?
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        `,
        [reference, studentUsername]
      );
      obligationId = parseResourceId(paystackSession?.obligation_id);
    }

    const normalizedReference = normalizeReference(reference);
    const existingPending = await get(
      `
        SELECT id
        FROM paystack_reference_requests
        WHERE student_username = ?
          AND normalized_reference = ?
          AND status = 'pending'
        ORDER BY id DESC
        LIMIT 1
      `,
      [studentUsername, normalizedReference]
    );
    if (existingPending?.id) {
      const existingRequest = await getPaystackReferenceRequestDetailsById(existingPending.id);
      return res.status(200).json({
        ok: true,
        duplicate: true,
        request: existingRequest,
      });
    }

    await run(
      `
        INSERT INTO paystack_reference_requests (
          student_username,
          obligation_id,
          reference,
          normalized_reference,
          note,
          status,
          result_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'pending', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [studentUsername, obligationId || null, reference, normalizedReference, note]
    );
    const inserted = await get("SELECT last_insert_rowid() AS id");
    const requestRow = await getPaystackReferenceRequestDetailsById(inserted?.id);
    return res.status(201).json({
      ok: true,
      request: requestRow,
    });
  } catch (_err) {
    return res.status(500).json({
      error: "Could not post Paystack reference request.",
      code: "paystack_reference_request_create_failed",
    });
  }
});

app.get("/api/my/payments/paystack/reference-requests", requireStudent, async (req, res) => {
  try {
    const status = String(req.query?.status || "all").trim().toLowerCase();
    const items = await listPaystackReferenceRequests({
      status,
      studentUsername: req.session.user.username,
      limit: req.query?.limit,
    });
    return res.json({ items });
  } catch (_err) {
    return res.status(500).json({
      error: "Could not load your Paystack reference requests.",
      code: "paystack_reference_request_list_failed",
    });
  }
});

async function handlePaystackReferenceRequestList(req, res) {
  try {
    const status = String(req.query?.status || "all").trim().toLowerCase();
    const items = await listPaystackReferenceRequests({
      status,
      limit: req.query?.limit,
    });
    return res.json({ items });
  } catch (_err) {
    return res.status(500).json({
      error: "Could not load Paystack reference requests.",
      code: "paystack_reference_request_list_failed",
    });
  }
}

app.get(
  [
    "/api/lecturer/paystack-reference-requests",
    "/api/teacher/paystack-reference-requests",
    "/api/lecturer/payments/paystack/reference-requests",
    "/api/teacher/payments/paystack/reference-requests",
  ],
  requireTeacher,
  async (req, res) => {
    return handlePaystackReferenceRequestList(req, res);
  }
);

app.get(["/api/admin/paystack-reference-requests", "/api/admin/payments/paystack/reference-requests"], requireAdmin, async (req, res) => {
  return handlePaystackReferenceRequestList(req, res);
});

app.post("/api/payments/webhook/paystack", async (req, res) => {
  try {
    if (!PAYSTACK_WEBHOOK_SECRET) {
      return res.status(503).json({
        error: "Paystack webhook secret is not configured.",
        code: "paystack_webhook_not_configured",
      });
    }
    const signature = req.get("x-paystack-signature");
    if (!isValidPaystackSignature(req.rawBody, signature, PAYSTACK_WEBHOOK_SECRET)) {
      return res.status(401).json({
        error: "Invalid Paystack webhook signature.",
        code: "paystack_webhook_invalid_signature",
      });
    }

    const payload = req.body || {};
    const eventType = String(payload.event || "").trim().toLowerCase();
    if (eventType !== "charge.success") {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const normalized = normalizePaystackTransactionForIngestion(payload);
    if (!normalized) {
      return res.status(400).json({
        error: "Invalid Paystack charge payload.",
        code: "paystack_webhook_invalid_payload",
      });
    }

    const actorReq = getPaystackSystemRequest();
    const ingest = await ingestNormalizedTransaction(normalized.payload, {
      actorReq,
      allowAutoApprove: true,
    });
    if (!ingest.ok) {
      return res.status(400).json({
        error: ingest.error || "Could not process Paystack transaction.",
        code: "paystack_webhook_ingest_failed",
      });
    }

    const transactionId = parseResourceId(ingest.transaction?.id);
    const transaction = transactionId ? await getReconciliationTransactionById(transactionId) : ingest.transaction || null;
    const nextSessionStatus = mapPaystackSessionStatusFromTransactionStatus(transaction?.status);
    const existingSession = await get("SELECT * FROM paystack_sessions WHERE gateway_reference = ? LIMIT 1", [
      normalized.gatewayReference,
    ]);
    const previousStatus = String(existingSession?.status || "").trim().toLowerCase();
    let sessionRow = null;
    if (existingSession) {
      sessionRow = await updatePaystackSessionStatusByReference(normalized.gatewayReference, nextSessionStatus, {
        webhook_event: eventType,
        webhook_received_at: new Date().toISOString(),
        source_event_id: normalized.sourceEventId,
        transaction_id: transaction?.id || null,
      });
    } else {
      const metadataObligationId = parseResourceId(
        normalized.metadata?.obligation_id || normalized.metadata?.obligationId || transaction?.matched_obligation_id
      );
      const metadataStudent = normalizeIdentifier(
        normalized.metadata?.student_username ||
          normalized.metadata?.studentUsername ||
          normalized.metadata?.student ||
          transaction?.student_username ||
          transaction?.student_hint_username
      );
      if (metadataObligationId && metadataStudent) {
        sessionRow = await upsertPaystackSession({
          obligationId: metadataObligationId,
          studentId: metadataStudent,
          gatewayReference: normalized.gatewayReference,
          amount: normalized.amount,
          status: nextSessionStatus,
          payload: {
            webhook_event: eventType,
            webhook_received_at: new Date().toISOString(),
            source_event_id: normalized.sourceEventId,
            transaction_id: transaction?.id || null,
          },
        });
      }
    }

    if (transaction && (!previousStatus || previousStatus !== nextSessionStatus)) {
      const obligationId =
        transaction.matched_obligation_id ||
        parseResourceId(normalized.metadata?.obligation_id || normalized.metadata?.obligationId) ||
        null;
      await logReconciliationEvent(
        transaction.id,
        obligationId,
        actorReq,
        "paystack_webhook_confirmed",
        `Paystack charge.success confirmed (${normalized.gatewayReference}).`
      );
      const studentUsername = normalizeIdentifier(
        transaction.student_username ||
          transaction.student_hint_username ||
          normalized.metadata?.student_username ||
          normalized.metadata?.studentUsername
      );
      const paymentItemId =
        parseResourceId(transaction.payment_item_id || transaction.payment_item_hint_id) ||
        parseResourceId(normalized.metadata?.payment_item_id || normalized.metadata?.paymentItemId);
      if (studentUsername && paymentItemId) {
        if (nextSessionStatus === "approved") {
          await createReconciliationStatusNotification(
            studentUsername,
            paymentItemId,
            "Paystack payment approved",
            `Your Paystack payment ${normalized.gatewayReference} was confirmed and approved.`,
            { createdBy: "system-paystack" }
          );
        } else {
          await createReconciliationStatusNotification(
            studentUsername,
            paymentItemId,
            "Paystack payment needs review",
            `Your Paystack payment ${normalized.gatewayReference} was received and routed for review.`,
            { createdBy: "system-paystack" }
          );
        }
      }
    }

    await run(
      `
        INSERT INTO audit_logs (
          actor_username,
          actor_role,
          action,
          content_type,
          content_id,
          target_owner,
          summary
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "system-paystack",
        "system-paystack",
        "ingest",
        "payment_transaction",
        transaction?.id || null,
        transaction?.student_username || transaction?.student_hint_username || null,
        `Paystack webhook ${ingest.idempotent ? "idempotent-hit" : "ingested"} (${normalized.sourceEventId})`,
      ]
    );

    return res.status(200).json({
      ok: true,
      inserted: !!ingest.inserted,
      idempotent: !!ingest.idempotent,
      transaction_id: transaction?.id || null,
      status: transaction?.status || null,
      session_status: sessionRow?.status || nextSessionStatus,
    });
  } catch (err) {
    const normalizedError = normalizePaystackError(err, "paystack_webhook_failed");
    return res.status(normalizedError.status).json({
      error: normalizedError.message,
      code: normalizedError.code,
    });
  }
});

app.post("/api/payments/paystack/verify", async (req, res) => {
  const isInternalJob = isTrustedPaystackInternalVerifyRequest(req);
  if (!isInternalJob) {
    if (!isAuthenticated(req) || !req.session?.user) {
      return res.status(401).json({
        error: "Authentication required.",
        code: "paystack_verify_auth_required",
      });
    }
    const role = String(req.session.user.role || "").trim().toLowerCase();
    if (role !== "teacher" && role !== "admin") {
      return res.status(403).json({
        error: "Only lecturers or admins can verify Paystack references.",
        code: "paystack_verify_forbidden",
      });
    }
  }
  const reference = sanitizeTransactionRef(req.body?.reference || "");
  if (!reference) {
    return res.status(400).json({
      error: "A Paystack reference is required.",
      code: "paystack_verify_reference_required",
    });
  }
  try {
    const actorUsername = isInternalJob ? "system-paystack" : req.session?.user?.username || "unknown";
    const actorRole = isInternalJob ? "system-paystack" : req.session?.user?.role || "unknown";
    const result = await verifyAndIngestPaystackReference(reference, {
      actorReq: isInternalJob ? getPaystackSystemRequest() : req,
      verifiedBy: actorUsername,
      verifiedByRole: actorRole,
    });
    const resultPayload = {
      verified_at: new Date().toISOString(),
      reference: result.reference,
      transaction_id: result.transaction?.id || null,
      status: result.transaction?.status || null,
      gateway_status: result.gatewayStatus,
      idempotent: !!result.ingest?.idempotent,
      inserted: !!result.ingest?.inserted,
      session_status: result.sessionStatus || null,
    };
    await resolvePendingPaystackReferenceRequestsByReference(result.reference, {
      status: "verified",
      resolvedBy: actorUsername,
      resolvedByRole: actorRole,
      result: resultPayload,
    });

    return res.status(200).json({
      ok: true,
      inserted: !!result.ingest?.inserted,
      idempotent: !!result.ingest?.idempotent,
      transaction_id: result.transaction?.id || null,
      status: result.transaction?.status || null,
      gateway_status: result.gatewayStatus,
      reference: result.reference,
      session_status: result.sessionStatus || null,
    });
  } catch (err) {
    const normalizedError = normalizePaystackError(err, "paystack_verify_failed");
    return res.status(normalizedError.status).json({
      error: normalizedError.message,
      code: normalizedError.code,
    });
  }
});

app.post("/api/payments/paystack/reference-requests/bulk-verify", requireTeacher, async (req, res) => {
  const ids = parseReceiptIdList(req.body?.requestIds, 200);
  if (!ids.length) {
    return res.status(400).json({
      error: "At least one Paystack reference request must be selected.",
      code: "paystack_reference_request_bulk_empty",
    });
  }

  try {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await all(
      `
        SELECT id, reference, status
        FROM paystack_reference_requests
        WHERE id IN (${placeholders})
      `,
      ids
    );
    const rowsById = new Map(rows.map((row) => [Number(row.id || 0), row]));
    const verificationCache = new Map();
    const results = [];
    const actorUsername = req.session?.user?.username || "unknown";
    const actorRole = req.session?.user?.role || "teacher";

    for (const requestId of ids) {
      const row = rowsById.get(requestId);
      if (!row) {
        results.push({
          id: requestId,
          ok: false,
          error: "Reference request not found.",
          code: "paystack_reference_request_not_found",
        });
        continue;
      }
      if (normalizePaystackReferenceRequestStatus(row.status) === "verified") {
        const updated = await getPaystackReferenceRequestDetailsById(requestId);
        results.push({
          id: requestId,
          ok: true,
          skipped: true,
          status: "verified",
          transaction_id: updated?.result?.transaction_id || null,
        });
        continue;
      }

      const normalizedReference = normalizeReference(row.reference);
      let verification = verificationCache.get(normalizedReference);
      if (!verification) {
        try {
          const verifyResult = await verifyAndIngestPaystackReference(row.reference, {
            actorReq: req,
            verifiedBy: actorUsername,
            verifiedByRole: actorRole,
          });
          verification = { ok: true, verifyResult };
        } catch (err) {
          verification = { ok: false, err };
        }
        verificationCache.set(normalizedReference, verification);
      }

      if (verification.ok) {
        const verifyResult = verification.verifyResult;
        const successPayload = {
          verified_at: new Date().toISOString(),
          reference: verifyResult.reference,
          transaction_id: verifyResult.transaction?.id || null,
          status: verifyResult.transaction?.status || null,
          gateway_status: verifyResult.gatewayStatus,
          idempotent: !!verifyResult.ingest?.idempotent,
          inserted: !!verifyResult.ingest?.inserted,
          session_status: verifyResult.sessionStatus || null,
        };
        await updatePaystackReferenceRequestById(requestId, {
          status: "verified",
          resolvedBy: actorUsername,
          resolvedByRole: actorRole,
          result: successPayload,
        });
        await resolvePendingPaystackReferenceRequestsByReference(verifyResult.reference, {
          status: "verified",
          resolvedBy: actorUsername,
          resolvedByRole: actorRole,
          result: successPayload,
        });
        results.push({
          id: requestId,
          ok: true,
          status: "verified",
          reference: verifyResult.reference,
          transaction_id: verifyResult.transaction?.id || null,
        });
      } else {
        const normalizedError = normalizePaystackError(verification.err, "paystack_verify_failed");
        const failedPayload = {
          failed_at: new Date().toISOString(),
          error: normalizedError.message,
          code: normalizedError.code,
          gateway_status: verification.err?.gateway_status || null,
        };
        await updatePaystackReferenceRequestById(requestId, {
          status: "failed",
          resolvedBy: actorUsername,
          resolvedByRole: actorRole,
          result: failedPayload,
        });
        results.push({
          id: requestId,
          ok: false,
          status: "failed",
          reference: String(row.reference || ""),
          error: normalizedError.message,
          code: normalizedError.code,
          gateway_status: verification.err?.gateway_status || null,
        });
      }
    }

    const successCount = results.filter((entry) => entry.ok).length;
    return res.json({
      ok: true,
      total: results.length,
      successCount,
      failureCount: results.length - successCount,
      results,
    });
  } catch (_err) {
    return res.status(500).json({
      error: "Could not bulk verify Paystack reference requests.",
      code: "paystack_reference_request_bulk_failed",
    });
  }
});

app.post("/api/payments/webhook", async (req, res) => {
  return sendPaystackOnlyGone(res, "Generic payment webhook ingestion");
});

async function loadReconciliationExceptionsPayload(queryInput) {
  const filters = parseReconciliationFilters(queryInput || {});
  const query = buildReconciliationExceptionQuery(filters);
  const [rows, totalRow] = await Promise.all([all(query.sql, query.params), get(query.countSql, query.params)]);
  const total = Number(totalRow?.total || 0);
  const items = rows.map((row) => ({
    ...row,
    reasons: parseJsonArray(row.reasons_json || "[]", []),
  }));
  return {
    filters,
    items,
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    },
  };
}

app.get("/api/analytics/overview", requireTeacher, async (req, res) => {
  try {
    const filters = await parseAnalyticsFilters(req, req.query || {});
    const payload = await getAnalyticsOverviewPayload(req, filters);
    return res.json(payload);
  } catch (err) {
    if (isAnalyticsValidationError(err)) {
      return res.status(400).json({ error: err.error || "Invalid analytics filters.", code: "analytics_invalid_filters" });
    }
    return res.status(500).json({ error: "Could not load analytics overview.", code: "analytics_overview_failed" });
  }
});

app.get("/api/analytics/revenue-series", requireTeacher, async (req, res) => {
  try {
    const filters = await parseAnalyticsFilters(req, req.query || {}, {
      requireGranularity: true,
    });
    const payload = await getAnalyticsRevenueSeriesPayload(req, filters);
    return res.json(payload);
  } catch (err) {
    if (isAnalyticsValidationError(err)) {
      return res.status(400).json({ error: err.error || "Invalid analytics filters.", code: "analytics_invalid_filters" });
    }
    return res.status(500).json({ error: "Could not load analytics revenue series.", code: "analytics_revenue_failed" });
  }
});

app.get("/api/analytics/status-breakdown", requireTeacher, async (req, res) => {
  try {
    const filters = await parseAnalyticsFilters(req, req.query || {});
    const payload = await getAnalyticsStatusBreakdownPayload(req, filters);
    return res.json(payload);
  } catch (err) {
    if (isAnalyticsValidationError(err)) {
      return res.status(400).json({ error: err.error || "Invalid analytics filters.", code: "analytics_invalid_filters" });
    }
    return res.status(500).json({ error: "Could not load analytics status breakdown.", code: "analytics_status_failed" });
  }
});

app.get("/api/analytics/reconciliation-funnel", requireTeacher, async (req, res) => {
  try {
    const filters = await parseAnalyticsFilters(req, req.query || {});
    const payload = await getAnalyticsReconciliationFunnelPayload(req, filters);
    return res.json(payload);
  } catch (err) {
    if (isAnalyticsValidationError(err)) {
      return res.status(400).json({ error: err.error || "Invalid analytics filters.", code: "analytics_invalid_filters" });
    }
    return res.status(500).json({ error: "Could not load analytics reconciliation funnel.", code: "analytics_funnel_failed" });
  }
});

app.get("/api/analytics/top-items", requireTeacher, async (req, res) => {
  try {
    const filters = await parseAnalyticsFilters(req, req.query || {}, {
      includeLimit: true,
      includeSort: true,
      defaultLimit: 10,
      maxLimit: 100,
    });
    const payload = await getAnalyticsTopItemsPayload(req, filters);
    return res.json(payload);
  } catch (err) {
    if (isAnalyticsValidationError(err)) {
      return res.status(400).json({ error: err.error || "Invalid analytics filters.", code: "analytics_invalid_filters" });
    }
    return res.status(500).json({ error: "Could not load analytics top payment items.", code: "analytics_top_items_failed" });
  }
});

app.get("/api/analytics/paystack-funnel", requireTeacher, async (req, res) => {
  try {
    const filters = await parseAnalyticsFilters(req, req.query || {});
    const payload = await getAnalyticsPaystackFunnelPayload(req, filters);
    return res.json(payload);
  } catch (err) {
    if (isAnalyticsValidationError(err)) {
      return res.status(400).json({ error: err.error || "Invalid analytics filters.", code: "analytics_invalid_filters" });
    }
    return res.status(500).json({ error: "Could not load analytics Paystack funnel.", code: "analytics_paystack_funnel_failed" });
  }
});

app.get("/api/analytics/aging", requireTeacher, async (req, res) => {
  try {
    const filters = await parseAnalyticsFilters(req, req.query || {});
    const payload = await getAnalyticsAgingPayload(req, filters);
    return res.json(payload);
  } catch (err) {
    if (isAnalyticsValidationError(err)) {
      return res.status(400).json({ error: err.error || "Invalid analytics filters.", code: "analytics_invalid_filters" });
    }
    return res.status(500).json({ error: "Could not load analytics aging data.", code: "analytics_aging_failed" });
  }
});

app.get("/api/analytics/export.csv", requireTeacher, async (req, res) => {
  try {
    const filters = await parseAnalyticsFilters(req, req.query || {}, {
      includeLimit: true,
      includeSort: true,
      defaultLimit: 10,
      maxLimit: 100,
    });
    const [overview, revenue, statusBreakdown, reconciliationFunnel, topItems, paystackFunnel, aging] = await Promise.all([
      getAnalyticsOverviewPayload(req, filters),
      getAnalyticsRevenueSeriesPayload(req, filters),
      getAnalyticsStatusBreakdownPayload(req, filters),
      getAnalyticsReconciliationFunnelPayload(req, filters),
      getAnalyticsTopItemsPayload(req, filters),
      getAnalyticsPaystackFunnelPayload(req, filters),
      getAnalyticsAgingPayload(req, filters),
    ]);
    const csvText = buildAnalyticsExportCsv(filters, {
      overview,
      revenue,
      statusBreakdown,
      reconciliationFunnel,
      topItems,
      paystackFunnel,
      aging,
    });
    const fileName = `analytics-${filters.from}-to-${filters.to}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(csvText);
  } catch (err) {
    if (isAnalyticsValidationError(err)) {
      return res.status(400).json({ error: err.error || "Invalid analytics filters.", code: "analytics_invalid_filters" });
    }
    return res.status(500).json({ error: "Could not export analytics CSV.", code: "analytics_export_failed" });
  }
});

app.get(["/api/lecturer/reconciliation/summary", "/api/teacher/reconciliation/summary"], requireTeacher, async (_req, res) => {
  try {
    const summary = await getReconciliationSummary();
    return res.json(summary);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load reconciliation summary.", code: "reconciliation_summary_failed" });
  }
});

app.get("/api/admin/reconciliation/summary", requireAdmin, async (_req, res) => {
  try {
    const summary = await getReconciliationSummary();
    return res.json(summary);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load reconciliation summary.", code: "reconciliation_summary_failed" });
  }
});

app.get("/api/reconciliation/summary", requireTeacher, async (_req, res) => {
  try {
    const summary = await getReconciliationSummary();
    return res.json(summary);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load reconciliation summary.", code: "reconciliation_summary_failed" });
  }
});

async function handleReconciliationExceptionsList(req, res) {
  try {
    const payload = await loadReconciliationExceptionsPayload(req.query || {});
    if (payload.filters.legacy) {
      return res.json(payload.items);
    }
    return res.json(payload);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load approved transactions.", code: "reconciliation_exceptions_failed" });
  }
}

app.get(["/api/lecturer/reconciliation/exceptions", "/api/teacher/reconciliation/exceptions"], requireTeacher, async (req, res) => {
  return handleReconciliationExceptionsList(req, res);
});

app.get("/api/admin/reconciliation/exceptions", requireAdmin, async (req, res) => {
  return handleReconciliationExceptionsList(req, res);
});

app.get("/api/reconciliation/exceptions", requireTeacher, async (req, res) => {
  return handleReconciliationExceptionsList(req, res);
});

async function handleReconciliationAction(req, res, action) {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid transaction ID.", code: "reconciliation_invalid_id" });
  }
  try {
    const row = await applyReconciliationReviewAction(req, id, action, {
      note: req.body?.note,
      obligationId: req.body?.obligationId,
      primaryTransactionId: req.body?.primaryTransactionId,
    });
    return res.json({ ok: true, transaction: row });
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error, code: "reconciliation_action_failed" });
    }
    return res.status(500).json({ error: "Could not apply reconciliation action.", code: "reconciliation_action_failed" });
  }
}

app.post("/api/reconciliation/:id/approve", requireTeacher, async (req, res) => {
  return handleReconciliationAction(req, res, "approve");
});

app.post("/api/reconciliation/:id/reject", requireTeacher, async (req, res) => {
  return handleReconciliationAction(req, res, "reject");
});

app.post("/api/reconciliation/:id/request-student-confirmation", requireTeacher, async (req, res) => {
  return handleReconciliationAction(req, res, "request_student_confirmation");
});

app.post("/api/reconciliation/:id/merge-duplicates", requireTeacher, async (req, res) => {
  return handleReconciliationAction(req, res, "merge_duplicates");
});

app.post("/api/reconciliation/bulk", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Bulk reconciliation reviewer actions");
});

app.post("/api/payment-receipts", requireStudent, (req, res) => {
  return sendPaystackOnlyGone(res, "Manual receipt submission");
});

app.get("/api/my/payment-receipts", requireAuth, async (req, res) => {
  if (req.session.user.role !== "student") {
    return res.status(403).json({ error: "Only students can view this resource." });
  }
  try {
    const rowsSql = `
        SELECT
          pr.id,
          pr.payment_item_id,
          pr.amount_paid,
          pr.paid_at,
          pr.transaction_ref,
          pr.status,
          pr.submitted_at,
          pr.reviewed_by,
          pr.reviewed_at,
          pr.rejection_reason,
          pr.verification_notes,
          COALESCE(ard.receipt_sent, 0) AS approved_receipt_sent,
          ard.receipt_generated_at AS approved_receipt_generated_at,
          ard.receipt_sent_at AS approved_receipt_sent_at,
          CASE
            WHEN COALESCE(ard.receipt_file_path, '') != '' THEN 1
            ELSE 0
          END AS approved_receipt_available,
          pi.title AS payment_item_title,
          pi.expected_amount,
          pi.currency,
          pi.due_date
        FROM payment_receipts pr
        JOIN payment_items pi ON pi.id = pr.payment_item_id
        LEFT JOIN approved_receipt_dispatches ard ON ard.payment_receipt_id = pr.id
        WHERE pr.student_username = ?
          AND pr.status = 'approved'
        ORDER BY COALESCE(pr.reviewed_at, pr.submitted_at) DESC, pr.id DESC
      `;
    const queryRows = () => all(rowsSql, [req.session.user.username]);
    let rows = await queryRows();
    const pendingApprovedReceiptIds = rows
      .filter((row) => String(row.status || "").toLowerCase() === "approved" && Number(row.approved_receipt_available || 0) !== 1)
      .map((row) => parseResourceId(row.id))
      .filter((receiptId) => !!receiptId)
      .slice(0, 3);
    if (pendingApprovedReceiptIds.length) {
      for (const paymentReceiptId of pendingApprovedReceiptIds) {
        const delivery = await triggerApprovedReceiptDispatchForReceipt(paymentReceiptId, {
          actorUsername: req.session.user.username || "system-student",
          forceEnabled: true,
        });
        if (delivery && (delivery.error || Number(delivery.failed || 0) > 0)) {
          console.error(
            `[approved-receipts] student receipt list backfill failed payment_receipt_id=${paymentReceiptId} reason=${
              delivery.error || "unknown"
            }`
          );
        }
      }
      rows = await queryRows();
    }
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load your approved receipts." });
  }
});

app.get("/api/my/payment-ledger", requireStudent, async (req, res) => {
  try {
    await ensurePaymentObligationsForStudent(req.session.user.username);
    const rows = await all(
      `
        SELECT
          pi.id,
          pi.title,
          pi.description,
          pi.expected_amount,
          pi.currency,
          pi.due_date,
          pi.available_until,
          pi.availability_days,
          pi.created_by,
          po.id AS obligation_id,
          COALESCE(po.amount_paid_total, 0) AS approved_paid,
          (
            COALESCE(
              (
                SELECT SUM(pt.amount)
                FROM payment_transactions pt
                WHERE pt.matched_obligation_id = po.id
                  AND pt.status IN ('needs_review', 'needs_student_confirmation', 'unmatched')
              ),
              0
            )
          ) AS pending_paid,
          po.payment_reference AS my_reference,
          po.status AS obligation_status,
          (
            SELECT ps.status
            FROM paystack_sessions ps
            WHERE ps.obligation_id = po.id
              AND ps.student_id = ?
            ORDER BY ps.updated_at DESC, ps.id DESC
            LIMIT 1
          ) AS paystack_state,
          (
            SELECT ps.gateway_reference
            FROM paystack_sessions ps
            WHERE ps.obligation_id = po.id
              AND ps.student_id = ?
            ORDER BY ps.updated_at DESC, ps.id DESC
            LIMIT 1
          ) AS paystack_reference,
          (
            SELECT pr2.id
            FROM payment_receipts pr2
            JOIN approved_receipt_dispatches ard2 ON ard2.payment_receipt_id = pr2.id
            WHERE pr2.payment_item_id = pi.id
              AND pr2.student_username = ?
              AND pr2.status = 'approved'
              AND COALESCE(ard2.receipt_file_path, '') != ''
            ORDER BY COALESCE(pr2.reviewed_at, pr2.submitted_at) DESC, pr2.id DESC
            LIMIT 1
          ) AS approved_receipt_id,
          (
            SELECT pr3.id
            FROM payment_receipts pr3
            WHERE pr3.payment_item_id = pi.id
              AND pr3.student_username = ?
              AND pr3.status = 'approved'
            ORDER BY COALESCE(pr3.reviewed_at, pr3.submitted_at) DESC, pr3.id DESC
            LIMIT 1
          ) AS approved_receipt_candidate_id
        FROM payment_items pi
        LEFT JOIN payment_obligations po
          ON po.payment_item_id = pi.id
         AND po.student_username = ?
        WHERE (pi.available_until IS NULL OR datetime(pi.available_until) > CURRENT_TIMESTAMP)
        ORDER BY
          CASE WHEN pi.due_date IS NULL OR pi.due_date = '' THEN 1 ELSE 0 END ASC,
          pi.due_date ASC,
          pi.id ASC
      `,
      [
        req.session.user.username,
        req.session.user.username,
        req.session.user.username,
        req.session.user.username,
        req.session.user.username,
      ]
    );

    for (const row of rows) {
      const paymentItemId = parseResourceId(row.id);
      const obligationId = parseResourceId(row.obligation_id);
      const expectedAmount = Number(row.expected_amount || 0);
      const approvedPaid = Number(row.approved_paid || 0);
      const isSettled = Number.isFinite(expectedAmount) && approvedPaid >= expectedAmount - 0.01;
      const hasDownloadableApprovedReceipt = !!parseResourceId(row.approved_receipt_id);
      if (!paymentItemId || !obligationId || !isSettled || hasDownloadableApprovedReceipt) {
        continue;
      }
      const candidateReceiptId = parseResourceId(row.approved_receipt_candidate_id);
      if (candidateReceiptId) {
        const delivery = await triggerApprovedReceiptDispatchForReceipt(candidateReceiptId, {
          actorUsername: "system-ledger",
          forceEnabled: true,
        });
        if (delivery && (delivery.error || Number(delivery.failed || 0) > 0)) {
          console.error(
            `[approved-receipts] ledger candidate backfill failed payment_receipt_id=${candidateReceiptId} reason=${
              delivery.error || "unknown"
            }`
          );
        }
        const dispatch = await getApprovedReceiptDispatchByReceiptId(candidateReceiptId);
        if (dispatch && dispatch.receipt_file_path) {
          row.approved_receipt_id = candidateReceiptId;
          continue;
        }
      }
      const latestApprovedTransaction = await get(
        `
          SELECT id
          FROM payment_transactions
          WHERE matched_obligation_id = ?
            AND status = 'approved'
          ORDER BY COALESCE(reviewed_at, created_at) DESC, id DESC
          LIMIT 1
        `,
        [obligationId]
      );
      const approvedTransactionId = parseResourceId(latestApprovedTransaction?.id);
      if (!approvedTransactionId) {
        continue;
      }
      const receiptGeneration = await ensureApprovedReceiptGeneratedForTransaction(approvedTransactionId, {
        actorReq: createSystemActorRequest("system-ledger", "system-reconciliation"),
        reason: "student_ledger_backfill",
      });
      if (receiptGeneration && receiptGeneration.ok && receiptGeneration.receiptId) {
        row.approved_receipt_id = receiptGeneration.receiptId;
      }
    }

    const items = rows.map((row) => {
      const expectedAmount = Number(row.expected_amount || 0);
      const approvedPaid = Number(row.approved_paid || 0);
      const pendingPaid = Number(row.pending_paid || 0);
      const outstanding = Math.max(0, expectedAmount - approvedPaid);
      const daysUntilDue = getDaysUntilDue(row.due_date);
      const reminder = getReminderMetadata(daysUntilDue, outstanding);
      const { approved_receipt_candidate_id: _approvedReceiptCandidateId, ...rowWithoutCandidate } = row;
      return {
        ...rowWithoutCandidate,
        expected_amount: expectedAmount,
        approved_paid: approvedPaid,
        pending_paid: pendingPaid,
        approved_receipt_id: parseResourceId(row.approved_receipt_id),
        outstanding,
        days_until_due: daysUntilDue,
        reminder_level: reminder.level,
        reminder_text: reminder.text,
      };
    });

    const summary = items.reduce(
      (acc, item) => {
        acc.totalDue += Number(item.expected_amount || 0);
        acc.totalApprovedPaid += Number(item.approved_paid || 0);
        acc.totalPendingPaid += Number(item.pending_paid || 0);
        acc.totalOutstanding += Number(item.outstanding || 0);
        if (item.reminder_level === "overdue") {
          acc.overdueCount += 1;
        }
        if (item.reminder_level === "urgent" || item.reminder_level === "today") {
          acc.dueSoonCount += 1;
        }
        return acc;
      },
      {
        totalDue: 0,
        totalApprovedPaid: 0,
        totalPendingPaid: 0,
        totalOutstanding: 0,
        overdueCount: 0,
        dueSoonCount: 0,
      }
    );

    const nextDueItem =
      items.find((item) => Number(item.outstanding || 0) > 0 && Number.isFinite(item.days_until_due) && item.days_until_due >= 0) ||
      null;

    const timeline = await all(
      `
        SELECT
          re.id,
          re.action,
          re.note,
          re.created_at,
          pi.title AS payment_item_title
        FROM reconciliation_events re
        JOIN payment_obligations po ON po.id = re.obligation_id
        LEFT JOIN payment_items pi ON pi.id = po.payment_item_id
        WHERE po.student_username = ?
        ORDER BY re.created_at DESC, re.id DESC
        LIMIT 25
      `,
      [req.session.user.username]
    );

    return res.json({
      summary,
      nextDueItem,
      items,
      timeline,
      generatedAt: new Date().toISOString(),
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load student payment ledger." });
  }
});

app.get(["/api/lecturer/payment-receipts", "/api/teacher/payment-receipts"], requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review queue");
});

app.get("/api/admin/payment-receipts", requireAdmin, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review queue");
});

async function getReceiptQueueRowById(id) {
  return get(
    `
      SELECT
        pr.id,
        pr.payment_item_id,
        pr.student_username,
        pr.amount_paid,
        pr.paid_at,
        pr.transaction_ref,
        pr.status,
        pr.submitted_at,
        pr.assigned_reviewer,
        pr.assigned_at,
        pr.reviewed_by,
        pr.reviewed_at,
        pr.rejection_reason,
        pr.verification_notes,
        pr.extracted_text,
        pi.title AS payment_item_title,
        pi.expected_amount,
        pi.currency,
        pi.due_date,
        pi.available_until,
        pi.availability_days,
        pi.created_by AS payment_item_owner
      FROM payment_receipts pr
      JOIN payment_items pi ON pi.id = pr.payment_item_id
      WHERE pr.id = ?
      LIMIT 1
    `,
    [id]
  );
}

async function assignReceiptReviewer(req, receiptId, assigneeRaw, noteRaw = "") {
  const row = await get("SELECT id, student_username, assigned_reviewer FROM payment_receipts WHERE id = ? LIMIT 1", [receiptId]);
  if (!row) {
    throw { status: 404, error: "Receipt not found." };
  }

  const requested = normalizeIdentifier(assigneeRaw || "");
  let assignee = requested || req.session.user.username;
  if (requested === "none" || requested === "unassigned") {
    if (req.session.user.role !== "admin") {
      throw { status: 403, error: "Only admins can unassign reviewers." };
    }
    assignee = "";
  }
  if (assignee && assignee !== req.session.user.username && req.session.user.role !== "admin") {
    throw { status: 403, error: "You can only assign receipts to yourself." };
  }
  if (assignee && !(await isValidReviewerAssignee(assignee))) {
    throw { status: 400, error: "Assignee must be a valid lecturer/admin account." };
  }

  const previousAssignee = normalizeIdentifier(row.assigned_reviewer || "");
  const nextAssignee = assignee ? normalizeIdentifier(assignee) : "";
  if (previousAssignee === nextAssignee) {
    return getReceiptQueueRowById(receiptId);
  }

  await run(
    `
      UPDATE payment_receipts
      SET assigned_reviewer = ?,
          assigned_at = CASE WHEN ? = '' THEN NULL ELSE CURRENT_TIMESTAMP END
      WHERE id = ?
    `,
    [nextAssignee || null, nextAssignee, receiptId]
  );

  const assignmentMessage = nextAssignee
    ? `Assigned to reviewer ${nextAssignee}`
    : "Removed reviewer assignment";
  await logReceiptEvent(receiptId, req, "assign_reviewer", null, null, assignmentMessage);
  await appendReviewerNoteEvent(receiptId, req, noteRaw);
  await logAuditEvent(req, "review", "payment_receipt", receiptId, row.student_username, assignmentMessage);
  return getReceiptQueueRowById(receiptId);
}

async function transitionPaymentReceiptStatusById(req, id, nextStatus, actionName, options = {}) {
  const rejectionReason = String(options.rejectionReason || "").trim();
  const reviewerNoteRaw = String(options.reviewerNote || "").trim().slice(0, 500);
  if (nextStatus === "rejected" && !rejectionReason) {
    throw { status: 400, error: "Rejection reason is required." };
  }

  const row = await get("SELECT * FROM payment_receipts WHERE id = ? LIMIT 1", [id]);
  if (!row) {
    throw { status: 404, error: "Receipt not found." };
  }
  if (!ensureStatusTransition(row.status, nextStatus)) {
    throw { status: 400, error: `Cannot move receipt from ${row.status} to ${nextStatus}.` };
  }
  const paymentItem = await get("SELECT * FROM payment_items WHERE id = ? LIMIT 1", [row.payment_item_id]);
  if (!paymentItem) {
    throw { status: 400, error: "Payment item for this receipt no longer exists." };
  }

  const flags = await buildVerificationFlags(row, paymentItem);
  let existingNotes = {};
  try {
    existingNotes = row.verification_notes ? JSON.parse(row.verification_notes) : {};
  } catch (_err) {
    existingNotes = {};
  }
  const reviewerNote = reviewerNoteRaw || String(existingNotes.reviewer_note || "").trim() || null;
  const verificationNotes = {
    ...existingNotes,
    student_note: existingNotes.student_note || null,
    verification_flags: flags,
    reviewer_note: reviewerNote,
  };
  const reviewedBy = req.session.user.username;
  const rejectionValue = nextStatus === "rejected" ? rejectionReason : null;

  await run(
    `
      UPDATE payment_receipts
      SET status = ?,
          reviewed_by = ?,
          reviewed_at = CURRENT_TIMESTAMP,
          rejection_reason = ?,
          verification_notes = ?
      WHERE id = ?
    `,
    [nextStatus, reviewedBy, rejectionValue, JSON.stringify(verificationNotes), id]
  );

  const transitionNoteParts = [];
  if (nextStatus === "rejected" && rejectionReason) {
    transitionNoteParts.push(`Reason: ${rejectionReason}`);
  } else if (options.defaultEventNote) {
    transitionNoteParts.push(options.defaultEventNote);
  }
  if (reviewerNoteRaw) {
    transitionNoteParts.push(`Reviewer note: ${reviewerNoteRaw}`);
  }
  await logReceiptEvent(id, req, actionName, row.status, nextStatus, transitionNoteParts.join(" | ") || null);
  if (reviewerNoteRaw) {
    await appendReviewerNoteEvent(id, req, reviewerNoteRaw);
  }
  await logAuditEvent(
    req,
    "review",
    "payment_receipt",
    id,
    row.student_username,
    `${actionName} receipt ref ${row.transaction_ref} (${row.status} -> ${nextStatus})`
  );

  const updated = await getReceiptQueueRowById(id);
  return {
    ...updated,
    verification_flags: flags,
  };
}

async function persistStatementVerification(receiptId, statementVerification) {
  const row = await get("SELECT verification_notes FROM payment_receipts WHERE id = ? LIMIT 1", [receiptId]);
  let current = {};
  try {
    current = row?.verification_notes ? JSON.parse(row.verification_notes) : {};
  } catch (_err) {
    current = {};
  }
  const next = {
    ...current,
    statement_verification: statementVerification,
  };
  await run("UPDATE payment_receipts SET verification_notes = ? WHERE id = ?", [JSON.stringify(next), receiptId]);
}

async function verifyReceiptAgainstStatementById(req, id, options = {}) {
  const row = await getReceiptQueueRowById(id);
  if (!row) {
    throw { status: 404, error: "Receipt not found." };
  }
  if (row.status === "approved" || row.status === "rejected") {
    throw { status: 400, error: `Receipt is already ${row.status}.` };
  }
  const statement = await getTeacherStatement(req.session.user.username);
  if (!statement || !Array.isArray(statement.parsed_rows) || !statement.parsed_rows.length) {
    throw { status: 400, error: "Upload a statement of account (CSV/TXT/PDF/image) before verifying receipts." };
  }
  const statementResult = await evaluateReceiptAgainstStatement(row, statement.parsed_rows);
  const statementVerification = {
    teacher_username: req.session.user.username,
    statement_uploaded_at: statement.uploaded_at,
    statement_filename: statement.original_filename,
    compared_at: new Date().toISOString(),
    result: statementResult,
  };
  await persistStatementVerification(id, statementVerification);

  let updatedRow = await getReceiptQueueRowById(id);
  let autoAction = "manual_review_needed";
  if (statementResult.matched) {
    if (updatedRow.status === "submitted") {
      updatedRow = await transitionPaymentReceiptStatusById(req, id, "under_review", "auto_verify_move_under_review", {
        reviewerNote: "Auto-verify passed. Queue moved to under review.",
        defaultEventNote: "System verify pre-check passed.",
      });
    }
    if (updatedRow.status === "under_review") {
      updatedRow = await transitionPaymentReceiptStatusById(req, id, "approved", "auto_verify_approve", {
        reviewerNote: "Auto-verified using uploaded statement of account.",
      });
      autoAction = "approved";
    }
  } else {
    if (updatedRow.status === "submitted") {
      updatedRow = await transitionPaymentReceiptStatusById(req, id, "under_review", "auto_verify_flagged", {
        reviewerNote: "Auto-verify found mismatch with statement. Manual review required.",
        defaultEventNote: "Statement mismatch detected.",
      });
    } else {
      await appendReviewerNoteEvent(
        id,
        req,
        "Auto-verify found mismatch with statement. Manual review required."
      );
      updatedRow = await getReceiptQueueRowById(id);
    }
  }

  await persistStatementVerification(id, statementVerification);
  return {
    receipt: updatedRow,
    statement_verification: statementVerification,
    auto_action: autoAction,
    matched: statementResult.matched,
    bulk: !!options.bulk,
  };
}

async function transitionPaymentReceiptStatus(req, res, nextStatus, actionName, options = {}) {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid receipt ID." });
  }

  try {
    const receipt = await transitionPaymentReceiptStatusById(req, id, nextStatus, actionName, {
      rejectionReason: req.body?.rejectionReason,
      reviewerNote: req.body?.note,
      defaultEventNote: options.defaultEventNote,
    });
    let approvedReceiptDelivery = null;
    if (nextStatus === "approved" && options.triggerApprovedReceiptDispatch) {
      approvedReceiptDelivery = await triggerApprovedReceiptDispatchForReceipt(id, {
        actorUsername: req.session?.user?.username,
      });
      try {
        let deliveryAction = "approved_receipt_generation_ready";
        let deliveryMessage = `Immediate generation summary ready=${approvedReceiptDelivery.sent || 0} failed=${
          approvedReceiptDelivery.failed || 0
        } eligible=${approvedReceiptDelivery.eligible || 0}`;
        if (approvedReceiptDelivery.skipped) {
          deliveryAction = "approved_receipt_generation_skipped";
          deliveryMessage = `Immediate generation skipped: ${approvedReceiptDelivery.reason || "No reason provided."}`;
        } else if (approvedReceiptDelivery.error || approvedReceiptDelivery.failed > 0) {
          deliveryAction = "approved_receipt_generation_failed";
          deliveryMessage = `Immediate generation failed: ${approvedReceiptDelivery.error || "Unknown failure."}`;
        }
        await logReceiptEvent(id, req, deliveryAction, null, null, deliveryMessage);
      } catch (_logErr) {
        // Do not fail receipt approval because generation-audit logging failed.
      }
    }
    return res.json({
      ok: true,
      receipt,
      ...(approvedReceiptDelivery ? { approved_receipt_delivery: approvedReceiptDelivery } : {}),
    });
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    return res.status(500).json({ error: "Could not update payment receipt status." });
  }
}

app.post("/api/payment-receipts/:id/assign", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review");
});

app.post("/api/payment-receipts/:id/notes", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review");
});

app.get("/api/payment-receipts/:id/notes", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review");
});

app.post("/api/payment-receipts/bulk", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review");
});

app.post("/api/payment-receipts/:id/verify", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Statement-based receipt verification");
});

app.post("/api/payment-receipts/:id/under-review", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review");
});

app.post("/api/payment-receipts/:id/approve", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review");
});

app.post("/api/payment-receipts/:id/reject", requireTeacher, async (req, res) => {
  return sendPaystackOnlyGone(res, "Manual payment receipt review");
});

app.get("/api/payment-receipts/:id/file", requireAuth, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid receipt ID." });
  }
  const requestedVariant = String(req.query.variant || "approved")
    .trim()
    .toLowerCase();
  const refreshRequested = ["1", "true", "yes", "on"].includes(
    String(req.query.refresh || "").trim().toLowerCase()
  );
  if (requestedVariant === "submitted") {
    return sendPaystackOnlyGone(res, "Submitted receipt files");
  }
  if (requestedVariant !== "approved") {
    return res.status(400).json({ error: "Invalid receipt variant." });
  }
  const wantsApprovedVariant = true;
  try {
    const row = await get(
      `
        SELECT
          pr.id,
          pr.student_username,
          pr.receipt_file_path,
          ard.receipt_file_path AS approved_receipt_file_path
        FROM payment_receipts pr
        LEFT JOIN approved_receipt_dispatches ard ON ard.payment_receipt_id = pr.id
        WHERE pr.id = ?
        LIMIT 1
      `,
      [id]
    );
    if (!row) {
      return res.status(404).json({ error: "Receipt not found." });
    }
    const canAccess =
      req.session.user.role === "admin" ||
      req.session.user.role === "teacher" ||
      req.session.user.username === row.student_username;
    if (!canAccess) {
      return res.status(403).json({ error: "You do not have permission to view this receipt file." });
    }
    if (wantsApprovedVariant && refreshRequested) {
      const forcedDelivery = await triggerApprovedReceiptDispatchForReceipt(id, {
        actorUsername: req.session?.user?.username || "system-download",
        forceEnabled: true,
        forceRegenerate: true,
      });
      if (forcedDelivery && (forcedDelivery.error || Number(forcedDelivery.failed || 0) > 0)) {
        console.error(
          `[approved-receipts] forced regeneration failed payment_receipt_id=${id} reason=${
            forcedDelivery.error || "unknown"
          }`
        );
      }
    }
    let approvedReceiptPath = String(row.approved_receipt_file_path || "").trim();
    if (wantsApprovedVariant && !approvedReceiptPath) {
      const delivery = await triggerApprovedReceiptDispatchForReceipt(id, {
        actorUsername: req.session?.user?.username || "system-download",
        forceEnabled: true,
      });
      if (delivery && (delivery.error || Number(delivery.failed || 0) > 0)) {
        console.error(
          `[approved-receipts] on-demand download generation failed payment_receipt_id=${id} reason=${
            delivery.error || "unknown"
          }`
        );
      }
      const dispatch = await getApprovedReceiptDispatchByReceiptId(id);
      approvedReceiptPath = String(dispatch?.receipt_file_path || "").trim();
    }
    if (wantsApprovedVariant && !approvedReceiptPath) {
      return res.status(404).json({ error: "Approved receipt is not available yet. Please refresh and try again." });
    }

    const allowedBaseDir = approvedReceiptsDir;
    let selectedPath = approvedReceiptPath;
    if (wantsApprovedVariant && selectedPath) {
      const absoluteApprovedPath = path.resolve(selectedPath);
      const approvedPathValid = isPathInsideDirectory(allowedBaseDir, absoluteApprovedPath) && fs.existsSync(absoluteApprovedPath);
      if (!approvedPathValid) {
        const delivery = await triggerApprovedReceiptDispatchForReceipt(id, {
          actorUsername: req.session?.user?.username || "system-download",
          forceEnabled: true,
        });
        if (delivery && (delivery.error || Number(delivery.failed || 0) > 0)) {
          console.error(
            `[approved-receipts] on-demand regeneration failed payment_receipt_id=${id} reason=${
              delivery.error || "unknown"
            }`
          );
        }
        const dispatch = await getApprovedReceiptDispatchByReceiptId(id);
        selectedPath = String(dispatch?.receipt_file_path || "").trim();
      } else if (!refreshRequested && isLikelyLegacyPlainReceipt(absoluteApprovedPath)) {
        const delivery = await triggerApprovedReceiptDispatchForReceipt(id, {
          actorUsername: req.session?.user?.username || "system-download",
          forceEnabled: true,
          forceRegenerate: true,
        });
        if (delivery && (delivery.error || Number(delivery.failed || 0) > 0)) {
          console.error(
            `[approved-receipts] auto-upgrade regeneration failed payment_receipt_id=${id} reason=${
              delivery.error || "unknown"
            }`
          );
        }
        const dispatch = await getApprovedReceiptDispatchByReceiptId(id);
        selectedPath = String(dispatch?.receipt_file_path || "").trim();
      }
    }
    if (!selectedPath) {
      return res.status(404).json({ error: "Approved receipt file is missing." });
    }

    const absolutePath = path.resolve(selectedPath);
    if (!isPathInsideDirectory(allowedBaseDir, absolutePath) || !fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: "Approved receipt file is missing." });
    }
    return res.sendFile(absolutePath);
  } catch (_err) {
    return res.status(500).json({ error: "Could not open receipt file." });
  }
});

app.get(["/lecturer", "/teacher"], requireTeacher, (_req, res) => {
  res.sendFile(path.join(__dirname, "lecturer.html"));
});

app.get("/api/notifications", requireAuth, async (req, res) => {
  try {
    const isStudent = req.session.user.role === "student";
    const whereClause = isStudent ? "WHERE (n.expires_at IS NULL OR datetime(n.expires_at) > CURRENT_TIMESTAMP)" : "";
    const rows = await all(
      `
        SELECT
          n.id,
          n.title,
          n.body,
          n.category,
          n.is_urgent,
          n.is_pinned,
          n.expires_at,
          n.related_payment_item_id,
          n.auto_generated,
          n.created_by,
          n.created_at,
          CASE WHEN nr.notification_id IS NULL THEN 0 ELSE 1 END AS is_read,
          user_reaction.reaction AS user_reaction
        FROM notifications n
        LEFT JOIN notification_reads nr
          ON nr.notification_id = n.id
         AND nr.username = ?
        LEFT JOIN notification_reactions user_reaction
          ON user_reaction.notification_id = n.id
         AND user_reaction.username = ?
        ${whereClause}
        ORDER BY n.is_pinned DESC, n.is_urgent DESC, n.created_at DESC, n.id DESC
      `
      ,
      [req.session.user.username, req.session.user.username]
    );

    const notificationIds = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
    let reactionCountRows = [];
    if (notificationIds.length) {
      const placeholders = notificationIds.map(() => "?").join(", ");
      reactionCountRows = await all(
        `
          SELECT notification_id, reaction, COUNT(*) AS total
          FROM notification_reactions
          WHERE notification_id IN (${placeholders})
          GROUP BY notification_id, reaction
        `,
        notificationIds
      );
    }
    const reactionsByNotification = new Map();
    reactionCountRows.forEach((row) => {
      const notificationId = Number(row.notification_id || 0);
      if (!reactionsByNotification.has(notificationId)) {
        reactionsByNotification.set(notificationId, {});
      }
      reactionsByNotification.get(notificationId)[String(row.reaction || "")] = Number(row.total || 0);
    });
    const rowsWithReactions = rows.map((row) => ({
      ...row,
      reaction_counts: reactionsByNotification.get(Number(row.id || 0)) || {},
    }));

    if (req.session.user.role !== "teacher" && req.session.user.role !== "admin") {
      return res.json(rowsWithReactions);
    }

    const unreadRows = await all(
      `
        SELECT
          n.id,
          (
            (SELECT COUNT(*) FROM auth_roster WHERE role = 'student')
            - COUNT(nr.username)
          ) AS unread_count
        FROM notifications n
        LEFT JOIN notification_reads nr
          ON nr.notification_id = n.id
         AND nr.username IN (SELECT auth_id FROM auth_roster WHERE role = 'student')
        GROUP BY n.id
      `
    );
    const unreadById = new Map(unreadRows.map((row) => [row.id, Number(row.unread_count || 0)]));
    let reactionDetailRows = [];
    if (notificationIds.length) {
      const placeholders = notificationIds.map(() => "?").join(", ");
      reactionDetailRows = await all(
        `
          SELECT
            notification_id,
            GROUP_CONCAT(username || '|' || reaction, ',') AS reaction_details
          FROM notification_reactions
          WHERE notification_id IN (${placeholders})
          GROUP BY notification_id
        `,
        notificationIds
      );
    }
    const reactionDetailsById = new Map(
      reactionDetailRows.map((row) => [Number(row.notification_id || 0), parseReactionDetails(row.reaction_details)])
    );

    const rowsWithCounts = rowsWithReactions.map((row) => ({
      ...row,
      unread_count: unreadById.has(row.id) ? unreadById.get(row.id) : 0,
      reaction_details: reactionDetailsById.get(Number(row.id || 0)) || [],
    }));
    return res.json(rowsWithCounts);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load notifications" });
  }
});

app.post("/api/notifications/:id/reaction", requireAuth, async (req, res) => {
  const id = parseResourceId(req.params.id);
  const rawReaction = String(req.body.reaction || "").trim().toLowerCase();
  if (!id) {
    return res.status(400).json({ error: "Invalid notification ID." });
  }
  if (rawReaction && !allowedNotificationReactions.has(rawReaction)) {
    return res.status(400).json({ error: "Invalid reaction." });
  }

  try {
    const row = await get(
      "SELECT id, auto_generated, related_payment_item_id FROM notifications WHERE id = ? LIMIT 1",
      [id]
    );
    if (!row) {
      return res.status(404).json({ error: "Notification not found." });
    }
    if (Number(row.auto_generated || 0) === 1 || Number(row.related_payment_item_id || 0) > 0) {
      return res.status(400).json({ error: "Payment item notifications cannot be reacted to." });
    }
    if (!rawReaction) {
      await run("DELETE FROM notification_reactions WHERE notification_id = ? AND username = ?", [
        id,
        req.session.user.username,
      ]);
      broadcastContentUpdate("notification", "reaction", {
        id,
        reaction: null,
      });
      return res.json({ ok: true, reaction: null });
    }
    await run(
      `
        INSERT INTO notification_reactions (notification_id, username, reaction, reacted_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(notification_id, username) DO UPDATE SET
          reaction = excluded.reaction,
          reacted_at = CURRENT_TIMESTAMP
      `,
      [id, req.session.user.username, rawReaction]
    );
    broadcastContentUpdate("notification", "reaction", {
      id,
      reaction: rawReaction,
    });
    return res.json({ ok: true, reaction: rawReaction });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save reaction." });
  }
});

app.post("/api/handouts/:id/reaction", requireAuth, async (req, res) => {
  const id = parseResourceId(req.params.id);
  const rawReaction = String(req.body.reaction || "").trim().toLowerCase();
  if (!id) {
    return res.status(400).json({ error: "Invalid handout ID." });
  }
  if (rawReaction && !allowedNotificationReactions.has(rawReaction)) {
    return res.status(400).json({ error: "Invalid reaction." });
  }
  try {
    const row = await get("SELECT id FROM handouts WHERE id = ? LIMIT 1", [id]);
    if (!row) {
      return res.status(404).json({ error: "Handout not found." });
    }
    if (!rawReaction) {
      await run("DELETE FROM handout_reactions WHERE handout_id = ? AND username = ?", [
        id,
        req.session.user.username,
      ]);
      return res.json({ ok: true, reaction: null });
    }
    await run(
      `
        INSERT INTO handout_reactions (handout_id, username, reaction, reacted_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(handout_id, username) DO UPDATE SET
          reaction = excluded.reaction,
          reacted_at = CURRENT_TIMESTAMP
      `,
      [id, req.session.user.username, rawReaction]
    );
    return res.json({ ok: true, reaction: rawReaction });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save reaction." });
  }
});

app.post("/api/shared-files/:id/reaction", requireAuth, async (req, res) => {
  const id = parseResourceId(req.params.id);
  const rawReaction = String(req.body.reaction || "").trim().toLowerCase();
  if (!id) {
    return res.status(400).json({ error: "Invalid shared file ID." });
  }
  if (rawReaction && !allowedNotificationReactions.has(rawReaction)) {
    return res.status(400).json({ error: "Invalid reaction." });
  }
  try {
    const row = await get("SELECT id FROM shared_files WHERE id = ? LIMIT 1", [id]);
    if (!row) {
      return res.status(404).json({ error: "Shared file not found." });
    }
    if (!rawReaction) {
      await run("DELETE FROM shared_file_reactions WHERE shared_file_id = ? AND username = ?", [
        id,
        req.session.user.username,
      ]);
      return res.json({ ok: true, reaction: null });
    }
    await run(
      `
        INSERT INTO shared_file_reactions (shared_file_id, username, reaction, reacted_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(shared_file_id, username) DO UPDATE SET
          reaction = excluded.reaction,
          reacted_at = CURRENT_TIMESTAMP
      `,
      [id, req.session.user.username, rawReaction]
    );
    return res.json({ ok: true, reaction: rawReaction });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save reaction." });
  }
});

app.post("/api/notifications", requireTeacher, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim();
  const category = String(req.body.category || "General").trim() || "General";
  const isUrgent = req.body.isUrgent ? 1 : 0;
  const isPinned = req.body.isPinned ? 1 : 0;

  if (!title || !body) {
    return res.status(400).json({ error: "Title and body are required." });
  }
  if (title.length > 120 || body.length > 2000 || category.length > 40) {
    return res.status(400).json({ error: "Notification field length is invalid." });
  }

  try {
    const result = await run(
      `
        INSERT INTO notifications (title, body, category, is_urgent, is_pinned, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [title, body, category, isUrgent, isPinned, req.session.user.username]
    );
    await logAuditEvent(
      req,
      "create",
      "notification",
      result.lastID,
      req.session.user.username,
      `Created notification "${title.slice(0, 80)}"`
    );
    broadcastContentUpdate("notification", "created", {
      id: Number(result.lastID || 0),
      created_by: req.session.user.username,
    });
    return res.status(201).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save notification." });
  }
});

app.put("/api/notifications/:id", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim();
  const category = String(req.body.category || "General").trim() || "General";
  const isUrgent = req.body.isUrgent ? 1 : 0;
  const isPinned = req.body.isPinned ? 1 : 0;

  if (!id) {
    return res.status(400).json({ error: "Invalid notification ID." });
  }
  if (!title || !body) {
    return res.status(400).json({ error: "Title and body are required." });
  }
  if (title.length > 120 || body.length > 2000 || category.length > 40) {
    return res.status(400).json({ error: "Notification field length is invalid." });
  }

  try {
    const access = await ensureCanManageContent(req, "notifications", id);
    if (access.error === "not_found") {
      return res.status(404).json({ error: "Notification not found." });
    }
    if (access.error === "forbidden") {
      return res.status(403).json({ error: "You can only edit your own notification." });
    }

    await run(
      `
        UPDATE notifications
        SET title = ?, body = ?, category = ?, is_urgent = ?, is_pinned = ?
        WHERE id = ?
      `,
      [title, body, category, isUrgent, isPinned, id]
    );
    await logAuditEvent(
      req,
      "edit",
      "notification",
      id,
      access.row.created_by,
      `Edited notification "${title.slice(0, 80)}"`
    );
    broadcastContentUpdate("notification", "updated", {
      id,
    });
    return res.status(200).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not update notification." });
  }
});

app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
  if (req.session.user.role !== "student") {
    return res.status(403).json({ error: "Only students can mark notifications as read." });
  }
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid notification ID." });
  }

  try {
    const row = await get("SELECT id FROM notifications WHERE id = ? LIMIT 1", [id]);
    if (!row) {
      return res.status(404).json({ error: "Notification not found." });
    }

    await run(
      `
        INSERT INTO notification_reads (notification_id, username)
        VALUES (?, ?)
        ON CONFLICT(notification_id, username) DO UPDATE SET
          read_at = CURRENT_TIMESTAMP
      `,
      [id, req.session.user.username]
    );

    broadcastContentUpdate("notification", "read", {
      id,
    });
    return res.status(200).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not mark notification as read." });
  }
});

app.delete("/api/notifications/:id", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid notification ID." });
  }

  try {
    const access = await ensureCanManageContent(req, "notifications", id);
    if (access.error === "not_found") {
      return res.status(404).json({ error: "Notification not found." });
    }
    if (access.error === "forbidden") {
      return res.status(403).json({ error: "You can only delete your own notification." });
    }

    await run("DELETE FROM notification_reactions WHERE notification_id = ?", [id]);
    await run("DELETE FROM notifications WHERE id = ?", [id]);
    await logAuditEvent(
      req,
      "delete",
      "notification",
      id,
      access.row.created_by,
      `Deleted notification "${String(access.row.title || "").slice(0, 80)}"`
    );
    broadcastContentUpdate("notification", "deleted", {
      id,
    });
    return res.status(200).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not delete notification." });
  }
});

app.get("/api/handouts", requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `
        SELECT id, title, description, file_url, created_by, created_at
        FROM handouts
        ORDER BY created_at DESC, id DESC
      `
    );
    const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) {
      return res.json(rows);
    }

    const placeholders = ids.map(() => "?").join(", ");
    const countRows = await all(
      `
        SELECT handout_id, reaction, COUNT(*) AS total
        FROM handout_reactions
        WHERE handout_id IN (${placeholders})
        GROUP BY handout_id, reaction
      `,
      ids
    );
    const userRows = await all(
      `
        SELECT handout_id, reaction
        FROM handout_reactions
        WHERE username = ? AND handout_id IN (${placeholders})
      `,
      [req.session.user.username, ...ids]
    );

    const countsById = new Map();
    countRows.forEach((row) => {
      const key = Number(row.handout_id || 0);
      if (!countsById.has(key)) {
        countsById.set(key, {});
      }
      countsById.get(key)[String(row.reaction || "")] = Number(row.total || 0);
    });
    const userById = new Map(userRows.map((row) => [Number(row.handout_id || 0), String(row.reaction || "")]));

    let detailsById = new Map();
    if (req.session.user.role === "teacher" || req.session.user.role === "admin") {
      const detailRows = await all(
        `
          SELECT
            handout_id,
            GROUP_CONCAT(username || '|' || reaction, ',') AS reaction_details
          FROM handout_reactions
          WHERE handout_id IN (${placeholders})
          GROUP BY handout_id
        `,
        ids
      );
      detailsById = new Map(
        detailRows.map((row) => [Number(row.handout_id || 0), parseReactionDetails(row.reaction_details)])
      );
    }

    return res.json(
      rows.map((row) => ({
        ...row,
        user_reaction: userById.get(Number(row.id || 0)) || null,
        reaction_counts: countsById.get(Number(row.id || 0)) || {},
        reaction_details: detailsById.get(Number(row.id || 0)) || [],
      }))
    );
  } catch (_err) {
    return res.status(500).json({ error: "Could not load handouts" });
  }
});

app.post("/api/handouts", requireTeacher, (req, res) => {
  handoutUpload.single("file")(req, res, async (err) => {
    if (err) {
      const message =
        err && err.message === "Only PDF, Word, and Excel files are allowed for handouts."
          ? err.message
          : err && err.code === "LIMIT_FILE_SIZE"
          ? "Handout file cannot be larger than 20 MB."
          : "Could not process handout upload.";
      return res.status(400).json({ error: message });
    }

    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    if (!title || !description) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(400).json({ error: "Title and description are required." });
    }
    if (title.length > 120 || description.length > 2000) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(400).json({ error: "Handout field length is invalid." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Please select a handout file to upload." });
    }

    const relativeUrl = `/content-files/handouts/${req.file.filename}`;
    try {
      const result = await run(
        `
          INSERT INTO handouts (title, description, file_url, created_by)
          VALUES (?, ?, ?, ?)
        `,
        [title, description, relativeUrl, req.session.user.username]
      );
      await logAuditEvent(
        req,
        "create",
        "handout",
        result.lastID,
        req.session.user.username,
        `Created handout "${title.slice(0, 80)}"`
      );
      broadcastContentUpdate("handout", "created", {
        id: Number(result.lastID || 0),
        created_by: req.session.user.username,
      });
      return res.status(201).json({ ok: true });
    } catch (_err) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(500).json({ error: "Could not save handout." });
    }
  });
});

app.put("/api/handouts/:id", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const fileUrl = String(req.body.fileUrl || "").trim();

  if (!id) {
    return res.status(400).json({ error: "Invalid handout ID." });
  }
  if (!title || !description) {
    return res.status(400).json({ error: "Title and description are required." });
  }
  if (title.length > 120 || description.length > 2000 || fileUrl.length > 500) {
    return res.status(400).json({ error: "Handout field length is invalid." });
  }
  if (fileUrl && !isValidHttpUrl(fileUrl) && !isValidLocalContentUrl(fileUrl)) {
    return res.status(400).json({ error: "File URL must start with http://, https://, or /content-files/." });
  }

  try {
    const access = await ensureCanManageContent(req, "handouts", id);
    if (access.error === "not_found") {
      return res.status(404).json({ error: "Handout not found." });
    }
    if (access.error === "forbidden") {
      return res.status(403).json({ error: "You can only edit your own handout." });
    }

    await run(
      `
        UPDATE handouts
        SET title = ?, description = ?, file_url = ?
        WHERE id = ?
      `,
      [title, description, fileUrl || null, id]
    );
    await logAuditEvent(
      req,
      "edit",
      "handout",
      id,
      access.row.created_by,
      `Edited handout "${title.slice(0, 80)}"`
    );
    broadcastContentUpdate("handout", "updated", {
      id,
    });
    return res.status(200).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not update handout." });
  }
});

app.delete("/api/handouts/:id", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid handout ID." });
  }

  try {
    const access = await ensureCanManageContent(req, "handouts", id);
    if (access.error === "not_found") {
      return res.status(404).json({ error: "Handout not found." });
    }
    if (access.error === "forbidden") {
      return res.status(403).json({ error: "You can only delete your own handout." });
    }

    await run("DELETE FROM handout_reactions WHERE handout_id = ?", [id]);
    await run("DELETE FROM handouts WHERE id = ?", [id]);
    removeStoredContentFile(access.row.file_url);
    await logAuditEvent(
      req,
      "delete",
      "handout",
      id,
      access.row.created_by,
      `Deleted handout "${String(access.row.title || "").slice(0, 80)}"`
    );
    broadcastContentUpdate("handout", "deleted", {
      id,
    });
    return res.status(200).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not delete handout." });
  }
});

app.post("/api/admin/import/students", requireAdmin, async (req, res) => {
  const csvText = String(req.body.csvText || "");
  if (!csvText.trim()) {
    return res.status(400).json({ error: "Student CSV is required." });
  }

  try {
    const result = await processRosterCsv(csvText, {
      role: "student",
      idHeader: "matric_number",
      sourceName: "admin-upload-students.csv",
      applyChanges: true,
    });
    return res.status(200).json({
      ok: true,
      imported: result.summary.imported,
      summary: result.summary,
      rows: result.rows,
      reportCsv: result.reportCsv,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Could not import student roster." });
  }
});

app.post("/api/admin/import/students/preview", requireAdmin, async (req, res) => {
  const csvText = String(req.body.csvText || "");
  if (!csvText.trim()) {
    return res.status(400).json({ error: "Student CSV is required." });
  }

  try {
    const result = await processRosterCsv(csvText, {
      role: "student",
      idHeader: "matric_number",
      sourceName: "admin-preview-students.csv",
      applyChanges: false,
    });
    return res.status(200).json({
      ok: true,
      summary: result.summary,
      rows: result.rows,
      reportCsv: result.reportCsv,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Could not preview student roster." });
  }
});

app.post(["/api/admin/import/lecturers", "/api/admin/import/teachers"], requireAdmin, async (req, res) => {
  const csvText = String(req.body.csvText || "");
  if (!csvText.trim()) {
    return res.status(400).json({ error: "Lecturer CSV is required." });
  }

  try {
    const result = await processRosterCsv(csvText, {
      role: "teacher",
      idHeader: "teacher_code",
      sourceName: "admin-upload-lecturers.csv",
      applyChanges: true,
    });
    return res.status(200).json({
      ok: true,
      imported: result.summary.imported,
      summary: result.summary,
      rows: result.rows,
      reportCsv: result.reportCsv,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Could not import lecturer roster." });
  }
});

app.post(
  ["/api/admin/import/lecturers/preview", "/api/admin/import/teachers/preview"],
  requireAdmin,
  async (req, res) => {
    const csvText = String(req.body.csvText || "");
    if (!csvText.trim()) {
      return res.status(400).json({ error: "Lecturer CSV is required." });
    }

    try {
      const result = await processRosterCsv(csvText, {
        role: "teacher",
        idHeader: "teacher_code",
        sourceName: "admin-preview-lecturers.csv",
        applyChanges: false,
      });
      return res.status(200).json({
        ok: true,
        summary: result.summary,
        rows: result.rows,
        reportCsv: result.reportCsv,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Could not preview lecturer roster." });
    }
  }
);

app.get("/api/shared-files", requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `
        SELECT id, title, description, file_url, created_by, created_at
        FROM shared_files
        ORDER BY created_at DESC, id DESC
      `
    );
    const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) {
      return res.json(rows);
    }

    const placeholders = ids.map(() => "?").join(", ");
    const countRows = await all(
      `
        SELECT shared_file_id, reaction, COUNT(*) AS total
        FROM shared_file_reactions
        WHERE shared_file_id IN (${placeholders})
        GROUP BY shared_file_id, reaction
      `,
      ids
    );
    const userRows = await all(
      `
        SELECT shared_file_id, reaction
        FROM shared_file_reactions
        WHERE username = ? AND shared_file_id IN (${placeholders})
      `,
      [req.session.user.username, ...ids]
    );

    const countsById = new Map();
    countRows.forEach((row) => {
      const key = Number(row.shared_file_id || 0);
      if (!countsById.has(key)) {
        countsById.set(key, {});
      }
      countsById.get(key)[String(row.reaction || "")] = Number(row.total || 0);
    });
    const userById = new Map(userRows.map((row) => [Number(row.shared_file_id || 0), String(row.reaction || "")]));

    let detailsById = new Map();
    if (req.session.user.role === "teacher" || req.session.user.role === "admin") {
      const detailRows = await all(
        `
          SELECT
            shared_file_id,
            GROUP_CONCAT(username || '|' || reaction, ',') AS reaction_details
          FROM shared_file_reactions
          WHERE shared_file_id IN (${placeholders})
          GROUP BY shared_file_id
        `,
        ids
      );
      detailsById = new Map(
        detailRows.map((row) => [Number(row.shared_file_id || 0), parseReactionDetails(row.reaction_details)])
      );
    }

    return res.json(
      rows.map((row) => ({
        ...row,
        user_reaction: userById.get(Number(row.id || 0)) || null,
        reaction_counts: countsById.get(Number(row.id || 0)) || {},
        reaction_details: detailsById.get(Number(row.id || 0)) || [],
      }))
    );
  } catch (_err) {
    return res.status(500).json({ error: "Could not load shared files" });
  }
});

app.post("/api/shared-files", requireTeacher, (req, res) => {
  sharedFileUpload.single("file")(req, res, async (err) => {
    if (err) {
      const message =
        err && err.message === "Only PNG images and MP4/WEBM/MOV videos are allowed for shared files."
          ? err.message
          : err && err.code === "LIMIT_FILE_SIZE"
          ? "Shared file cannot be larger than 50 MB."
          : "Could not process shared file upload.";
      return res.status(400).json({ error: message });
    }

    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    if (!title || !description) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(400).json({ error: "Title and description are required." });
    }
    if (title.length > 120 || description.length > 2000) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(400).json({ error: "Shared file field length is invalid." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Please select a shared file to upload." });
    }

    const relativeUrl = `/content-files/shared/${req.file.filename}`;
    try {
      const result = await run(
        `
          INSERT INTO shared_files (title, description, file_url, created_by)
          VALUES (?, ?, ?, ?)
        `,
        [title, description, relativeUrl, req.session.user.username]
      );
      await logAuditEvent(
        req,
        "create",
        "shared_file",
        result.lastID,
        req.session.user.username,
        `Created shared file "${title.slice(0, 80)}"`
      );
      broadcastContentUpdate("shared", "created", {
        id: Number(result.lastID || 0),
        created_by: req.session.user.username,
      });
      return res.status(201).json({ ok: true });
    } catch (_err) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(500).json({ error: "Could not save shared file." });
    }
  });
});

app.put("/api/shared-files/:id", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const fileUrl = String(req.body.fileUrl || "").trim();

  if (!id) {
    return res.status(400).json({ error: "Invalid shared file ID." });
  }
  if (!title || !description || !fileUrl) {
    return res.status(400).json({ error: "Title, description, and file URL are required." });
  }
  if (title.length > 120 || description.length > 2000 || fileUrl.length > 500) {
    return res.status(400).json({ error: "Shared file field length is invalid." });
  }
  if (!isValidHttpUrl(fileUrl) && !isValidLocalContentUrl(fileUrl)) {
    return res.status(400).json({ error: "File URL must start with http://, https://, or /content-files/." });
  }

  try {
    const access = await ensureCanManageContent(req, "shared_files", id);
    if (access.error === "not_found") {
      return res.status(404).json({ error: "Shared file not found." });
    }
    if (access.error === "forbidden") {
      return res.status(403).json({ error: "You can only edit your own shared file." });
    }

    await run(
      `
        UPDATE shared_files
        SET title = ?, description = ?, file_url = ?
        WHERE id = ?
      `,
      [title, description, fileUrl, id]
    );
    await logAuditEvent(
      req,
      "edit",
      "shared_file",
      id,
      access.row.created_by,
      `Edited shared file "${title.slice(0, 80)}"`
    );
    broadcastContentUpdate("shared", "updated", {
      id,
    });
    return res.status(200).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not update shared file." });
  }
});

app.delete("/api/shared-files/:id", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid shared file ID." });
  }

  try {
    const access = await ensureCanManageContent(req, "shared_files", id);
    if (access.error === "not_found") {
      return res.status(404).json({ error: "Shared file not found." });
    }
    if (access.error === "forbidden") {
      return res.status(403).json({ error: "You can only delete your own shared file." });
    }

    await run("DELETE FROM shared_file_reactions WHERE shared_file_id = ?", [id]);
    await run("DELETE FROM shared_files WHERE id = ?", [id]);
    removeStoredContentFile(access.row.file_url);
    await logAuditEvent(
      req,
      "delete",
      "shared_file",
      id,
      access.row.created_by,
      `Deleted shared file "${String(access.row.title || "").slice(0, 80)}"`
    );
    broadcastContentUpdate("shared", "deleted", {
      id,
    });
    return res.status(200).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not delete shared file." });
  }
});

app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/index.html", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/notifications.html", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "notifications.html"));
});

app.get("/handouts.html", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "handouts.html"));
});

app.get("/payments", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "payments.html"));
});

app.get("/payments.html", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "payments.html"));
});

app.get("/messages", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "messages.html"));
});

app.get("/analytics", requireTeacher, (req, res) => {
  res.sendFile(path.join(__dirname, "analytics.html"));
});

if (require.main === module) {
  initDatabase()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`CampusPay Hub server running on http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Failed to initialize database:", err);
      process.exit(1);
    });
}

module.exports = {
  app,
  initDatabase,
  db,
  run,
  get,
  all,
};
