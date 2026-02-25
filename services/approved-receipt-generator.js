const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_EMAIL_SUBJECT = "Your Approved Student Receipt";
const DEFAULT_EMAIL_BODY = [
  "Dear {{full_name}},",
  "",
  "Your payment has been approved. Your receipt is attached to this email.",
  "",
  "Application ID: {{application_id}}",
  "Program: {{program}}",
  "Amount Paid: {{amount_paid}}",
  "Receipt No: {{receipt_no}}",
  "Approval Date: {{approval_date}}",
  "",
  "Regards,",
  "Accounts Office",
].join("\n");

const A4_WIDTH_POINTS = 595.28;
const A4_HEIGHT_POINTS = 841.89;
const TARGET_RENDER_DPI = 300;
const RECEIPT_RENDER_SCALE = 2;
const A4_WIDTH_INCHES = 210 / 25.4;
const A4_HEIGHT_INCHES = 297 / 25.4;
const RECEIPT_SNAPSHOT_WIDTH = Math.round((A4_WIDTH_INCHES * TARGET_RENDER_DPI) / RECEIPT_RENDER_SCALE);
const RECEIPT_SNAPSHOT_HEIGHT = Math.round((A4_HEIGHT_INCHES * TARGET_RENDER_DPI) / RECEIPT_RENDER_SCALE);
const LOG_COMPONENT = "approved-receipts";

const DEFAULT_PASSPORT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="390" height="480" viewBox="0 0 390 480">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#eff4f8"/>
      <stop offset="100%" stop-color="#dde6ee"/>
    </linearGradient>
  </defs>
  <rect width="390" height="480" fill="url(#bg)"/>
  <circle cx="195" cy="160" r="76" fill="#9eb1c4"/>
  <path d="M76 429c15-71 70-115 119-115s104 44 119 115" fill="#9eb1c4"/>
  <text x="50%" y="456" dominant-baseline="middle" text-anchor="middle" fill="#4f6478" font-family="Arial, sans-serif" font-size="26">
    Passport Photo
  </text>
</svg>
`.trim();

const DEFAULT_STAMP_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240">
  <defs>
    <linearGradient id="stampBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#b4d2ef" />
      <stop offset="100%" stop-color="#8db8df" />
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="344" height="224" rx="12" fill="url(#stampBg)" stroke="#5d8ebf" stroke-width="8"/>
  <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#1b4f7e" font-family="Arial, sans-serif" font-size="48" font-weight="700">
    OFFICIAL STAMP
  </text>
</svg>
`.trim();

const DEFAULT_FALLBACK_TEMPLATE_HTML = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Approved Payment Receipt</title>
</head>
<body>
  <main class="receipt-page">
    <h1>Approved Payment Receipt</h1>
    <p><strong>Student:</strong> {{full_name}}</p>
    <p><strong>Application ID:</strong> {{application_id}}</p>
    <p><strong>Program:</strong> {{program}}</p>
    <p><strong>Amount Paid:</strong> {{amount_paid}}</p>
    <p><strong>Receipt No:</strong> {{receipt_no}}</p>
    <p><strong>Approval Date:</strong> {{approval_date}}</p>
  </main>
