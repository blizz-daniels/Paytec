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

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";
const defaultDataDir = isProduction ? "/tmp/paytec" : path.join(__dirname, "data");
const dataDir = path.resolve(process.env.DATA_DIR || defaultDataDir);
const dbPath = path.join(dataDir, "paytec.sqlite");
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STUDENT_ROSTER_PATH = path.resolve(process.env.STUDENT_ROSTER_PATH || path.join(__dirname, "data", "students.csv"));
const TEACHER_ROSTER_PATH = path.resolve(process.env.TEACHER_ROSTER_PATH || path.join(__dirname, "data", "teachers.csv"));

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
const execFileAsync = promisify(execFile);
const OCR_PROVIDER = String(process.env.OCR_PROVIDER || "none").trim().toLowerCase();
const OCR_SPACE_API_KEY = String(process.env.OCR_SPACE_API_KEY || "").trim();
const OCR_SPACE_ENDPOINT = String(process.env.OCR_SPACE_ENDPOINT || "https://api.ocr.space/parse/image").trim();
const STATEMENT_PARSER_PROVIDER = String(process.env.STATEMENT_PARSER_PROVIDER || "none").trim().toLowerCase();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_API_BASE_URL = String(process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/$/, "");
const OPENAI_STATEMENT_MODEL = String(process.env.OPENAI_STATEMENT_MODEL || "gpt-4o-mini").trim();

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
  const expectedToken = req.session ? req.session.csrfToken : "";
  const requestToken = req.get("x-csrf-token") || req.body?._csrf;
  if (!expectedToken || !requestToken || !isSameToken(expectedToken, requestToken)) {
    return rejectCsrf(req, res);
  }
  return next();
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
      SELECT display_name, nickname, profile_image_url
      FROM user_profiles
      WHERE username = ?
    `,
    [username]
  );
}

async function initDatabase() {
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

  await run("CREATE INDEX IF NOT EXISTS idx_payment_receipts_student ON payment_receipts(student_username)");
  await run("CREATE INDEX IF NOT EXISTS idx_payment_receipts_status ON payment_receipts(status)");
  await run("CREATE INDEX IF NOT EXISTS idx_payment_receipts_item ON payment_receipts(payment_item_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_payment_receipt_events_receipt ON payment_receipt_events(receipt_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_notifications_payment_item ON notifications(related_payment_item_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_notification_reactions_notification ON notification_reactions(notification_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_handout_reactions_handout ON handout_reactions(handout_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_shared_file_reactions_shared_file ON shared_file_reactions(shared_file_id)");

  await run(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      username TEXT PRIMARY KEY,
      display_name TEXT,
      nickname TEXT,
      profile_image_url TEXT,
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
  await importRoster(TEACHER_ROSTER_PATH, "teacher", "teacher_code");
}

if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

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
  if (isLikelyOcrFileExtension(ext)) {
    const ocrResult = await extractReceiptText(statementPath);
    extractedText = String(ocrResult?.text || "");
  } else {
    try {
      extractedText = await fs.promises.readFile(statementPath, "utf8");
    } catch (_err) {
      extractedText = "";
    }
  }
  let parsedRows = normalizeStatementRowsText(extractedText);
  if (!parsedRows.length) {
    parsedRows = parseStatementRowsFromLooseText(extractedText);
  }
  if (!parsedRows.length) {
    const aiRows = await parseStatementRowsWithAi(extractedText, { filename: originalFilename, extension: ext });
    if (aiRows.length) {
      parsedRows = aiRows;
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
        }
      }
    } catch (_err) {
      // Ignore fallback read errors.
    }
  }
  return {
    extractedText,
    parsedRows,
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
  let availabilityPart = "Available until removed by teacher.";
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
  try {
    const payload = JSON.parse(row.parsed_rows_json || "[]");
    if (Array.isArray(payload)) {
      parsedRows = payload;
    } else if (payload && Array.isArray(payload.parsed_rows)) {
      parsedRows = payload.parsed_rows;
      extractedText = String(payload.extracted_text || "");
    }
  } catch (_err) {
    parsedRows = [];
  }
  return {
    ...row,
    parsed_rows: Array.isArray(parsedRows) ? parsedRows : [],
    extracted_text: extractedText,
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
app.get("/teacher.html", (_req, res) => res.redirect("/teacher"));

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
      source = rosterUser.role === "teacher" ? "login-teacher" : "login-student";
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
      return res.redirect("/teacher");
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
    return res.json({
      username: req.session.user.username,
      role: req.session.user.role,
      displayName,
      profileImageUrl: profile ? profile.profile_image_url : null,
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load profile." });
  }
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
    const whereClause = isStudent
      ? "WHERE (pi.available_until IS NULL OR datetime(pi.available_until) > CURRENT_TIMESTAMP)"
      : "";
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
          pi.created_at
        FROM payment_items pi
        ${whereClause}
        ORDER BY pi.created_at DESC, pi.id DESC
      `
    );
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

