const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const express = require("express");
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

const db = new sqlite3.Database(dbPath);

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

async function importRoster(filePath, role, idHeader) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return importRosterCsvText(raw, role, idHeader, path.basename(filePath));
}

async function importRosterCsvText(csvText, role, idHeader, sourceName) {
  const raw = String(csvText || "");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return 0;
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const idIndex = headers.indexOf(idHeader);
  const surnameIndex = headers.indexOf("surname");
  if (idIndex === -1 || surnameIndex === -1) {
    throw new Error(`Invalid roster header. Expected columns: ${idHeader},surname`);
  }

  let imported = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]);
    const identifier = normalizeIdentifier(row[idIndex]);
    const surnamePassword = normalizeSurnamePassword(row[surnameIndex]);
    if (!isValidIdentifier(identifier) || !isValidSurnamePassword(surnamePassword)) {
      continue;
    }

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
    imported += 1;
  }

  return imported;
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
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    CREATE TABLE IF NOT EXISTS payment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      payment_url TEXT NOT NULL,
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

  const userColumns = await all("PRAGMA table_info(users)");
  if (!userColumns.some((column) => column.name === "role")) {
    await run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student'");
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

app.use("/assets", express.static(path.join(__dirname, "assets")));

function isAuthenticated(req) {
  return !!(req.session && req.session.user);
}

function isValidHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(value);
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

  if (!isValidIdentifier(identifier) || !rawPassword.trim()) {
    return res.redirect("/login?error=invalid");
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
        return res.redirect("/login?error=invalid");
      }
      const rosterUser = await get(
        "SELECT auth_id, role, password_hash FROM auth_roster WHERE auth_id = ? LIMIT 1",
        [identifier]
      );
      if (!rosterUser) {
        return res.redirect("/login?error=invalid");
      }

      const validRosterPassword = await bcrypt.compare(surnamePassword, rosterUser.password_hash);
      if (!validRosterPassword) {
        return res.redirect("/login?error=invalid");
      }
      authUser = {
        username: rosterUser.auth_id,
        role: rosterUser.role,
      };
      source = rosterUser.role === "teacher" ? "login-teacher" : "login-student";
    }

    await regenerateSession(req);
    req.session.user = { username: authUser.username, role: authUser.role };
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
    return res.redirect("/login?error=session");
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

app.get("/logout", handleLogout);
app.post("/logout", handleLogout);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/me", requireAuth, (req, res) => {
  return res.json({
    username: req.session.user.username,
    role: req.session.user.role,
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
    const [rosterCounts, adminCount, loginCounts, todayCounts, recent] = await Promise.all([
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
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load admin stats" });
  }
});

app.get("/teacher", requireTeacher, (_req, res) => {
  res.sendFile(path.join(__dirname, "teacher.html"));
});

app.get("/api/notifications", requireAuth, async (_req, res) => {
  try {
    const rows = await all(
      `
        SELECT id, title, body, category, is_urgent, created_by, created_at
        FROM notifications
        ORDER BY created_at DESC, id DESC
      `
    );
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load notifications" });
  }
});

app.post("/api/notifications", requireTeacher, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim();
  const category = String(req.body.category || "General").trim() || "General";
  const isUrgent = req.body.isUrgent ? 1 : 0;

  if (!title || !body) {
    return res.status(400).json({ error: "Title and body are required." });
  }
  if (title.length > 120 || body.length > 2000 || category.length > 40) {
    return res.status(400).json({ error: "Notification field length is invalid." });
  }

  try {
    await run(
      `
        INSERT INTO notifications (title, body, category, is_urgent, created_by)
        VALUES (?, ?, ?, ?, ?)
      `,
      [title, body, category, isUrgent, req.session.user.username]
    );
    return res.status(201).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save notification." });
  }
});

app.get("/api/handouts", requireAuth, async (_req, res) => {
  try {
    const rows = await all(
      `
        SELECT id, title, description, file_url, created_by, created_at
        FROM handouts
        ORDER BY created_at DESC, id DESC
      `
    );
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load handouts" });
  }
});

