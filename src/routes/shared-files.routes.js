function registerSharedFileRoutes(app, deps) {
  const {
    fs,
    all,
    run,
    parseReactionDetails,
    parseResourceId,
    requireAuth,
    requireTeacher,
    ensureCanManageContent,
    logAuditEvent,
    sharedFileUpload,
    broadcastContentUpdate,
    removeStoredContentFile,
    isValidHttpUrl,
    isValidLocalContentUrl,
  } = deps;

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
}

module.exports = {
  registerSharedFileRoutes,
};

