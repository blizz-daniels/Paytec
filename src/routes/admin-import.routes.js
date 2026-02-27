function registerAdminImportRoutes(app, deps) {
  const {
    requireAdmin,
    processRosterCsv,
  } = deps;

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

  app.post(["/api/admin/import/lecturers", "/api/admin/import/teachers"], requireAdmin, async (req, res) => {
    const csvText = String(req.body.csvText || "");
    if (!csvText.trim()) {
      return res.status(400).json({ error: "Lecturer CSV is required." });
    }

    try {
      const result = await processRosterCsv(csvText, {
        role: "teacher",
        idHeader: "teacher_code",
        sourceName: "admin-upload-lecturers.csv",
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
      return res.status(400).json({ error: err.message || "Could not import lecturer roster." });
    }
  });

  app.post(
    ["/api/admin/import/lecturers/preview", "/api/admin/import/teachers/preview"],
    requireAdmin,
    async (req, res) => {
      const csvText = String(req.body.csvText || "");
      if (!csvText.trim()) {
        return res.status(400).json({ error: "Lecturer CSV is required." });
      }

      try {
        const result = await processRosterCsv(csvText, {
          role: "teacher",
          idHeader: "teacher_code",
          sourceName: "admin-preview-lecturers.csv",
          applyChanges: false,
        });
        return res.status(200).json({
          ok: true,
          summary: result.summary,
          rows: result.rows,
          reportCsv: result.reportCsv,
        });
      } catch (err) {
        return res.status(400).json({ error: err.message || "Could not preview lecturer roster." });
      }
    }
  );
}

module.exports = {
  registerAdminImportRoutes,
};

