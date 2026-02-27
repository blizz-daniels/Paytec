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

const A4_WIDTH_POINTS = 841.89;
const A4_HEIGHT_POINTS = 595.28;
const TARGET_RENDER_DPI = 300;
const RECEIPT_RENDER_SCALE = 2;
const A4_WIDTH_INCHES = 297 / 25.4;
const A4_HEIGHT_INCHES = 210 / 25.4;
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

const DEFAULT_BRAND_LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180">
  <rect x="0" y="0" width="360" height="180" fill="#11141b"/>
  <circle cx="72" cy="90" r="45" fill="#f3b33f"/>
  <path d="M42 70c12-15 30-20 45-18-8 3-14 10-16 17 6-6 15-10 24-10-5 5-8 11-9 16 7-5 16-7 25-6-6 4-10 10-11 16 6-2 13-2 19 1-8 1-14 6-16 12 7 0 14 2 20 6-10 1-19 6-24 13 4-1 8-1 12 1-9 5-19 8-30 7-18-2-33-14-39-30-4-11-4-20 0-25z" fill="#11141b"/>
  <text x="145" y="104" fill="#f3b33f" font-family="Arial, sans-serif" font-size="52" font-weight="700">DA4LIONS</text>
</svg>
`.trim();

const DEFAULT_FALLBACK_TEMPLATE_HTML = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Approved Payment Receipt</title>
</head>
<body>
  <main class="receipt-page">
    <section class="receipt-shell">
      <header class="receipt-header">
        <div class="top-rule"></div>
        <div class="brand-row">
          <div class="paytec-mark">
            <div class="paytec">PAY-TEC</div>
            <div class="paytec-swoosh"></div>
          </div>
          <h1>RECEIPT</h1>
          <div class="brand-banner">
            <img src="{{brand_logo}}" alt="Da4lions logo" />
            <span>DA4LIONS</span>
          </div>
        </div>
        <div class="accent-strip">
          <span class="accent-strip-orange"></span>
          <span class="accent-strip-blue"></span>
        </div>
      </header>
      <section class="receipt-body">
        <div class="receipt-left">
          <p><strong>Receipt No:</strong> {{receipt_no}}</p>
          <p><strong>Date:</strong> {{date_display}}</p>
          <p><strong>Client Name:</strong> {{client_name}}</p>
          <p><strong>Received From:</strong> {{received_from}}</p>
          <p><strong>Amount Received:</strong> {{amount_paid}}</p>
          <p><strong>Payment Method:</strong> {{payment_method}}</p>
          <p><strong>Purpose of Payment:</strong> {{purpose_of_payment}}</p>
          <p><strong>Application ID:</strong> {{application_id}}</p>
        </div>
        <aside class="receipt-right">
          <figure class="photo-frame">
            <img src="{{passport_photo}}" alt="Passport photo" />
          </figure>
          <p class="ack">Received with thanks the sum of {{amount_paid_words}} for {{purpose_of_payment}}.</p>
        </aside>
      </section>
      <section class="receipt-footer">
        <div class="authorized">
          <p class="label">Authorized By:</p>
          <div class="line"></div>
          <figure class="signature-mark">
            <img src="{{sign_stamp}}" alt="Authorized signature" />
          </figure>
          <div class="line line-bottom"></div>
        </div>
        <div class="footer-date">
          <p class="label">Date:</p>
          <div class="line"></div>
        </div>
      </section>
      <div class="bottom-strip">
        <span class="bottom-strip-orange"></span>
        <span class="bottom-strip-blue"></span>
      </div>
    </section>
  </main>
</body>
</html>
`.trim();