</body>
</html>
`.trim();

const DEFAULT_FALLBACK_TEMPLATE_CSS = `
html, body { margin: 0; padding: 0; font-family: Arial, sans-serif; background: #ffffff; color: #111827; }
.receipt-page { width: 794px; min-height: 1123px; margin: 0 auto; padding: 48px; box-sizing: border-box; }
h1 { margin: 0 0 24px; font-size: 28px; }
p { margin: 0 0 12px; font-size: 15px; }
`.trim();

function requireOptionalPackage(name, installHint) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(name);
  } catch (err) {
    if (err && err.code === "MODULE_NOT_FOUND") {
      throw new Error(`Missing dependency "${name}". Install it with: ${installHint}`);
    }
    throw err;
  }
}

function ensureLogger(logger) {
  if (logger && typeof logger.info === "function" && typeof logger.warn === "function" && typeof logger.error === "function") {
    return logger;
  }
  return console;
}

function emitLog(logger, level, event, fields = {}) {
  const activeLogger = ensureLogger(logger);
  const method = typeof activeLogger[level] === "function" ? activeLogger[level] : activeLogger.info;
  method({
    component: LOG_COMPONENT,
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  });
}

function renderTemplate(template, values) {
  return String(template || "").replace(/{{\s*([\w.]+)\s*}}/g, (_match, key) => {
    const value = Object.prototype.hasOwnProperty.call(values || {}, key) ? values[key] : "";
    return value === null || value === undefined ? "" : String(value);
  });
}

function mergeTemplateAndCss(templateHtml, templateCss) {
  const html = String(templateHtml || "");
  const css = String(templateCss || "");
  if (!css) {
    return html;
  }
  if (html.includes("{{inline_css}}")) {
    return html.replace(/{{\s*inline_css\s*}}/g, css);
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", `<style>\n${css}\n</style>\n</head>`);
  }
  return `<style>\n${css}\n</style>\n${html}`;
}

function sanitizeFileSegment(value, fallback = "receipt") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function toIsoDateTime(input) {
  const date = input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function toDateStamp(input) {
  return toIsoDateTime(input).slice(0, 10);
}

function formatHumanDate(input) {
  const date = input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) {
    return toDateStamp(new Date());
  }
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function formatMoney(value, currency = "NGN") {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) {
    return "0.00";
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "NGN").toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch (_err) {
    return `${amount.toFixed(2)} ${String(currency || "").toUpperCase()}`.trim();
  }
}

function formatAmountNumber(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) {
    return "0.00";
  }
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildPlaceholderMap(row, overrides = {}) {
  const receiptId = Number(row.payment_receipt_id || row.id || 0);
  const applicationId = row.application_id || row.payment_reference || row.student_username || `PR-${receiptId}`;
  const approvalDateValue = row.reviewed_at || row.approved_at || row.submitted_at || new Date().toISOString();
  const currencyCode = String(row.currency || "NGN")
    .trim()
    .toUpperCase() || "NGN";
  const amountFormatted = formatMoney(row.amount_paid, currencyCode);
  return {
    full_name: row.full_name || row.display_name || row.student_username || "Student",
    application_id: applicationId,
    program: row.program || row.payment_item_title || "N/A",
    amount_paid: amountFormatted,
    amount_paid_words: amountFormatted,
    amount_paid_numeric: formatAmountNumber(row.amount_paid),
    currency_code: currencyCode,
    received_by: "Accounts Office",
    receipt_no: row.receipt_no || `RCP-${String(receiptId || "0").padStart(6, "0")}`,
    approval_date: formatHumanDate(approvalDateValue),
    passport_photo: row.passport_photo || createDefaultPassportDataUri(),
    sign_stamp: row.sign_stamp || createDefaultStampDataUri(),
    ...overrides,
  };
}

function encodeSvgToDataUri(svgText) {
  return `data:image/svg+xml;base64,${Buffer.from(String(svgText || ""), "utf8").toString("base64")}`;
}

function createDefaultPassportDataUri() {
  return encodeSvgToDataUri(DEFAULT_PASSPORT_SVG);
}

function createDefaultStampDataUri() {
  return encodeSvgToDataUri(DEFAULT_STAMP_SVG);
}

function guessImageMime(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function fileToDataUri(filePath) {
  const bytes = await fs.promises.readFile(filePath);
  const mime = guessImageMime(filePath);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function resolveProfileImageFile(profileImageUrl, dataDir) {
  const imageUrl = String(profileImageUrl || "").trim();
  if (!imageUrl) {
    return null;
  }
  if (/^https?:\/\//i.test(imageUrl) || /^data:/i.test(imageUrl)) {
    return imageUrl;
  }
  const normalized = imageUrl.replace(/\\/g, "/");
  if (normalized.startsWith("/users/")) {
    const fileName = path.basename(normalized);
    return path.join(dataDir, "users", fileName);
  }
  if (path.isAbsolute(imageUrl)) {
    return imageUrl;
  }
  return path.resolve(dataDir, imageUrl.replace(/^\/+/, ""));
}

async function resolvePassportPhotoValue(row, options) {
  const logger = ensureLogger(options.logger);
  const dataDir = path.resolve(options.dataDir || path.join(__dirname, "..", "data"));
  const imagePathOrUrl = resolveProfileImageFile(row.profile_image_url, dataDir);
  if (!imagePathOrUrl) {
    emitLog(logger, "warn", "passport_photo_fallback", {
      student_username: row.student_username,
      reason: "profile image missing",
    });
    return createDefaultPassportDataUri();
  }
  if (/^https?:\/\//i.test(imagePathOrUrl) || /^data:/i.test(imagePathOrUrl)) {
    return imagePathOrUrl;
  }
  try {
    await fs.promises.access(imagePathOrUrl, fs.constants.R_OK);
    return await fileToDataUri(imagePathOrUrl);
  } catch (_err) {
    emitLog(logger, "warn", "passport_photo_fallback", {
      student_username: row.student_username,
      reason: "profile image unreadable",
      image_path: imagePathOrUrl,
    });
    return createDefaultPassportDataUri();
  }
}

function looksLikeImageFile(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext);
}

async function resolveTemplateStampPath(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, ".."));
  const templateDir = path.resolve(options.templateDir || path.join(projectRoot, "templates"));
  const explicitInput = String(options.templateStampPath || process.env.RECEIPT_TEMPLATE_STAMP_PATH || "").trim();
  if (explicitInput) {
    const explicitPath = path.isAbsolute(explicitInput)
      ? explicitInput
      : path.resolve(templateDir, explicitInput);
    return explicitPath;
  }

  try {
    const entries = await fs.promises.readdir(templateDir, { withFileTypes: true });
    const stampCandidates = entries
      .filter((entry) => entry.isFile() && looksLikeImageFile(entry.name) && /stamp/i.test(entry.name))
      .map((entry) => path.resolve(templateDir, entry.name));
    if (stampCandidates.length) {
      return stampCandidates[0];
    }
  } catch (_err) {
    // Ignore; caller will fallback.
  }
  return null;
}

async function resolveSignStampValue(options = {}) {
  const logger = ensureLogger(options.logger);
  const stampPath = await resolveTemplateStampPath(options);
  if (!stampPath) {
    emitLog(logger, "warn", "sign_stamp_fallback", {
      reason: "template stamp file not found",
    });
    return createDefaultStampDataUri();
  }
  if (/^https?:\/\//i.test(stampPath) || /^data:/i.test(stampPath)) {
    return stampPath;
  }
  try {
    await fs.promises.access(stampPath, fs.constants.R_OK);
    return await fileToDataUri(stampPath);
  } catch (_err) {
    emitLog(logger, "warn", "sign_stamp_fallback", {
      reason: "template stamp file unreadable",
      stamp_path: stampPath,
    });
    return createDefaultStampDataUri();
  }
}

function trimErrorMessage(err) {
  const raw = String(err && err.message ? err.message : err || "Unknown error");
  return raw.length > 800 ? `${raw.slice(0, 797)}...` : raw;
}

function isTransientEmailError(err) {
  const code = String(err && err.code ? err.code : "").toUpperCase();
  const transientCodes = new Set([
    "ETIMEDOUT",
    "ECONNECTION",
    "ECONNRESET",
    "EAI_AGAIN",
    "ESOCKET",
    "EMESSAGE",
    "EPROTOCOL",
  ]);
  if (transientCodes.has(code)) {
    return true;
  }
  const responseCode = Number(err && err.responseCode);
  return Number.isFinite(responseCode) && responseCode >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEmailWithRetry({ sendEmail, payload, retryCount, retryDelayMs, logger }) {
  const maxAttempts = Math.max(1, Number.parseInt(String(retryCount || 3), 10) || 3);
  const baseDelayMs = Math.max(100, Number.parseInt(String(retryDelayMs || 1500), 10) || 1500);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await sendEmail(payload);
      return;
    } catch (err) {
      const retryable = isTransientEmailError(err);
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      emitLog(logger, "warn", "send_retry", {
        email_to: payload.to,
        attempt,
        max_attempts: maxAttempts,
        reason: trimErrorMessage(err),
      });
      await wait(baseDelayMs * attempt);
    }
  }
}

async function ensureDispatchTable(db) {
  await db.run(`
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
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_approved_receipt_dispatches_sent ON approved_receipt_dispatches(receipt_sent)"
  );
  await db.run(
    "CREATE INDEX IF NOT EXISTS idx_approved_receipt_dispatches_receipt ON approved_receipt_dispatches(payment_receipt_id)"
  );
}