app.post("/api/handouts", requireTeacher, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const fileUrl = String(req.body.fileUrl || "").trim();

  if (!title || !description) {
    return res.status(400).json({ error: "Title and description are required." });
  }
  if (title.length > 120 || description.length > 2000 || fileUrl.length > 500) {
    return res.status(400).json({ error: "Handout field length is invalid." });
  }
  if (fileUrl && !isValidHttpUrl(fileUrl)) {
    return res.status(400).json({ error: "File URL must start with http:// or https://." });
  }

  try {
    await run(
      `
        INSERT INTO handouts (title, description, file_url, created_by)
        VALUES (?, ?, ?, ?)
      `,
      [title, description, fileUrl || null, req.session.user.username]
    );
    return res.status(201).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save handout." });
  }
});

app.post("/api/admin/import/students", requireAdmin, async (req, res) => {
  const csvText = String(req.body.csvText || "");
  if (!csvText.trim()) {
    return res.status(400).json({ error: "Student CSV is required." });
  }

  try {
    const imported = await importRosterCsvText(csvText, "student", "matric_number", "admin-upload-students.csv");
    return res.status(200).json({ ok: true, imported });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Could not import student roster." });
  }
});

app.post("/api/admin/import/teachers", requireAdmin, async (req, res) => {
  const csvText = String(req.body.csvText || "");
  if (!csvText.trim()) {
    return res.status(400).json({ error: "Teacher CSV is required." });
  }

  try {
    const imported = await importRosterCsvText(csvText, "teacher", "teacher_code", "admin-upload-teachers.csv");
    return res.status(200).json({ ok: true, imported });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Could not import teacher roster." });
  }
});

app.get("/api/payment-links", requireAuth, async (_req, res) => {
  try {
    const rows = await all(
      `
        SELECT id, title, description, payment_url, created_by, created_at
        FROM payment_links
        ORDER BY created_at DESC, id DESC
      `
    );
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load payment links" });
  }
});

app.post("/api/payment-links", requireTeacher, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const paymentUrl = String(req.body.paymentUrl || "").trim();

  if (!title || !description || !paymentUrl) {
    return res.status(400).json({ error: "Title, description, and payment URL are required." });
  }
  if (title.length > 120 || description.length > 2000 || paymentUrl.length > 500) {
    return res.status(400).json({ error: "Payment link field length is invalid." });
  }
  if (!isValidHttpUrl(paymentUrl)) {
    return res.status(400).json({ error: "Payment URL must start with http:// or https://." });
  }

  try {
    await run(
      `
        INSERT INTO payment_links (title, description, payment_url, created_by)
        VALUES (?, ?, ?, ?)
      `,
      [title, description, paymentUrl, req.session.user.username]
    );
    return res.status(201).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save payment link." });
  }
});

app.get("/api/shared-files", requireAuth, async (_req, res) => {
  try {
    const rows = await all(
      `
        SELECT id, title, description, file_url, created_by, created_at
        FROM shared_files
        ORDER BY created_at DESC, id DESC
      `
    );
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load shared files" });
  }
});

app.post("/api/shared-files", requireTeacher, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();
  const fileUrl = String(req.body.fileUrl || "").trim();

  if (!title || !description || !fileUrl) {
    return res.status(400).json({ error: "Title, description, and file URL are required." });
  }
  if (title.length > 120 || description.length > 2000 || fileUrl.length > 500) {
    return res.status(400).json({ error: "Shared file field length is invalid." });
  }
  if (!isValidHttpUrl(fileUrl)) {
    return res.status(400).json({ error: "File URL must start with http:// or https://." });
  }

  try {
    await run(
      `
        INSERT INTO shared_files (title, description, file_url, created_by)
        VALUES (?, ?, ?, ?)
      `,
      [title, description, fileUrl, req.session.user.username]
    );
    return res.status(201).json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save shared file." });
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