const DEFAULT_FALLBACK_TEMPLATE_CSS = `
html, body { margin: 0; padding: 0; font-family: "Segoe UI", Arial, sans-serif; background: #eef2f7; color: #111827; }
.receipt-page { width: 1123px; min-height: 794px; margin: 0 auto; padding: 28px; box-sizing: border-box; }
.receipt-shell { background: #fff; border: 1px solid #c9d1dc; box-shadow: 0 4px 14px rgba(15, 28, 45, 0.12); padding: 24px 30px; min-height: 738px; box-sizing: border-box; display: flex; flex-direction: column; }
.top-rule { height: 2px; background: #1c4d93; margin-bottom: 10px; }
.brand-row { display: grid; grid-template-columns: 270px 1fr 250px; align-items: center; column-gap: 16px; }
.paytec { color: #1c4d93; font-size: 56px; line-height: 0.95; font-style: italic; font-weight: 900; letter-spacing: 0.03em; }
.paytec-swoosh { margin-top: 6px; height: 3px; width: 190px; border-top: 3px solid #f28c1b; box-shadow: 0 4px 0 #7a889b; border-radius: 999px; }
h1 { margin: 0; text-align: center; color: #1c4d93; font-size: 74px; letter-spacing: 0.08em; line-height: 1; }
.brand-banner { background: #11141b; color: #f3b33f; padding: 8px 10px; display: grid; grid-template-columns: 56px 1fr; align-items: center; border: 1px solid #2a2f38; }
.brand-banner img { width: 52px; height: 52px; object-fit: cover; }
.brand-banner span { font-size: 34px; font-weight: 800; }
.accent-strip { margin-top: 12px; height: 7px; position: relative; }
.accent-strip::before { content: ""; position: absolute; left: 0; right: 0; top: 3px; border-top: 1px solid #7893b5; }
.accent-strip-orange { position: absolute; left: 380px; top: 0; width: 300px; height: 4px; background: #f28c1b; clip-path: polygon(0 100%, 6% 0, 100% 0, 94% 100%); }
.accent-strip-blue { position: absolute; right: 0; top: 0; width: 240px; height: 4px; background: #1c4d93; clip-path: polygon(0 0, 100% 0, 96% 100%, 4% 100%); }
.receipt-body { margin-top: 24px; display: grid; grid-template-columns: 1fr 280px; column-gap: 26px; }
.receipt-left p { margin: 0; padding: 12px 0; border-bottom: 1px solid #91a7c4; font-size: 29px; font-weight: 700; }
.receipt-left strong { color: #1f4478; margin-right: 6px; }
.receipt-left p:nth-child(4) { margin-top: 8px; }
.receipt-right { display: grid; grid-template-rows: auto 1fr; row-gap: 20px; }
.photo-frame { margin: 0; border: 1px solid #7f95b4; height: 260px; background: #f2f5fa; overflow: hidden; }
.photo-frame img { width: 100%; height: 100%; object-fit: cover; }
.ack { margin: 0; border-top: 1px solid #c4cfde; border-bottom: 1px solid #7691b7; padding: 16px 8px; font-size: 30px; line-height: 1.35; font-style: italic; font-weight: 600; color: #17263e; align-self: end; }
.receipt-footer { margin-top: 28px; border-top: 1px solid #8fa8c8; padding-top: 18px; display: grid; grid-template-columns: 1fr 240px; column-gap: 22px; }
.label { margin: 0 0 10px; color: #1f4478; font-size: 31px; line-height: 1; font-style: italic; font-weight: 800; }
.line { border-bottom: 1px solid #8fa8c8; height: 36px; }
.signature-mark { margin: 0; height: 56px; display: grid; justify-content: start; align-content: center; }
.signature-mark img { height: 52px; width: auto; max-width: 280px; object-fit: contain; mix-blend-mode: multiply; }
.line-bottom { height: 12px; }
.bottom-strip { margin-top: auto; height: 10px; position: relative; }
.bottom-strip::before { content: ""; position: absolute; left: 0; right: 0; top: 3px; border-top: 1px solid #7893b5; }
.bottom-strip-orange { position: absolute; left: 370px; bottom: 0; width: 320px; height: 4px; background: #f28c1b; clip-path: polygon(0 100%, 6% 0, 100% 0, 94% 100%); }
.bottom-strip-blue { position: absolute; right: 0; bottom: 0; width: 240px; height: 4px; background: #1c4d93; clip-path: polygon(0 0, 100% 0, 96% 100%, 4% 100%); }
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

function formatDateDdMmYyyy(input) {
  const date = input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) {
    const [year, month, day] = toDateStamp(new Date()).split("-");
    return `${day}/${month}/${year}`;
  }
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
}

const SMALL_NUMBER_WORDS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS_NUMBER_WORDS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function numberUnderThousandToWords(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "";
  }

  const whole = Math.floor(amount);
  const hundreds = Math.floor(whole / 100);
  const remainder = whole % 100;
  const parts = [];

  if (hundreds > 0) {
    parts.push(`${SMALL_NUMBER_WORDS[hundreds]} Hundred`);
  }

  if (remainder > 0) {
    if (remainder < 20) {
      parts.push(SMALL_NUMBER_WORDS[remainder]);
    } else {
      const tens = Math.floor(remainder / 10);
      const units = remainder % 10;
      const tensWord = TENS_NUMBER_WORDS[tens] || "";
      if (units > 0) {
        parts.push(`${tensWord}-${SMALL_NUMBER_WORDS[units]}`);
      } else {
        parts.push(tensWord);
      }
    }
  }

  return parts.join(" ").trim();
}

function integerToWords(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return SMALL_NUMBER_WORDS[0];
  }

  const scales = [
    { value: 1_000_000_000, label: "Billion" },
    { value: 1_000_000, label: "Million" },
    { value: 1_000, label: "Thousand" },
    { value: 1, label: "" },
  ];

  let remainder = Math.floor(amount);
  const parts = [];
  scales.forEach((scale) => {
    if (remainder < scale.value) {
      return;
    }
    const chunk = Math.floor(remainder / scale.value);
    remainder %= scale.value;
    const chunkWords = numberUnderThousandToWords(chunk);
    if (!chunkWords) {
      return;
    }
    parts.push(scale.label ? `${chunkWords} ${scale.label}` : chunkWords);
  });

  return parts.join(" ").trim() || SMALL_NUMBER_WORDS[0];
}

function amountToWords(value, currencyCode = "NGN") {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) {
    return "Zero";
  }

  const currency = String(currencyCode || "NGN")
    .trim()
    .toUpperCase();
  const unitByCurrency = {
    NGN: { major: "Naira", minor: "Kobo" },
    USD: { major: "Dollars", minor: "Cents" },
    GBP: { major: "Pounds", minor: "Pence" },
    EUR: { major: "Euros", minor: "Cents" },
  };
  const units = unitByCurrency[currency] || {
    major: currency || "Units",
    minor: "Cents",
  };

  const signPrefix = amount < 0 ? "Minus " : "";
  const absolute = Math.abs(amount);
  const whole = Math.floor(absolute);
  const fraction = Math.round((absolute - whole) * 100);

  let words = `${integerToWords(whole)} ${units.major}`;
  if (fraction > 0) {
    words += ` and ${integerToWords(fraction)} ${units.minor}`;
  }
  return `${signPrefix}${words} Only`;
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
  const paymentMethod = String(row.payment_method || row.payment_channel || "Paystack").trim() || "Paystack";
  const purposeOfPayment = row.program || row.payment_item_title || "N/A";
  const currencyCode = String(row.currency || "NGN")
    .trim()
    .toUpperCase() || "NGN";
  const amountFormatted = formatMoney(row.amount_paid, currencyCode);
  const amountWords = amountToWords(row.amount_paid, currencyCode);
  const fullName = row.full_name || row.display_name || row.student_username || "Student";
  return {
    full_name: fullName,
    client_name: fullName,
    received_from: fullName,
    application_id: applicationId,
    program: purposeOfPayment,
    purpose_of_payment: purposeOfPayment,
    payment_method: paymentMethod,
    amount_paid: amountFormatted,
    amount_paid_words: amountWords,
    amount_paid_numeric: formatAmountNumber(row.amount_paid),
    currency_code: currencyCode,
    received_by: "Accounts Office",
    receipt_no: row.receipt_no || `RCP-${String(receiptId || "0").padStart(6, "0")}`,
    approval_date: formatHumanDate(approvalDateValue),
    date_display: formatDateDdMmYyyy(approvalDateValue),
    passport_photo: row.passport_photo || createDefaultPassportDataUri(),
    sign_stamp: row.sign_stamp || createDefaultStampDataUri(),
    brand_logo: row.brand_logo || createDefaultBrandLogoDataUri(),
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

function createDefaultBrandLogoDataUri() {
  return encodeSvgToDataUri(DEFAULT_BRAND_LOGO_SVG);
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

async function resolveBrandLogoPath(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, ".."));
  const explicitInput = String(options.brandLogoPath || process.env.RECEIPT_TEMPLATE_BRAND_LOGO_PATH || "").trim();
  if (explicitInput) {
    return path.isAbsolute(explicitInput) ? explicitInput : path.resolve(projectRoot, explicitInput);
  }

  const candidates = [
    path.resolve(projectRoot, "assets", "da4lions-logo.jpeg"),
    path.resolve(projectRoot, "assets", "lion-logo.png"),
    path.resolve(projectRoot, "assets", "lion-logo-512.png"),
    path.resolve(projectRoot, "assets", "lion-logo-192.png"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch (_err) {
      // Continue scanning candidates.
    }
  }
  return null;
}

async function resolveBrandLogoValue(options = {}) {
  const logger = ensureLogger(options.logger);
  const logoPath = await resolveBrandLogoPath(options);
  if (!logoPath) {
    emitLog(logger, "warn", "brand_logo_fallback", {
      reason: "brand logo file not found",
    });
    return createDefaultBrandLogoDataUri();
  }
  if (/^https?:\/\//i.test(logoPath) || /^data:/i.test(logoPath)) {
    return logoPath;
  }
  try {
    await fs.promises.access(logoPath, fs.constants.R_OK);
    return await fileToDataUri(logoPath);
  } catch (_err) {
    emitLog(logger, "warn", "brand_logo_fallback", {
      reason: "brand logo file unreadable",
      logo_path: logoPath,
    });
    return createDefaultBrandLogoDataUri();
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

  const content = ["BT", "/F1 14 Tf", "50 545 Td"];
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
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
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
  const shellX = 18;
  const shellY = 16;
  const shellW = width - shellX * 2;
  const shellH = height - shellY * 2;
  const shellRight = shellX + shellW;
  const shellTop = shellY + shellH;
  const contentX = shellX + 22;
  const contentRight = shellRight - 22;
  const rightColX = contentRight - 214;
  const leftColRight = rightColX - 18;

  const colorPageBg = rgbFromHex("eceff3", rgb);
  const colorPaper = rgbFromHex("ffffff", rgb);
  const colorBorder = rgbFromHex("c9d1dc", rgb);
  const colorBlue = rgbFromHex("1c4d93", rgb);
  const colorBlueSoft = rgbFromHex("90a8c7", rgb);
  const colorOrange = rgbFromHex("f28c1b", rgb);
  const colorBlack = rgbFromHex("11141b", rgb);
  const colorYellow = rgbFromHex("f3b33f", rgb);
  const colorText = rgbFromHex("111827", rgb);
  const colorTextBlue = rgbFromHex("1f4478", rgb);

  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const splitTokenToWidth = (token, font, size, maxWidth) => {
    const raw = String(token || "");
    if (!raw) {
      return [];
    }
    if (font.widthOfTextAtSize(raw, size) <= maxWidth) {
      return [raw];
    }
    const chunks = [];
    let current = "";
    for (const char of raw) {
      const attempt = `${current}${char}`;
      if (!current || font.widthOfTextAtSize(attempt, size) <= maxWidth) {
        current = attempt;
        continue;
      }
      chunks.push(current);
      current = char;
    }
    if (current) {
      chunks.push(current);
    }
    return chunks;
  };

  const wrapTextLines = (text, font, size, maxWidth, maxLines = 2) => {
    const words = String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((word) => splitTokenToWidth(word, font, size, maxWidth));
    if (!words.length) {
      return ["-"];
    }
    const lines = [];
    let current = "";
    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth || !current) {
        current = next;
        return;
      }
      lines.push(current);
      current = word;
    });
    if (current) {
      lines.push(current);
    }
    if (lines.length <= maxLines) {
      return lines;
    }
    const trimmed = lines.slice(0, maxLines);
    let last = trimmed[maxLines - 1];
    while (last.length > 3 && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) {
      last = last.slice(0, -1);
    }
    trimmed[maxLines - 1] = `${last}...`;
    return trimmed;
  };

  const drawWrappedText = (text, x, yTop, maxWidth, font, size, color, lineGap = 1.3, maxLines = 2) => {
    const lines = wrapTextLines(text, font, size, maxWidth, maxLines);
    let y = yTop;
    lines.forEach((line) => {
      page.drawText(line, {
        x,
        y,
        size,
        font,
        color,
      });
      y -= size * lineGap;
    });
    return y;
  };

  const drawContainedImage = (embeddedImage, boxX, boxY, boxWidth, boxHeight) => {
    const targetWidth = Math.max(0, Number(boxWidth) || 0);
    const targetHeight = Math.max(0, Number(boxHeight) || 0);
    if (!targetWidth || !targetHeight) {
      return;
    }
    const scaled = typeof embeddedImage.scaleToFit === "function"
      ? embeddedImage.scaleToFit(targetWidth, targetHeight)
      : { width: targetWidth, height: targetHeight };
    page.drawImage(embeddedImage, {
      x: boxX + (targetWidth - scaled.width) / 2,
      y: boxY + (targetHeight - scaled.height) / 2,
      width: scaled.width,
      height: scaled.height,
    });
  };

  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height,
    color: colorPageBg,
  });

  page.drawRectangle({
    x: shellX,
    y: shellY,
    width: shellW,
    height: shellH,
    color: colorPaper,
    borderColor: colorBorder,
    borderWidth: 1.1,
  });

  const topRuleY = shellTop - 14;
  page.drawLine({
    start: { x: contentX - 4, y: topRuleY },
    end: { x: contentRight + 4, y: topRuleY },
    thickness: 2.1,
    color: colorBlue,
  });

  const headerY = shellTop - 70;
  page.drawText("PAY-TEC", {
    x: contentX,
    y: headerY,
    size: 38,
    font: fontBold,
    color: colorBlue,
  });
  page.drawLine({
    start: { x: contentX + 8, y: headerY - 6 },
    end: { x: contentX + 148, y: headerY + 4 },
    thickness: 2,
    color: colorOrange,
  });
  page.drawLine({
    start: { x: contentX + 6, y: headerY - 12 },
    end: { x: contentX + 140, y: headerY - 8 },
    thickness: 1.5,
    color: rgbFromHex("7a889b", rgb),
  });

  const receiptTitle = "RECEIPT";
  const receiptTitleSize = 56;
  const receiptTitleWidth = fontBold.widthOfTextAtSize(receiptTitle, receiptTitleSize);
  page.drawText(receiptTitle, {
    x: shellX + (shellW - receiptTitleWidth) / 2,
    y: headerY + 2,
    size: receiptTitleSize,
    font: fontBold,
    color: colorBlue,
  });

  const bannerW = 210;
  const bannerH = 54;
  const bannerX = contentRight - bannerW;
  const bannerY = shellTop - 78;
  page.drawRectangle({
    x: bannerX,
    y: bannerY,
    width: bannerW,
    height: bannerH,
    color: colorBlack,
    borderColor: rgbFromHex("2a2f38", rgb),
    borderWidth: 1,
  });

  const parsedBrandLogo = parseDataUriImage(placeholders?.brand_logo);
  if (parsedBrandLogo) {
    try {
      const embedded =
        parsedBrandLogo.mime === "image/png"
          ? await doc.embedPng(parsedBrandLogo.bytes)
          : await doc.embedJpg(parsedBrandLogo.bytes);
      drawContainedImage(embedded, bannerX + 6, bannerY + 6, 42, 42);
    } catch (_err) {
      page.drawCircle({
        x: bannerX + 27,
        y: bannerY + 27,
        size: 15,
        color: colorYellow,
      });
    }
  } else {
    page.drawCircle({
      x: bannerX + 27,
      y: bannerY + 27,
      size: 15,
      color: colorYellow,
    });
  }
  page.drawText("DA4LIONS", {
    x: bannerX + 54,
    y: bannerY + 17,
    size: 24,
    font: fontBold,
    color: colorYellow,
  });

  const stripY = shellTop - 98;
  page.drawLine({
    start: { x: contentX - 4, y: stripY },
    end: { x: contentRight + 4, y: stripY },
    thickness: 1.6,
    color: rgbFromHex("7893b5", rgb),
  });
  page.drawRectangle({
    x: contentX + 258,
    y: stripY - 6,
    width: 238,
    height: 5,
    color: colorOrange,
  });
  page.drawRectangle({
    x: contentRight - 166,
    y: stripY - 6,
    width: 158,
    height: 5,
    color: colorBlue,
  });

  const photoW = 200;
  const photoH = 180;
  const photoX = rightColX + 6;
  const photoY = shellTop - 286;
  page.drawRectangle({
    x: photoX,
    y: photoY,
    width: photoW,
    height: photoH,
    borderColor: rgbFromHex("7f95b4", rgb),
    borderWidth: 1.3,
    color: rgbFromHex("f2f5fa", rgb),
  });
  const parsedPhoto = parseDataUriImage(placeholders?.passport_photo);
  if (parsedPhoto) {
    try {
      const embedded =
        parsedPhoto.mime === "image/png"
          ? await doc.embedPng(parsedPhoto.bytes)
          : await doc.embedJpg(parsedPhoto.bytes);
      drawContainedImage(embedded, photoX + 2, photoY + 2, photoW - 4, photoH - 4);
    } catch (_err) {
      page.drawText("Passport Photo", {
        x: photoX + 46,
        y: photoY + 86,
        size: 12,
        font: fontRegular,
        color: rgbFromHex("7a8797", rgb),
      });
    }
  } else {
    page.drawText("Passport Photo", {
      x: photoX + 46,
      y: photoY + 86,
      size: 12,
      font: fontRegular,
      color: rgbFromHex("7a8797", rgb),
    });
  }

  const labelX = contentX + 2;
  const valueX = contentX + 125;
  const rowEndX = leftColRight - 4;
  let rowY = shellTop - 154;

  const drawDetailRow = (label, value, options = {}) => {
    const maxLines = Number.isFinite(Number(options.maxLines)) ? Number(options.maxLines) : 1;
    const gapAfter = Number.isFinite(Number(options.gapAfter)) ? Number(options.gapAfter) : 26;
    page.drawText(String(label || ""), {
      x: labelX,
      y: rowY,
      size: 12.2,
      font: fontBold,
      color: colorTextBlue,
    });
    const textEndY = drawWrappedText(
      String(value || "-"),
      valueX,
      rowY,
      rowEndX - valueX - 2,
      fontBold,
      12.2,
      colorText,
      1.28,
      maxLines
    );
    const lineY = textEndY + 3;
    page.drawLine({
      start: { x: labelX, y: lineY },
      end: { x: rowEndX, y: lineY },
      thickness: 1.1,
      color: colorBlueSoft,
    });
    rowY = lineY - gapAfter;
  };

  drawDetailRow("Receipt No:", placeholders?.receipt_no, { maxLines: 1 });
  drawDetailRow("Date:", placeholders?.date_display || placeholders?.approval_date, { maxLines: 1 });
  drawDetailRow("Client Name:", placeholders?.client_name || placeholders?.full_name, { maxLines: 1, gapAfter: 30 });
  drawDetailRow("Received From:", placeholders?.received_from || placeholders?.full_name, { maxLines: 1 });
  drawDetailRow("Amount Received:", placeholders?.amount_paid, { maxLines: 1 });
  drawDetailRow("Payment Method:", placeholders?.payment_method || "Paystack", { maxLines: 1 });
  drawDetailRow("Purpose of Payment:", placeholders?.purpose_of_payment || placeholders?.program, { maxLines: 2, gapAfter: 20 });

  const appIdY = rowY + 8;
  page.drawText(
    `Application ID: ${clampText(placeholders?.application_id || row?.payment_reference || row?.student_username || "-", 38)}`,
    {
      x: valueX,
      y: appIdY,
      size: 9.8,
      font: fontRegular,
      color: rgbFromHex("2f4f76", rgb),
    }
  );

  const ackTop = photoY - 20;
  const ackBottom = shellY + 136;
  page.drawLine({
    start: { x: rightColX, y: ackTop },
    end: { x: contentRight, y: ackTop },
    thickness: 1.1,
    color: rgbFromHex("c4cfde", rgb),
  });
  page.drawLine({
    start: { x: rightColX, y: ackBottom },
    end: { x: contentRight, y: ackBottom },
    thickness: 1.1,
    color: rgbFromHex("7691b7", rgb),
  });
  const ackLead = "Received with thanks the sum of";
  const ackWords = String(placeholders?.amount_paid_words || placeholders?.amount_paid || "").trim();
  const ackTail = `for ${clampText(placeholders?.purpose_of_payment || placeholders?.program, 64)}.`;
  const ackTextX = rightColX + 8;
  const ackWidth = contentRight - ackTextX - 8;
  let ackY = ackTop - 24;
  ackY = drawWrappedText(ackLead, ackTextX, ackY, ackWidth, fontItalic, 12.2, rgbFromHex("17263e", rgb), 1.3, 2) - 6;
  ackY = drawWrappedText(ackWords, ackTextX, ackY, ackWidth, fontBold, 12.8, rgbFromHex("17263e", rgb), 1.32, 3) - 4;
  drawWrappedText(ackTail, ackTextX, ackY, ackWidth, fontItalic, 12.2, rgbFromHex("17263e", rgb), 1.3, 2);

  const footerLineY = shellY + 126;
  page.drawLine({
    start: { x: contentX - 4, y: footerLineY },
    end: { x: contentRight + 4, y: footerLineY },
    thickness: 1.2,
    color: colorBlueSoft,
  });

  page.drawText("Authorized By:", {
    x: contentX + 8,
    y: footerLineY - 30,
    size: 12.8,
    font: fontBold,
    color: colorTextBlue,
  });
  const signatureLineStart = contentX + 8;
  const signatureLineEnd = contentX + 260;
  page.drawLine({
    start: { x: signatureLineStart, y: footerLineY - 62 },
    end: { x: signatureLineEnd, y: footerLineY - 62 },
    thickness: 1,
    color: colorBlueSoft,
  });
  page.drawLine({
    start: { x: signatureLineStart, y: footerLineY - 98 },
    end: { x: signatureLineEnd, y: footerLineY - 98 },
    thickness: 1,
    color: colorBlueSoft,
  });

  const parsedStamp = parseDataUriImage(placeholders?.sign_stamp);
  if (parsedStamp) {
    try {
      const embedded =
        parsedStamp.mime === "image/png"
          ? await doc.embedPng(parsedStamp.bytes)
          : await doc.embedJpg(parsedStamp.bytes);
      drawContainedImage(embedded, signatureLineStart + 18, footerLineY - 92, 210, 36);
    } catch (_err) {
      page.drawText("Signature", {
        x: signatureLineStart + 58,
        y: footerLineY - 83,
        size: 20,
        font: fontItalic,
        color: colorBlue,
      });
    }
  } else {
    page.drawText("Signature", {
      x: signatureLineStart + 58,
      y: footerLineY - 83,
      size: 20,
      font: fontItalic,
      color: colorBlue,
    });
  }

  const dateLabelX = contentRight - 250;
  page.drawText("Date:", {
    x: dateLabelX,
    y: footerLineY - 30,
    size: 12.8,
    font: fontBold,
    color: colorTextBlue,
  });
  page.drawLine({
    start: { x: dateLabelX, y: footerLineY - 62 },
    end: { x: contentRight, y: footerLineY - 62 },
    thickness: 1,
    color: colorBlueSoft,
  });

  const bottomStripY = shellY + 18;
  page.drawLine({
    start: { x: contentX - 4, y: bottomStripY + 6 },
    end: { x: contentRight + 4, y: bottomStripY + 6 },
    thickness: 1.4,
    color: rgbFromHex("7893b5", rgb),
  });
  page.drawRectangle({
    x: contentX + 248,
    y: bottomStripY + 1,
    width: 248,
    height: 5,
    color: colorOrange,
  });
  page.drawRectangle({
    x: contentRight - 168,
    y: bottomStripY + 1,
    width: 160,
    height: 5,
    color: colorBlue,
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
        width: "297mm",
        height: "210mm",
        landscape: true,
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
  const brandLogoDataUri = await resolveBrandLogoValue({
    logger,
    brandLogoPath: options.brandLogoPath,
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
      placeholders = buildPlaceholderMap(row, {
        passport_photo: passportPhoto,
        brand_logo: brandLogoDataUri,
      });
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
