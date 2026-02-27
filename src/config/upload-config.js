function createUploadHandlers(options = {}) {
  const multer = options.multer;
  const path = options.path;
  const crypto = options.crypto;
  const usersDir = options.usersDir;
  const receiptsDir = options.receiptsDir;
  const statementsDir = options.statementsDir;
  const handoutsFilesDir = options.handoutsFilesDir;
  const sharedFilesUploadDir = options.sharedFilesUploadDir;

  if (!multer || !path || !crypto) {
    throw new Error("createUploadHandlers requires multer, path, and crypto.");
  }
  if (!usersDir || !receiptsDir || !statementsDir || !handoutsFilesDir || !sharedFilesUploadDir) {
    throw new Error("createUploadHandlers requires all upload directories.");
  }

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

  return {
    avatarUpload,
    receiptUpload,
    statementUpload,
    handoutUpload,
    sharedFileUpload,
  };
}

module.exports = {
  createUploadHandlers,
};
