function registerHandoutRoutes(app, deps) {
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
    handoutUpload,
    broadcastContentUpdate,
    removeStoredContentFile,
    isValidHttpUrl,
    isValidLocalContentUrl,
  } = deps;

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
}

module.exports = {
  registerHandoutRoutes,
};