async function readTemplateParts(options) {
  const projectRoot = path.resolve(__dirname, "..");
  const htmlPath = path.resolve(
    options.templateHtmlPath || path.join(projectRoot, "templates", "approved-student-receipt.html")
  );
  const cssPath = path.resolve(options.templateCssPath || path.join(projectRoot, "templates", "approved-student-receipt.css"));
  let html = options.templateHtml || "";
  if (!html) {
    try {
      html = await fs.promises.readFile(htmlPath, "utf8");
    } catch (_err) {
      html = DEFAULT_FALLBACK_TEMPLATE_HTML;
    }
  }
  let css = options.templateCss || "";
  if (!css) {
    try {
      css = await fs.promises.readFile(cssPath, "utf8");
    } catch (_err) {
      css = DEFAULT_FALLBACK_TEMPLATE_CSS;
    }
  }
  return {
    html,
    css,
    htmlPath,
    cssPath,
  };
}

async function fetchEligibleApprovedRows(db, { force, limit, paymentReceiptId }) {
  const limitValue = Number.isFinite(Number(limit)) ? Number(limit) : 0;
  const receiptIdValue = Number.parseInt(String(paymentReceiptId || ""), 10);
  const params = [];
  let sql = `
    SELECT
      pr.id AS payment_receipt_id,
      pr.student_username,
      pr.amount_paid,
      pr.reviewed_at,
      pr.submitted_at,
      pr.transaction_ref,
      pi.title AS payment_item_title,
      pi.currency,
      po.payment_reference AS application_id,
      up.display_name,
      up.email,
      up.profile_image_url,
      COALESCE(ard.receipt_sent, 0) AS receipt_sent
    FROM payment_receipts pr
    LEFT JOIN payment_items pi ON pi.id = pr.payment_item_id
    LEFT JOIN payment_obligations po
      ON po.payment_item_id = pr.payment_item_id
      AND po.student_username = pr.student_username
    LEFT JOIN user_profiles up ON up.username = pr.student_username
    LEFT JOIN approved_receipt_dispatches ard ON ard.payment_receipt_id = pr.id
    WHERE pr.status = 'approved'
  `;
  if (Number.isFinite(receiptIdValue) && receiptIdValue > 0) {
    sql += " AND pr.id = ?";
    params.push(receiptIdValue);
  }
  if (!force) {
    sql += " AND (COALESCE(ard.receipt_sent, 0) = 0 OR COALESCE(ard.receipt_file_path, '') = '')";
  }
  sql += " ORDER BY pr.id ASC";
  if (limitValue > 0) {
    sql += " LIMIT ?";
    params.push(limitValue);
  }
  return db.all(sql, params);
}

async function incrementDispatchAttempt(db, row) {
  await db.run(
    `
      INSERT INTO approved_receipt_dispatches (
        payment_receipt_id,
        student_username,
        receipt_sent,
        attempt_count,
        updated_at
      )
      VALUES (?, ?, 0, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(payment_receipt_id) DO UPDATE SET
        student_username = excluded.student_username,
        attempt_count = approved_receipt_dispatches.attempt_count + 1,
        updated_at = CURRENT_TIMESTAMP
    `,
    [row.payment_receipt_id, row.student_username]
  );
}