app.get("/api/teacher/payment-statement", requireTeacher, async (req, res) => {
  try {
    const row = await getTeacherStatement(req.session.user.username);
    if (!row) {
      return res.json({ hasStatement: false });
    }
    return res.json({
      hasStatement: true,
      original_filename: row.original_filename,
      uploaded_at: row.uploaded_at,
      parsed_row_count: row.parsed_rows.length,
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load teacher statement." });
  }
});

app.post("/api/teacher/payment-statement", requireTeacher, (req, res) => {
  statementUpload.single("statementFile")(req, res, async (err) => {
    if (err) {
      const message =
        err &&
        err.message ===
          "Only CSV, TXT, TSV, JSON, XML, PDF, JPG, PNG, WEBP, XLS/XLSX, DOC/DOCX, and RTF statement files are allowed."
          ? err.message
          : err && err.code === "LIMIT_FILE_SIZE"
          ? "Statement file cannot be larger than 5 MB."
          : "Could not process statement upload.";
      return res.status(400).json({ error: message });
    }
    if (!req.file || !req.file.path) {
      return res.status(400).json({ error: "Statement file is required." });
    }
    try {
      const statementPath = path.resolve(req.file.path);
      const parsedResult = await parseStatementRowsFromUpload(statementPath, req.file.originalname || req.file.path);
      const parsedRows = parsedResult.parsedRows;
      const extractedText = parsedResult.extractedText;
      if (!parsedRows.length) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          error:
            "Could not parse statement rows. Use a clear statement file with name/description, amount, date, and transaction reference.",
        });
      }
      const teacherUsername = normalizeIdentifier(req.session.user.username);
      const existing = await get(
        "SELECT statement_file_path FROM teacher_payment_statements WHERE teacher_username = ? LIMIT 1",
        [teacherUsername]
      );
      await run(
        `
          INSERT INTO teacher_payment_statements (
            teacher_username,
            original_filename,
          statement_file_path,
          parsed_rows_json,
          uploaded_at
        )
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(teacher_username) DO UPDATE SET
            original_filename = excluded.original_filename,
            statement_file_path = excluded.statement_file_path,
            parsed_rows_json = excluded.parsed_rows_json,
            uploaded_at = CURRENT_TIMESTAMP
        `,
        [
          teacherUsername,
          String(req.file.originalname || "").slice(0, 255) || path.basename(req.file.path),
          statementPath,
          JSON.stringify({
            parsed_rows: parsedRows,
            extracted_text: extractedText.slice(0, 300000),
          }),
        ]
      );
      if (existing && existing.statement_file_path && existing.statement_file_path !== req.file.path) {
        fs.unlink(existing.statement_file_path, () => {});
      }
      await logAuditEvent(
        req,
        "upload",
        "payment_statement",
        null,
        teacherUsername,
        `Uploaded statement with ${parsedRows.length} parsed row(s).`
      );
      return res.status(201).json({
        ok: true,
        parsed_row_count: parsedRows.length,
      });
    } catch (_err) {
      return res.status(500).json({ error: "Could not save statement of account." });
    }
  });
});

app.delete("/api/teacher/payment-statement", requireTeacher, async (req, res) => {
  try {
    const teacherUsername = normalizeIdentifier(req.session.user.username);
    const row = await get(
      "SELECT statement_file_path FROM teacher_payment_statements WHERE teacher_username = ? LIMIT 1",
      [teacherUsername]
    );
    if (!row) {
      return res.status(404).json({ error: "No uploaded statement found." });
    }
    await run("DELETE FROM teacher_payment_statements WHERE teacher_username = ?", [teacherUsername]);
    if (row.statement_file_path) {
      fs.unlink(row.statement_file_path, () => {});
    }
    await logAuditEvent(req, "delete", "payment_statement", null, teacherUsername, "Deleted uploaded statement.");
    return res.json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not delete teacher statement." });
  }
});

