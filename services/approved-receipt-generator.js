const fs = require("fs");
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
  const html = options.templateHtml || (await fs.promises.readFile(htmlPath, "utf8"));
  let css = options.templateCss || "";
  if (!css) {
    try {
      css = await fs.promises.readFile(cssPath, "utf8");
    } catch (_err) {
      css = "";
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
    sql += " AND COALESCE(ard.receipt_sent, 0) = 0";
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

async function renderHtmlToImagePdf({ html, outputPdfPath }) {
  const puppeteer = requireOptionalPackage("puppeteer", "npm install puppeteer pdf-lib nodemailer");
  const { PDFDocument } = requireOptionalPackage("pdf-lib", "npm install pdf-lib");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.RECEIPT_BROWSER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: {
        width: RECEIPT_SNAPSHOT_WIDTH,
        height: RECEIPT_SNAPSHOT_HEIGHT,
        deviceScaleFactor: RECEIPT_RENDER_SCALE,
      },
    });
    await page.setContent(html, { waitUntil: "networkidle0" });
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
  } finally {
    await browser.close();
  }
}

async function generateApprovedStudentReceipts(options = {}) {
  const db = options.db;
  if (!db || typeof db.run !== "function" || typeof db.all !== "function") {
    throw new Error("A database client with run/get/all methods is required.");
  }
  if (typeof options.sendEmail !== "function") {
    throw new Error("options.sendEmail is required.");
  }

  const logger = ensureLogger(options.logger);
  const nowProvider = typeof options.nowProvider === "function" ? options.nowProvider : () => new Date();
  const outputDir = path.resolve(options.outputDir || path.join(__dirname, "..", "outputs", "receipts"));
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
  await fs.promises.mkdir(outputDir, { recursive: true });

  emitLog(logger, "info", "start", {
    force,
    eligible: eligibleRows.length,
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

    if (!row.email) {
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
      await renderPdf({
        html: compiledHtml,
        outputPdfPath,
        row,
        placeholders,
      });
      await markGenerated(db, row.payment_receipt_id, toIsoDateTime(nowProvider()), outputPdfPath);
      emitLog(logger, "info", "generate_success", {
        ...logContext,
        output_pdf_path: outputPdfPath,
      });
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
