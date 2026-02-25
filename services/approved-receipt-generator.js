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

function buildPlaceholderMap(row, overrides = {}) {
  const receiptId = Number(row.payment_receipt_id || row.id || 0);
  const applicationId = row.application_id || row.payment_reference || row.student_username || `PR-${receiptId}`;
  const approvalDateValue = row.reviewed_at || row.approved_at || row.submitted_at || new Date().toISOString();
  return {
    full_name: row.full_name || row.display_name || row.student_username || "Student",
    application_id: applicationId,
    program: row.program || row.payment_item_title || "N/A",
    amount_paid: formatMoney(row.amount_paid, row.currency || "NGN"),
    receipt_no: row.receipt_no || `RCP-${String(receiptId || "0").padStart(6, "0")}`,
    approval_date: formatHumanDate(approvalDateValue),
    passport_photo: row.passport_photo || createDefaultPassportDataUri(),
    ...overrides,
  };
}

function encodeSvgToDataUri(svgText) {
  return `data:image/svg+xml;base64,${Buffer.from(String(svgText || ""), "utf8").toString("base64")}`;
}

function createDefaultPassportDataUri() {
  return encodeSvgToDataUri(DEFAULT_PASSPORT_SVG);
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
  const margin = 28;
  const cardX = margin;
  const cardY = margin;
  const cardW = width - margin * 2;
  const cardH = height - margin * 2;
  const headerH = 108;
  const bodyTopY = cardY + cardH - headerH;

  const colorPageBg = rgbFromHex("eef3f8", rgb);
  const colorCardBg = rgbFromHex("ffffff", rgb);
  const colorCardBorder = rgbFromHex("c8d2dd", rgb);
  const colorHeader = rgbFromHex("1d3f61", rgb);
  const colorAccent = rgbFromHex("f0f6fc", rgb);
  const colorTitle = rgbFromHex("0f2339", rgb);
  const colorText = rgbFromHex("27435f", rgb);
  const colorMuted = rgbFromHex("55708b", rgb);
  const colorLightText = rgbFromHex("f4f8fc", rgb);

  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height,
    color: colorPageBg,
  });
  page.drawRectangle({
    x: cardX,
    y: cardY,
    width: cardW,
    height: cardH,
    color: colorCardBg,
    borderColor: colorCardBorder,
    borderWidth: 2,
  });
  page.drawRectangle({
    x: cardX,
    y: bodyTopY,
    width: cardW,
    height: headerH,
    color: colorHeader,
  });

  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const padX = cardX + 28;
  const headerBaseY = bodyTopY + headerH - 34;

  page.drawText("PAYTEC", {
    x: padX,
    y: headerBaseY + 3,
    size: 18,
    font: fontBold,
    color: colorLightText,
  });
  page.drawText("Approved Student Receipt", {
    x: padX + 92,
    y: headerBaseY + 1,
    size: 19,
    font: fontBold,
    color: colorLightText,
  });
  page.drawText("Official confirmation of approved payment", {
    x: padX + 92,
    y: headerBaseY - 19,
    size: 10,
    font: fontRegular,
    color: colorLightText,
  });

  const metaX = cardX + cardW - 228;
  page.drawText("Receipt No", {
    x: metaX,
    y: headerBaseY + 2,
    size: 8.5,
    font: fontRegular,
    color: colorLightText,
  });
  page.drawText(clampText(placeholders?.receipt_no, 28), {
    x: metaX,
    y: headerBaseY - 13,
    size: 10.5,
    font: fontBold,
    color: colorLightText,
  });
  page.drawText("Approval Date", {
    x: metaX,
    y: headerBaseY - 33,
    size: 8.5,
    font: fontRegular,
    color: colorLightText,
  });
  page.drawText(clampText(placeholders?.approval_date, 24), {
    x: metaX,
    y: headerBaseY - 48,
    size: 10.5,
    font: fontBold,
    color: colorLightText,
  });

  const photoW = 120;
  const photoH = 146;
  const photoX = cardX + cardW - photoW - 34;
  const photoY = bodyTopY - photoH - 34;
  page.drawRectangle({
    x: photoX,
    y: photoY,
    width: photoW,
    height: photoH,
    color: colorAccent,
    borderColor: colorCardBorder,
    borderWidth: 1.2,
  });

  const parsedPhoto = parseDataUriImage(placeholders?.passport_photo);
  if (parsedPhoto) {
    try {
      const embedded =
        parsedPhoto.mime === "image/png"
          ? await doc.embedPng(parsedPhoto.bytes)
          : await doc.embedJpg(parsedPhoto.bytes);
      page.drawImage(embedded, {
        x: photoX + 5,
        y: photoY + 5,
        width: photoW - 10,
        height: photoH - 10,
      });
    } catch (_err) {
      page.drawText("Passport", {
        x: photoX + 34,
        y: photoY + 70,
        size: 11,
        font: fontBold,
        color: colorMuted,
      });
      page.drawText("Photo", {
        x: photoX + 44,
        y: photoY + 53,
        size: 11,
        font: fontBold,
        color: colorMuted,
      });
    }
  } else {
    page.drawText("Passport", {
      x: photoX + 34,
      y: photoY + 70,
      size: 11,
      font: fontBold,
      color: colorMuted,
    });
    page.drawText("Photo", {
      x: photoX + 44,
      y: photoY + 53,
      size: 11,
      font: fontBold,
      color: colorMuted,
    });
  }

  const contentX = padX;
  let contentY = bodyTopY - 40;
  page.drawText(clampText(placeholders?.full_name || row?.student_username || "Student", 48), {
    x: contentX,
    y: contentY,
    size: 21,
    font: fontBold,
    color: colorTitle,
  });
  contentY -= 35;

  const details = [
    ["Application ID", placeholders?.application_id || row?.payment_reference || row?.student_username || "-"],
    ["Program", placeholders?.program || row?.payment_item_title || "-"],
    ["Receipt No", placeholders?.receipt_no || row?.payment_receipt_id || row?.id || "-"],
    ["Approval Date", placeholders?.approval_date || formatHumanDate(row?.reviewed_at || row?.submitted_at || new Date())],
  ];
  details.forEach(([label, value]) => {
    page.drawText(`${label}:`, {
      x: contentX,
      y: contentY,
      size: 10.2,
      font: fontBold,
      color: colorMuted,
    });
    page.drawText(clampText(value, 64), {
      x: contentX + 94,
      y: contentY,
      size: 11,
      font: fontRegular,
      color: colorText,
    });
    contentY -= 20;
  });

  const amountBoxY = contentY - 8;
  page.drawRectangle({
    x: contentX,
    y: amountBoxY,
    width: 290,
    height: 48,
    color: colorAccent,
    borderColor: colorCardBorder,
    borderWidth: 1,
  });
  page.drawText("Amount Paid", {
    x: contentX + 12,
    y: amountBoxY + 30,
    size: 9.5,
    font: fontBold,
    color: colorMuted,
  });
  page.drawText(clampText(placeholders?.amount_paid || formatMoney(row?.amount_paid, row?.currency || "NGN"), 28), {
    x: contentX + 12,
    y: amountBoxY + 12,
    size: 16,
    font: fontBold,
    color: colorTitle,
  });

  const noteY = cardY + 118;
  page.drawRectangle({
    x: contentX,
    y: noteY,
    width: cardW - 56,
    height: 66,
    color: colorAccent,
    borderColor: colorCardBorder,
    borderWidth: 1,
  });
  page.drawText(
    "This certifies that the payment linked to this application was reviewed and approved by the accounts office.",
    {
      x: contentX + 12,
      y: noteY + 42,
      size: 10.3,
      font: fontRegular,
      color: colorText,
    }
  );
  page.drawText("Generated by Paytec Receipt Service", {
    x: contentX + 12,
    y: cardY + 72,
    size: 9,
    font: fontBold,
    color: colorMuted,
  });
  page.drawText(`Generated: ${formatHumanDate(new Date())}`, {
    x: contentX + 12,
    y: cardY + 58,
    size: 9,
    font: fontRegular,
    color: colorMuted,
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