app.post("/api/payment-receipts", requireStudent, (req, res) => {
  receiptUpload.single("receiptFile")(req, res, async (err) => {
    if (err) {
      const message =
        err && err.message === "Only JPG, PNG, WEBP, and PDF receipts are allowed."
          ? err.message
          : err && err.code === "LIMIT_FILE_SIZE"
          ? "Receipt file cannot be larger than 5 MB."
          : "Could not process receipt upload.";
      return res.status(400).json({ error: message });
    }

    const paymentItemId = parseResourceId(req.body.paymentItemId);
    const amountPaid = parseMoneyValue(req.body.amountPaid);
    const paidAt = String(req.body.paidAt || "").trim();
    const transactionRef = sanitizeTransactionRef(req.body.transactionRef || "");
    const note = String(req.body.note || "").trim().slice(0, 300);

    if (!paymentItemId) {
      return res.status(400).json({ error: "Payment item is required." });
    }
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      return res.status(400).json({ error: "Amount paid must be greater than zero." });
    }
    if (!paidAt || !isValidIsoLikeDate(paidAt)) {
      return res.status(400).json({ error: "Paid date is required and must be valid." });
    }
    if (!transactionRef || transactionRef.length < 4) {
      return res.status(400).json({ error: "Transaction reference must be at least 4 characters." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Receipt file is required." });
    }

    try {
      const paymentItem = await get("SELECT * FROM payment_items WHERE id = ? LIMIT 1", [paymentItemId]);
      if (!paymentItem) {
        return res.status(400).json({ error: "Selected payment item does not exist." });
      }

      const ocrResult = await extractReceiptText(req.file.path);
      const result = await run(
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
          VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?)
        `,
        [
          paymentItemId,
          req.session.user.username,
          amountPaid,
          paidAt,
          transactionRef,
          path.resolve(req.file.path),
          JSON.stringify({ student_note: note }),
          ocrResult && ocrResult.text ? String(ocrResult.text) : "",
        ]
      );

      const receiptRow = await get("SELECT * FROM payment_receipts WHERE id = ?", [result.lastID]);
      const flags = await buildVerificationFlags(receiptRow, paymentItem);
      const notesPayload = {
        student_note: note,
        verification_flags: flags,
      };
      await run("UPDATE payment_receipts SET verification_notes = ? WHERE id = ?", [
        JSON.stringify(notesPayload),
        result.lastID,
      ]);

      await logReceiptEvent(result.lastID, req, "submit", null, "submitted", note || null);
      await logAuditEvent(
        req,
        "create",
        "payment_receipt",
        result.lastID,
        req.session.user.username,
        `Submitted receipt for "${paymentItem.title}" with ref ${transactionRef}`
      );

      return res.status(201).json({ ok: true, id: result.lastID, verificationFlags: flags });
    } catch (submitErr) {
      if (req.file && req.file.path) {
        try {
          await fs.promises.unlink(req.file.path);
        } catch (_cleanupErr) {
          // Ignore cleanup failure.
        }
      }
      if (String(submitErr?.message || "").includes("UNIQUE constraint failed: payment_receipts.transaction_ref")) {
        return res.status(409).json({ error: "This transaction reference has already been submitted." });
      }
      return res.status(500).json({ error: "Could not submit payment receipt." });
    }
  });
});

app.get("/api/my/payment-receipts", requireAuth, async (req, res) => {
  if (req.session.user.role !== "student") {
    return res.status(403).json({ error: "Only students can view this resource." });
  }
  try {
    const rows = await all(
      `
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
          pi.title AS payment_item_title,
          pi.expected_amount,
          pi.currency,
          pi.due_date
        FROM payment_receipts pr
        JOIN payment_items pi ON pi.id = pr.payment_item_id
        WHERE pr.student_username = ?
        ORDER BY pr.submitted_at DESC, pr.id DESC
      `,
      [req.session.user.username]
    );
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load your receipt submissions." });
  }
});

app.get("/api/my/payment-ledger", requireStudent, async (req, res) => {
  try {
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
          COALESCE(SUM(CASE WHEN pr.status = 'approved' THEN pr.amount_paid ELSE 0 END), 0) AS approved_paid,
          COALESCE(SUM(CASE WHEN pr.status IN ('submitted', 'under_review') THEN pr.amount_paid ELSE 0 END), 0) AS pending_paid
        FROM payment_items pi
        LEFT JOIN payment_receipts pr
          ON pr.payment_item_id = pi.id
         AND pr.student_username = ?
        WHERE (pi.available_until IS NULL OR datetime(pi.available_until) > CURRENT_TIMESTAMP)
        GROUP BY
          pi.id,
          pi.title,
          pi.description,
          pi.expected_amount,
          pi.currency,
          pi.due_date,
          pi.available_until,
          pi.availability_days,
          pi.created_by
        ORDER BY
          CASE WHEN pi.due_date IS NULL OR pi.due_date = '' THEN 1 ELSE 0 END ASC,
          pi.due_date ASC,
          pi.id ASC
      `,
      [req.session.user.username]
    );

    const items = rows.map((row) => {
      const expectedAmount = Number(row.expected_amount || 0);
      const approvedPaid = Number(row.approved_paid || 0);
      const pendingPaid = Number(row.pending_paid || 0);
      const outstanding = Math.max(0, expectedAmount - approvedPaid);
      const daysUntilDue = getDaysUntilDue(row.due_date);
      const reminder = getReminderMetadata(daysUntilDue, outstanding);
      return {
        ...row,
        expected_amount: expectedAmount,
        approved_paid: approvedPaid,
        pending_paid: pendingPaid,
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

    return res.json({
      summary,
      nextDueItem,
      items,
      generatedAt: new Date().toISOString(),
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load student payment ledger." });
  }
});

app.get("/api/teacher/payment-receipts", requireTeacher, async (req, res) => {
  try {
    const filters = parseQueueFilters(req.query || {});
    const query = buildReceiptQueueQuery(filters, 100, {
      reviewerUsername: req.session.user.username,
    });
    const rows = await all(query.sql, query.params);
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const flags = await buildVerificationFlags(row, row);
        return {
          ...row,
          verification_flags: flags,
        };
      })
    );
    return res.json(enriched);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load payment receipt queue." });
  }
});

app.get("/api/admin/payment-receipts", requireAdmin, async (req, res) => {
  try {
    const filters = parseQueueFilters(req.query || {});
    const query = buildReceiptQueueQuery(filters, 250, {
      reviewerUsername: req.session.user.username,
    });
    const rows = await all(query.sql, query.params);
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const flags = await buildVerificationFlags(row, row);
        return {
          ...row,
          verification_flags: flags,
        };
      })
    );
    return res.json(enriched);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load admin payment receipt queue." });
  }
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
    throw { status: 400, error: "Assignee must be a valid teacher/admin account." };
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
    return res.json({ ok: true, receipt });
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    return res.status(500).json({ error: "Could not update payment receipt status." });
  }
}

app.post("/api/payment-receipts/:id/assign", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid receipt ID." });
  }
  try {
    const receipt = await assignReceiptReviewer(req, id, req.body?.assignee, req.body?.note);
    return res.json({ ok: true, receipt });
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    return res.status(500).json({ error: "Could not assign reviewer." });
  }
});

