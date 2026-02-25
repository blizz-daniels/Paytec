#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  DEFAULT_EMAIL_BODY,
  DEFAULT_EMAIL_SUBJECT,
  generateApprovedStudentReceipts,
} = require("../services/approved-receipt-generator");
const { openSqliteDatabase } = require("../services/sqlite-client");

const projectRoot = path.resolve(__dirname, "..");

function parseBoolean(rawValue, defaultValue = false) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return defaultValue;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function loadDotEnvIfPresent(dotEnvPath) {
  if (!fs.existsSync(dotEnvPath)) {
    return;
  }
  const content = fs.readFileSync(dotEnvPath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function printHelp() {
  const lines = [
    "Approved Student Receipt Generator",
    "",
    "Usage:",
    "  node scripts/generate-receipts.js [--force] [--limit=50]",
    "  node scripts/generate-receipts.js --schedule --interval-minutes=30",
    "",
    "Options:",
    "  --force                Regenerate and resend even when already marked as sent.",
    "  --limit=<n>            Process at most <n> approved rows in one run.",
    "  --schedule             Keep running on an interval (task scheduler/daemon mode).",
    "  --interval-minutes=<n> Interval for --schedule mode. Defaults to env or 30.",
    "  --help                 Show this help message.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function parseArgs(argv) {
  const options = {
    force: false,
    schedule: false,
    limit: 0,
    intervalMinutes: Number.parseInt(String(process.env.RECEIPT_SCHEDULE_INTERVAL_MINUTES || 30), 10) || 30,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--schedule") {
      options.schedule = true;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const value = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("Invalid --limit value. Use a positive integer.");
      }
      options.limit = value;
      continue;
    }
    if (arg.startsWith("--interval-minutes=")) {
      const value = Number.parseInt(arg.slice("--interval-minutes=".length), 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("Invalid --interval-minutes value. Use a positive integer.");
      }
      options.intervalMinutes = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveDefaultDataDir() {
  const isProduction = process.env.NODE_ENV === "production";
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR);
  }
  return isProduction ? "/tmp/paytec" : path.join(projectRoot, "data");
}

function resolveDbPath(defaultDataDir) {
  if (process.env.RECEIPT_DB_PATH) {
    return path.resolve(process.env.RECEIPT_DB_PATH);
  }
  return path.join(defaultDataDir, "paytec.sqlite");
}

function parseOptionalPositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createEmailSender() {
  const nodemailer = (() => {
    try {
      // eslint-disable-next-line global-require
      return require("nodemailer");
    } catch (err) {
      if (err && err.code === "MODULE_NOT_FOUND") {
        throw new Error('Missing dependency "nodemailer". Install it with: npm install nodemailer');
      }
      throw err;
    }
  })();

  const smtpFrom = String(process.env.SMTP_FROM || process.env.RECEIPT_EMAIL_FROM || "").trim();
  if (!smtpFrom) {
    throw new Error("SMTP_FROM (or RECEIPT_EMAIL_FROM) is required.");
  }

  let transport;
  const smtpUrl = String(process.env.SMTP_URL || "").trim();
  if (smtpUrl) {
    transport = nodemailer.createTransport(smtpUrl);
  } else {
    const host = String(process.env.SMTP_HOST || "").trim();
    const port = Number.parseInt(String(process.env.SMTP_PORT || "587"), 10);
    const user = String(process.env.SMTP_USER || "").trim();
    const pass = String(process.env.SMTP_PASS || "").trim();
    if (!host || !port || !user || !pass) {
      throw new Error("Set SMTP_URL or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in your environment.");
    }
    const secure = parseBoolean(process.env.SMTP_SECURE, port === 465);
    transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
  }

  return {
    async sendEmail(payload) {
      await transport.sendMail({
        from: smtpFrom,
        ...payload,
      });
    },
    async close() {
      if (typeof transport.close === "function") {
        transport.close();
      }
    },
  };
}

async function runOnce(cliOptions) {
  const dataDir = resolveDefaultDataDir();
  const dbPath = resolveDbPath(dataDir);
  const outputDir = path.resolve(process.env.RECEIPT_OUTPUT_DIR || path.join(projectRoot, "outputs", "receipts"));
  const templateHtmlPath = path.resolve(
    process.env.RECEIPT_TEMPLATE_HTML || path.join(projectRoot, "templates", "approved-student-receipt.html")
  );
  const templateCssPath = path.resolve(
    process.env.RECEIPT_TEMPLATE_CSS || path.join(projectRoot, "templates", "approved-student-receipt.css")
  );

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}. Start the app once to initialize the database.`);
  }

  const db = openSqliteDatabase(dbPath);
  let mailer = null;
  try {
    mailer = createEmailSender();
    const summary = await generateApprovedStudentReceipts({
      db,
      force: cliOptions.force,
      limit: cliOptions.limit || 0,
      dataDir,
      outputDir,
      templateHtmlPath,
      templateCssPath,
      emailSubject: process.env.RECEIPT_EMAIL_SUBJECT || DEFAULT_EMAIL_SUBJECT,
      emailBody: process.env.RECEIPT_EMAIL_BODY || DEFAULT_EMAIL_BODY,
      retryCount: parseOptionalPositiveInt(process.env.RECEIPT_EMAIL_RETRY_COUNT, 3),
      retryDelayMs: parseOptionalPositiveInt(process.env.RECEIPT_EMAIL_RETRY_DELAY_MS, 1500),
      sendEmail: mailer.sendEmail,
      logger: console,
    });
    console.info(
      `[approved-receipts] run complete eligible=${summary.eligible} sent=${summary.sent} failed=${summary.failed}`
    );
    return summary;
  } finally {
    if (mailer) {
      await Promise.all([mailer.close(), db.close()]);
    } else {
      await db.close();
    }
  }
}

async function main() {
  loadDotEnvIfPresent(path.join(projectRoot, ".env"));
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.schedule) {
    await runOnce(options);
    return;
  }

  const intervalMs = Math.max(60 * 1000, options.intervalMinutes * 60 * 1000);
  let isRunning = false;
  let timer = null;

  const execute = async () => {
    if (isRunning) {
      console.warn("[approved-receipts] previous run still active; skipping this interval tick.");
      return;
    }
    isRunning = true;
    try {
      await runOnce(options);
    } catch (err) {
      console.error(`[approved-receipts] scheduled run failed: ${err.message || err}`);
    } finally {
      isRunning = false;
    }
  };

  console.info(`[approved-receipts] schedule mode enabled interval=${options.intervalMinutes}m`);
  await execute();
  timer = setInterval(execute, intervalMs);

  const shutdown = () => {
    if (timer) {
      clearInterval(timer);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[approved-receipts] fatal: ${err.message || err}`);
  process.exit(1);
});