async function markGenerated(db, paymentReceiptId, generatedAtIso, outputPdfPath) {
  await db.run(
    `
      UPDATE approved_receipt_dispatches
      SET receipt_generated_at = ?,
          receipt_file_path = ?,
          updated_at = CURRENT_TIMESTAMP,
          last_error = NULL
      WHERE payment_receipt_id = ?
    `,
    [generatedAtIso, outputPdfPath, paymentReceiptId]
  );
}

async function markSent(db, paymentReceiptId, sentAtIso) {
  await db.run(
    `
      UPDATE approved_receipt_dispatches
      SET receipt_sent = 1,
          receipt_sent_at = ?,
          updated_at = CURRENT_TIMESTAMP,
          last_error = NULL
      WHERE payment_receipt_id = ?
    `,
    [sentAtIso, paymentReceiptId]
  );
}

async function markFailed(db, paymentReceiptId, errorMessage, options = {}) {
  const preserveSentState = Boolean(options.preserveSentState);
  await db.run(
    `
      UPDATE approved_receipt_dispatches
      SET receipt_sent = CASE WHEN ? = 1 THEN receipt_sent ELSE 0 END,
          updated_at = CURRENT_TIMESTAMP,
          last_error = ?
      WHERE payment_receipt_id = ?
    `,
    [preserveSentState ? 1 : 0, errorMessage, paymentReceiptId]
  );
}