app.post("/api/payment-receipts/:id/notes", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid receipt ID." });
  }
  const note = String(req.body?.note || "").trim().slice(0, 500);
  if (!note) {
    return res.status(400).json({ error: "Note cannot be empty." });
  }
  try {
    const row = await get("SELECT id FROM payment_receipts WHERE id = ? LIMIT 1", [id]);
    if (!row) {
      return res.status(404).json({ error: "Receipt not found." });
    }
    await appendReviewerNoteEvent(id, req, note);
    return res.json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save reviewer note." });
  }
});

app.get("/api/payment-receipts/:id/notes", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid receipt ID." });
  }
  try {
    const row = await get("SELECT id FROM payment_receipts WHERE id = ? LIMIT 1", [id]);
    if (!row) {
      return res.status(404).json({ error: "Receipt not found." });
    }
    const notes = await all(
      `
        SELECT
          id,
          actor_username AS reviewer_username,
          notes AS note,
          created_at
        FROM payment_receipt_events
        WHERE receipt_id = ?
          AND action = 'review_note'
          AND notes IS NOT NULL
        ORDER BY created_at DESC, id DESC
      `,
      [id]
    );
    return res.json(notes);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load reviewer notes history." });
  }
});

app.post("/api/payment-receipts/bulk", requireTeacher, async (req, res) => {
  const action = sanitizeBulkReceiptAction(req.body?.action);
  const ids = parseReceiptIdList(req.body?.receiptIds, 100);
  if (!action) {
    return res.status(400).json({ error: "A valid bulk action is required." });
  }
  if (!ids.length) {
    return res.status(400).json({ error: "At least one receipt ID is required." });
  }

  const results = [];
  for (const id of ids) {
    try {
      if (action === "assign") {
        const receipt = await assignReceiptReviewer(req, id, req.body?.assignee, req.body?.note);
        results.push({ id, ok: true, receipt });
        continue;
      }
      if (action === "note") {
        const note = String(req.body?.note || "").trim().slice(0, 500);
        if (!note) {
          throw { status: 400, error: "Bulk note action requires a note." };
        }
        const row = await get("SELECT id FROM payment_receipts WHERE id = ? LIMIT 1", [id]);
        if (!row) {
          throw { status: 404, error: "Receipt not found." };
        }
        await appendReviewerNoteEvent(id, req, note);
        results.push({ id, ok: true });
        continue;
      }
      if (action === "bulk_verify") {
        const verification = await verifyReceiptAgainstStatementById(req, id, { bulk: true });
        results.push({ id, ok: true, receipt: verification.receipt, verification });
        continue;
      }

      const nextStatusByAction = {
        under_review: "under_review",
        approve: "approved",
        reject: "rejected",
      };
      const nextStatus = nextStatusByAction[action];
      const receipt = await transitionPaymentReceiptStatusById(req, id, nextStatus, action, {
        rejectionReason: req.body?.rejectionReason,
        reviewerNote: req.body?.note,
        defaultEventNote: action === "under_review" ? "Moved receipt to under review." : "",
      });
      results.push({ id, ok: true, receipt });
    } catch (err) {
      results.push({
        id,
        ok: false,
        error: err && err.error ? err.error : "Could not apply action.",
      });
    }
  }

  const successCount = results.filter((entry) => entry.ok).length;
  return res.json({
    ok: true,
    action,
    total: results.length,
    successCount,
    failureCount: results.length - successCount,
    results,
  });
});

app.post("/api/payment-receipts/:id/verify", requireTeacher, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid receipt ID." });
  }
  try {
    const verification = await verifyReceiptAgainstStatementById(req, id, { bulk: false });
    return res.json({ ok: true, ...verification });
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    return res.status(500).json({ error: "Could not verify receipt against statement." });
  }
});

app.post("/api/payment-receipts/:id/under-review", requireTeacher, async (req, res) => {
  return transitionPaymentReceiptStatus(req, res, "under_review", "move_under_review", {
    defaultEventNote: "Moved receipt to under review.",
  });
});

app.post("/api/payment-receipts/:id/approve", requireTeacher, async (req, res) => {
  return transitionPaymentReceiptStatus(req, res, "approved", "approve");
});

app.post("/api/payment-receipts/:id/reject", requireTeacher, async (req, res) => {
  return transitionPaymentReceiptStatus(req, res, "rejected", "reject");
});

app.get("/api/payment-receipts/:id/file", requireAuth, async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Invalid receipt ID." });
  }
  try {
    const row = await get(
      `
        SELECT id, student_username, receipt_file_path
        FROM payment_receipts
        WHERE id = ?
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
    const absolutePath = path.resolve(row.receipt_file_path);
    const relativeFromReceipts = path.relative(receiptsDir, absolutePath);
    const isInsideReceipts = relativeFromReceipts && !relativeFromReceipts.startsWith("..") && !path.isAbsolute(relativeFromReceipts);
    if (!isInsideReceipts || !fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: "Receipt file is missing." });
    }
    return res.sendFile(absolutePath);
  } catch (_err) {
    return res.status(500).json({ error: "Could not open receipt file." });
  }
});

app.get("/teacher", requireTeacher, (_req, res) => {
  res.sendFile(path.join(__dirname, "teacher.html"));
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

app.post("/api/admin/import/teachers", requireAdmin, async (req, res) => {
  const csvText = String(req.body.csvText || "");
  if (!csvText.trim()) {
    return res.status(400).json({ error: "Teacher CSV is required." });
  }

  try {
    const result = await processRosterCsv(csvText, {
      role: "teacher",
      idHeader: "teacher_code",
      sourceName: "admin-upload-teachers.csv",
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
    return res.status(400).json({ error: err.message || "Could not import teacher roster." });
  }
});

app.post("/api/admin/import/teachers/preview", requireAdmin, async (req, res) => {
  const csvText = String(req.body.csvText || "");
  if (!csvText.trim()) {
    return res.status(400).json({ error: "Teacher CSV is required." });
  }

  try {
    const result = await processRosterCsv(csvText, {
      role: "teacher",
      idHeader: "teacher_code",
      sourceName: "admin-preview-teachers.csv",
      applyChanges: false,
    });
    return res.status(200).json({
      ok: true,
      summary: result.summary,
      rows: result.rows,
      reportCsv: result.reportCsv,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Could not preview teacher roster." });
  }
});

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