function escapePdfText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildSimpleReceiptPdfBuffer(lines) {
  const safeLines = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 28);
  if (!safeLines.length) {
    safeLines.push("Approved Payment Receipt");
  }

  const content = ["BT", "/F1 14 Tf", "50 790 Td"];
  safeLines.forEach((line, index) => {
    const escaped = escapePdfText(line);
    if (index === 0) {
      content.push(`(${escaped}) Tj`);
    } else {
      content.push(`0 -20 Td (${escaped}) Tj`);
    }
  });
  content.push("ET");
  const stream = content.join("\n");
  const streamLength = Buffer.byteLength(stream, "utf8");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const objectBody of objects) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += objectBody;
  }

  const xrefStart = Buffer.byteLength(output, "utf8");
  output += "xref\n0 6\n";
  output += "0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) {
    output += `${String(offsets[i] || 0).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(output, "utf8");
}

function buildFallbackReceiptLines(row, placeholders) {
  return [
    "Approved Payment Receipt",
    `Student: ${placeholders?.full_name || row?.student_username || "Student"}`,
    `Application ID: ${placeholders?.application_id || row?.payment_reference || row?.student_username || "-"}`,
    `Program: ${placeholders?.program || row?.payment_item_title || "-"}`,
    `Amount Paid: ${placeholders?.amount_paid || formatMoney(row?.amount_paid, row?.currency || "NGN")}`,
    `Receipt No: ${placeholders?.receipt_no || row?.payment_receipt_id || row?.id || "-"}`,
    `Approval Date: ${placeholders?.approval_date || formatHumanDate(row?.reviewed_at || row?.submitted_at || new Date())}`,
    `Generated: ${formatHumanDate(new Date())}`,
  ];
}

function parseDataUriImage(input) {
  const raw = String(input || "").trim();
  const match = /^data:(image\/(?:png|jpe?g));base64,([a-z0-9+/=\s]+)$/i.exec(raw);
  if (!match) {
    return null;
  }
  try {
    return {
      mime: String(match[1] || "").toLowerCase(),
      bytes: Buffer.from(String(match[2] || "").replace(/\s+/g, ""), "base64"),
    };
  } catch (_err) {
    return null;
  }
}

function rgbFromHex(hex, rgb) {
  const normalized = String(hex || "")
    .trim()
    .replace(/^#/, "");
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return rgb(0.1, 0.2, 0.3);
  }
  const int = Number.parseInt(normalized, 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  return rgb(r, g, b);
}

function clampText(value, maxLength) {
  const str = String(value || "").trim();
  if (!str) {
    return "-";
  }
  const limit = Number.isFinite(Number(maxLength)) ? Number(maxLength) : 64;
  if (str.length <= limit) {
    return str;
  }
  return `${str.slice(0, Math.max(0, limit - 3))}...`;
}

async function buildStyledFallbackReceiptPdfBuffer(row, placeholders) {
  const { PDFDocument, StandardFonts, rgb } = requireOptionalPackage("pdf-lib", "npm install pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([A4_WIDTH_POINTS, A4_HEIGHT_POINTS]);
  const width = page.getWidth();
  const height = page.getHeight();
  const frameX = 14;
  const frameY = 28;
  const frameW = width - frameX * 2;
  const frameH = height - frameY * 2;
  const contentX = frameX + 8;
  const contentW = frameW - 16;
  const contentRight = contentX + contentW;
  const rightColumnW = 106;
  const rightColumnX = contentRight - rightColumnW;
  const topY = frameY + frameH - 12;
  const footerY = frameY + 18;
  const footerH = 86;
  const receivedByBottomY = footerY + footerH + 22;
  const paymentBottomY = receivedByBottomY + 48;
  const amountBottomY = paymentBottomY + 142;
  const receivedBottomY = amountBottomY + 118;
  const headerBottomY = receivedBottomY + 46;

  const colorPageBg = rgbFromHex("e5e5e5", rgb);
  const colorPaper = rgbFromHex("ffffff", rgb);
  const colorFrame = rgbFromHex("111111", rgb);
  const colorLine = rgbFromHex("6a99cb", rgb);
  const colorAmountBg = rgbFromHex("c9daee", rgb);
  const colorFooter = rgbFromHex("5f93ce", rgb);
  const colorText = rgbFromHex("111111", rgb);
  const colorTextBlue = rgbFromHex("255f8e", rgb);
  const colorFooterTitle = rgbFromHex("f4ec5f", rgb);
  const colorFooterText = rgbFromHex("ffffff", rgb);

  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height,
    color: colorPageBg,
  });

  page.drawRectangle({
    x: frameX,
    y: frameY,
    width: frameW,
    height: frameH,
    color: colorPaper,
    borderColor: colorFrame,
    borderWidth: 2.2,
  });

  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const drawWrappedText = (text, x, yTop, maxWidth, font, size, color, lineGap = 1.2, maxLines = 3) => {
    const words = String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) {
      return yTop;
    }
    const lines = [];
    let current = "";
    words.forEach((word) => {
      const attempt = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(attempt, size) <= maxWidth || !current) {
        current = attempt;
        return;
      }
      lines.push(current);
      current = word;
    });
    if (current) {
      lines.push(current);
    }
    const printable = lines.slice(0, maxLines);
    let y = yTop;
    printable.forEach((line) => {
      page.drawText(line, { x, y, size, font, color });
      y -= size * lineGap;
    });
    return y;
  };

  // Row guides.
  [headerBottomY, receivedBottomY, amountBottomY, paymentBottomY, receivedByBottomY].forEach((y) => {
    page.drawLine({
      start: { x: contentX, y },
      end: { x: contentRight, y },
      thickness: 1.6,
      color: colorLine,
    });
  });

  // Header with student photo top-left.
  const photoW = 84;
  const photoH = 104;
  const photoX = contentX + 2;
  const photoY = topY - photoH - 4;
  page.drawRectangle({
    x: photoX,
    y: photoY,
    width: photoW,
    height: photoH,
    borderColor: colorLine,
    borderWidth: 1.5,
    color: rgbFromHex("f4f8fd", rgb),
  });

  const parsedPhoto = parseDataUriImage(placeholders?.passport_photo);
  if (parsedPhoto) {
    try {
      const embedded =
        parsedPhoto.mime === "image/png"
          ? await doc.embedPng(parsedPhoto.bytes)
          : await doc.embedJpg(parsedPhoto.bytes);
      page.drawImage(embedded, {
        x: photoX + 2,
        y: photoY + 2,
        width: photoW - 4,
        height: photoH - 4,
      });
    } catch (_err) {
      page.drawText("PHOTO", {
        x: photoX + 20,
        y: photoY + 45,
        size: 11,
        font: fontBold,
        color: colorTextBlue,
      });
    }
  } else {
    page.drawText("PHOTO", {
      x: photoX + 20,
      y: photoY + 45,
      size: 11,
      font: fontBold,
      color: colorTextBlue,
    });
  }

  const titleX = photoX + photoW + 12;
  page.drawText("PAYMENT RECEIPT", {
    x: titleX,
    y: topY - 38,
    size: 28,
    font: fontBold,
    color: colorText,
  });

  const metaX = rightColumnX - 104;
  const metaW = contentRight - metaX;
  page.drawText("No", {
    x: metaX + 2,
    y: topY - 24,
    size: 11,
    font: fontBold,
    color: colorText,
  });
  page.drawText(":", {
    x: metaX + 84,
    y: topY - 24,
    size: 11,
    font: fontBold,
    color: colorText,
  });
  page.drawText(clampText(placeholders?.receipt_no, 22), {
    x: metaX + 94,
    y: topY - 24,
    size: 11,
    font: fontBold,
    color: colorText,
  });
  page.drawLine({
    start: { x: metaX, y: topY - 30 },
    end: { x: metaX + metaW, y: topY - 30 },
    thickness: 1.6,
    color: colorLine,
  });
  page.drawText("Date", {
    x: metaX + 2,
    y: topY - 52,
    size: 11,
    font: fontBold,
    color: colorText,
  });
  page.drawText(":", {
    x: metaX + 84,
    y: topY - 52,
    size: 11,
    font: fontBold,
    color: colorText,
  });
  page.drawText(clampText(placeholders?.approval_date, 22), {
    x: metaX + 94,
    y: topY - 52,
    size: 11,
    font: fontBold,
    color: colorText,
  });
  page.drawLine({
    start: { x: metaX, y: topY - 58 },
    end: { x: metaX + metaW, y: topY - 58 },
    thickness: 1.6,
    color: colorLine,
  });

  // Main labels and values.
  const labelX = contentX + 2;
  const sepX = contentX + 98;
  const valueX = contentX + 108;
  page.drawText("Received From", {
    x: labelX,
    y: headerBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });
  page.drawText(":", {
    x: sepX,
    y: headerBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });
  page.drawText(clampText(placeholders?.full_name || row?.student_username || "Student", 38), {
    x: valueX,
    y: headerBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });

  page.drawText("Amount", {
    x: labelX,
    y: receivedBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });
  page.drawText(":", {
    x: sepX,
    y: receivedBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });
  drawWrappedText(
    placeholders?.amount_paid_words || placeholders?.amount_paid || formatMoney(row?.amount_paid, row?.currency || "NGN"),
    valueX,
    receivedBottomY - 30,
    rightColumnX - valueX - 8,
    fontBold,
    11,
    colorTextBlue,
    1.35,
    3
  );

  page.drawText("Payment For", {
    x: labelX,
    y: amountBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });
  page.drawText(":", {
    x: sepX,
    y: amountBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });
  const programY = drawWrappedText(
    placeholders?.program || row?.payment_item_title || "N/A",
    valueX,
    amountBottomY - 30,
    rightColumnX - valueX - 8,
    fontBold,
    11.5,
    colorText,
    1.35,
    3
  );
  page.drawText(
    `Application ID: ${clampText(placeholders?.application_id || row?.payment_reference || row?.student_username || "-", 34)}`,
    {
      x: valueX,
      y: Math.max(paymentBottomY + 12, programY - 8),
      size: 9.8,
      font: fontRegular,
      color: colorTextBlue,
    }
  );

  page.drawText("Received By", {
    x: labelX,
    y: paymentBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });
  page.drawText(":", {
    x: sepX,
    y: paymentBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });
  page.drawText(clampText(placeholders?.received_by || "Accounts Office", 28), {
    x: valueX,
    y: paymentBottomY - 30,
    size: 12.5,
    font: fontBold,
    color: colorText,
  });

  // Amount and sign boxes.
  page.drawRectangle({
    x: rightColumnX,
    y: amountBottomY,
    width: rightColumnW,
    height: receivedBottomY - amountBottomY,
    borderColor: colorLine,
    borderWidth: 1.6,
    color: colorAmountBg,
  });
  page.drawText(clampText(placeholders?.currency_code || String(row?.currency || "NGN").toUpperCase(), 8), {
    x: rightColumnX + 6,
    y: amountBottomY + (receivedBottomY - amountBottomY) / 2 - 6,
    size: 13,
    font: fontBold,
    color: colorText,
  });
  page.drawText(
    clampText(placeholders?.amount_paid_numeric || formatAmountNumber(row?.amount_paid), 16),
    {
      x: rightColumnX + 36,
      y: amountBottomY + (receivedBottomY - amountBottomY) / 2 - 6,
      size: 15,
      font: fontBold,
      color: colorText,
    }
  );

  page.drawRectangle({
    x: rightColumnX,
    y: receivedByBottomY,
    width: rightColumnW,
    height: amountBottomY - receivedByBottomY,
    borderColor: colorLine,
    borderWidth: 1.6,
    color: colorPaper,
  });

  const parsedStamp = parseDataUriImage(placeholders?.sign_stamp);
  if (parsedStamp) {
    try {
      const embedded =
        parsedStamp.mime === "image/png"
          ? await doc.embedPng(parsedStamp.bytes)
          : await doc.embedJpg(parsedStamp.bytes);
      page.drawImage(embedded, {
        x: rightColumnX + 6,
        y: receivedByBottomY + 24,
        width: rightColumnW - 12,
        height: amountBottomY - receivedByBottomY - 36,
      });
    } catch (_err) {
      page.drawText("STAMP", {
        x: rightColumnX + 28,
        y: receivedByBottomY + 62,
        size: 11,
        font: fontBold,
        color: colorTextBlue,
      });
    }
  } else {
    page.drawText("STAMP", {
      x: rightColumnX + 28,
      y: receivedByBottomY + 62,
      size: 11,
      font: fontBold,
      color: colorTextBlue,
    });
  }
  page.drawText("Sign", {
    x: rightColumnX + 34,
    y: receivedByBottomY + 8,
    size: 10.5,
    font: fontBold,
    color: colorText,
  });

  // Footer.
  page.drawRectangle({
    x: contentX,
    y: footerY,
    width: contentW,
    height: footerH,
    color: colorFooter,
  });
  const footerTitle = "PAYTEC";
  const footerTitleWidth = fontBold.widthOfTextAtSize(footerTitle, 20);
  page.drawText(footerTitle, {
    x: contentX + (contentW - footerTitleWidth) / 2,
    y: footerY + 52,
    size: 20,
    font: fontBold,
    color: colorFooterTitle,
  });
  const footerText = "Digital payment receipt generated by the Paytec approved receipt service.";
  const footerTextWidth = fontBold.widthOfTextAtSize(footerText, 9.6);
  page.drawText(footerText, {
    x: contentX + Math.max(8, (contentW - footerTextWidth) / 2),
    y: footerY + 30,
    size: 9.6,
    font: fontBold,
    color: colorFooterText,
  });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

async function renderHtmlToImagePdf({ html, outputPdfPath, row, placeholders }) {
  let browser = null;
  const renderFailures = [];
  try {
    const puppeteer = requireOptionalPackage("puppeteer", "npm install puppeteer");
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.RECEIPT_BROWSER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage({
      viewport: {
        width: RECEIPT_SNAPSHOT_WIDTH,
        height: RECEIPT_SNAPSHOT_HEIGHT,
        deviceScaleFactor: RECEIPT_RENDER_SCALE,
      },
    });
    await page.setContent(html, { waitUntil: "networkidle0" });

    // First choice: native browser PDF keeps template styles and is lighter on memory.
    try {
      await page.pdf({
        path: outputPdfPath,
        width: "210mm",
        height: "297mm",
        printBackground: true,
        preferCSSPageSize: true,
        margin: {
          top: "0",
          right: "0",
          bottom: "0",
          left: "0",
        },
      });
      return { method: "puppeteer_pdf", usedFallback: false };
    } catch (pdfErr) {
      renderFailures.push(`page.pdf failed: ${trimErrorMessage(pdfErr)}`);
    }

    // Secondary choice: screenshot + pdf-lib wrapper.
    try {
      const { PDFDocument } = requireOptionalPackage("pdf-lib", "npm install pdf-lib");
      const receiptElement = await page.$(".receipt-page");
      const pngBuffer = receiptElement
        ? await receiptElement.screenshot({ type: "png" })
        : await page.screenshot({ type: "png", fullPage: true });
      const pdfDoc = await PDFDocument.create();
      const embeddedPng = await pdfDoc.embedPng(pngBuffer);
      const pdfPage = pdfDoc.addPage([A4_WIDTH_POINTS, A4_HEIGHT_POINTS]);
      pdfPage.drawImage(embeddedPng, {
        x: 0,
        y: 0,
        width: A4_WIDTH_POINTS,
        height: A4_HEIGHT_POINTS,
      });
      const pdfBytes = await pdfDoc.save();
      await fs.promises.writeFile(outputPdfPath, Buffer.from(pdfBytes));
      return { method: "screenshot_pdf_lib", usedFallback: false };
    } catch (screenshotErr) {
      renderFailures.push(`screenshot/pdf-lib failed: ${trimErrorMessage(screenshotErr)}`);
      throw new Error(renderFailures.join(" | "));
    }
  } catch (err) {
    const primaryError = trimErrorMessage(err);
    try {
      const styledFallbackPdf = await buildStyledFallbackReceiptPdfBuffer(row, placeholders);
      await fs.promises.writeFile(outputPdfPath, styledFallbackPdf);
      console.warn(
        `[approved-receipts] styled fallback used for ${path.basename(outputPdfPath)}: ${primaryError}`
      );
      return {
        method: "styled_pdf_lib_fallback",
        usedFallback: true,
        warning: primaryError,
      };
    } catch (fallbackErr) {
      const fallbackLines = buildFallbackReceiptLines(row, placeholders);
      const fallbackPdf = buildSimpleReceiptPdfBuffer(fallbackLines);
      await fs.promises.writeFile(outputPdfPath, fallbackPdf);
      const fallbackMessage = `${primaryError} | fallback failure: ${trimErrorMessage(fallbackErr)}`;
      console.warn(
        `[approved-receipts] renderer fallback used for ${path.basename(outputPdfPath)}: ${fallbackMessage}`
      );
      return {
        method: "built_in_fallback",
        usedFallback: true,
        warning: fallbackMessage,
      };
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_err) {
        // Ignore close failures.
      }
    }
  }
}

async function generateApprovedStudentReceipts(options = {}) {
  const db = options.db;
  if (!db || typeof db.run !== "function" || typeof db.all !== "function") {
    throw new Error("A database client with run/get/all methods is required.");
  }

  const deliveryModeRaw = String(options.deliveryMode || "").trim().toLowerCase();
  const hasEmailSender = typeof options.sendEmail === "function";
  const deliveryMode = deliveryModeRaw || (hasEmailSender ? "email" : "download");
  if (deliveryMode !== "email" && deliveryMode !== "download") {
    throw new Error("options.deliveryMode must be either 'email' or 'download'.");
  }
  if (deliveryMode === "email" && !hasEmailSender) {
    throw new Error("options.sendEmail is required when deliveryMode='email'.");
  }

  const logger = ensureLogger(options.logger);
  const nowProvider = typeof options.nowProvider === "function" ? options.nowProvider : () => new Date();
  const requestedOutputDir = path.resolve(options.outputDir || path.join(__dirname, "..", "outputs", "receipts"));
  const force = Boolean(options.force);
  const retryCount = Number.parseInt(String(options.retryCount || 3), 10) || 3;
  const retryDelayMs = Number.parseInt(String(options.retryDelayMs || 1500), 10) || 1500;
  const renderPdf = options.renderPdf || renderHtmlToImagePdf;

  await ensureDispatchTable(db);
  const tableRow = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payment_receipts'");
  if (!tableRow) {
    throw new Error("payment_receipts table was not found. Initialize the application database first.");
  }

  const { html, css, htmlPath, cssPath } = await readTemplateParts(options);
  const template = mergeTemplateAndCss(html, css);
  const signStampDataUri = await resolveSignStampValue({
    logger,
    templateStampPath: options.templateStampPath,
    projectRoot: path.resolve(__dirname, ".."),
  });
  const eligibleRows = await fetchEligibleApprovedRows(db, {
    force,
    limit: options.limit,
    paymentReceiptId: options.paymentReceiptId,
  });
  let outputDir = requestedOutputDir;
  try {
    await fs.promises.mkdir(outputDir, { recursive: true });
  } catch (err) {
    const fallbackOutputDir = path.resolve(path.join(os.tmpdir(), "paytec-approved-receipts"));
    await fs.promises.mkdir(fallbackOutputDir, { recursive: true });
    outputDir = fallbackOutputDir;
    emitLog(logger, "warn", "output_dir_fallback", {
      requested_output_dir: requestedOutputDir,
      fallback_output_dir: fallbackOutputDir,
      reason: trimErrorMessage(err),
    });
  }

  emitLog(logger, "info", "start", {
    force,
    eligible: eligibleRows.length,
    delivery_mode: deliveryMode,
    template_html: path.basename(htmlPath),
    template_css: path.basename(cssPath),
    output_dir: outputDir,
  });

  const summary = {
    eligible: eligibleRows.length,
    sent: 0,
    failed: 0,
  };

  for (const row of eligibleRows) {
    const logContext = {
      payment_receipt_id: row.payment_receipt_id,
      student_username: row.student_username,
    };
    const preserveSentStateOnFail = force && Number(row.receipt_sent) === 1;
    await incrementDispatchAttempt(db, row);

    if (deliveryMode === "email" && !row.email) {
      summary.failed += 1;
      await markFailed(db, row.payment_receipt_id, "Student email is missing.", {
        preserveSentState: preserveSentStateOnFail,
      });
      emitLog(logger, "error", "send_fail", {
        ...logContext,
        reason: "Student email is missing.",
      });
      continue;
    }

    let placeholders;
    let outputPdfPath;

    try {
      const passportPhoto = await resolvePassportPhotoValue(row, {
        dataDir: options.dataDir,
        logger,
      });
      placeholders = buildPlaceholderMap(row, { passport_photo: passportPhoto });
      placeholders.sign_stamp = signStampDataUri;
      const outputFileName = `${sanitizeFileSegment(placeholders.application_id, `receipt-${row.payment_receipt_id}`)}_${toDateStamp(
        nowProvider()
      )}.pdf`;
      outputPdfPath = path.resolve(outputDir, outputFileName);
      const compiledHtml = renderTemplate(template, placeholders);
      const renderResult = await renderPdf({
        html: compiledHtml,
        outputPdfPath,
        row,
        placeholders,
      });
      await markGenerated(db, row.payment_receipt_id, toIsoDateTime(nowProvider()), outputPdfPath);
      emitLog(logger, "info", "generate_success", {
        ...logContext,
        output_pdf_path: outputPdfPath,
        render_method: renderResult?.method || "unknown",
      });
      if (renderResult && renderResult.usedFallback) {
        emitLog(logger, "warn", "generate_fallback_used", {
          ...logContext,
          output_pdf_path: outputPdfPath,
          reason: String(renderResult.warning || "Renderer fallback used."),
        });
      }
    } catch (err) {
      summary.failed += 1;
      const message = trimErrorMessage(err);
      await markFailed(db, row.payment_receipt_id, message, {
        preserveSentState: preserveSentStateOnFail,
      });
      emitLog(logger, "error", "generate_fail", {
        ...logContext,
        reason: message,
      });
      continue;
    }

    if (deliveryMode === "download") {
      try {
        await markSent(db, row.payment_receipt_id, toIsoDateTime(nowProvider()));
        summary.sent += 1;
        emitLog(logger, "info", "ready_success", {
          ...logContext,
          output_pdf_path: outputPdfPath,
        });
      } catch (err) {
        summary.failed += 1;
        const message = trimErrorMessage(err);
        await markFailed(db, row.payment_receipt_id, message, {
          preserveSentState: preserveSentStateOnFail,
        });
        emitLog(logger, "error", "ready_fail", {
          ...logContext,
          reason: message,
        });
      }
      continue;
    }

    try {
      const subject = renderTemplate(options.emailSubject || DEFAULT_EMAIL_SUBJECT, placeholders);
      const textBody = renderTemplate(options.emailBody || DEFAULT_EMAIL_BODY, placeholders);
      await sendEmailWithRetry({
        sendEmail: options.sendEmail,
        payload: {
          to: row.email,
          subject,
          text: textBody,
          attachments: [
            {
              filename: path.basename(outputPdfPath),
              path: outputPdfPath,
              contentType: "application/pdf",
            },
          ],
        },
        retryCount,
        retryDelayMs,
        logger,
      });
      await markSent(db, row.payment_receipt_id, toIsoDateTime(nowProvider()));
      summary.sent += 1;
      emitLog(logger, "info", "send_success", {
        ...logContext,
        email: row.email,
        output_pdf_path: outputPdfPath,
      });
    } catch (err) {
      summary.failed += 1;
      const message = trimErrorMessage(err);
      await markFailed(db, row.payment_receipt_id, message, {
        preserveSentState: preserveSentStateOnFail,
      });
      emitLog(logger, "error", "send_fail", {
        ...logContext,
        email: row.email,
        reason: message,
      });
    }
  }

  emitLog(logger, "info", "summary", {
    eligible: summary.eligible,
    sent: summary.sent,
    failed: summary.failed,
  });
  return summary;
}

module.exports = {
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_EMAIL_BODY,
  buildPlaceholderMap,
  createDefaultPassportDataUri,
  ensureDispatchTable,
  generateApprovedStudentReceipts,
  isTransientEmailError,
  mergeTemplateAndCss,
  renderHtmlToImagePdf,
  renderTemplate,
  resolveProfileImageFile,
  sanitizeFileSegment,
};
