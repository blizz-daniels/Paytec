function registerPageRoutes(app, deps) {
  const {
    path,
    PROJECT_ROOT,
    requireAuth,
    requireTeacher,
  } = deps;

  app.get("/", requireAuth, (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "index.html"));
  });

  app.get("/index.html", requireAuth, (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "index.html"));
  });

  app.get("/notifications.html", requireAuth, (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "notifications.html"));
  });

  app.get("/handouts.html", requireAuth, (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "handouts.html"));
  });

  app.get("/payments", requireAuth, (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "payments.html"));
  });

  app.get("/payments.html", requireAuth, (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "payments.html"));
  });

  app.get("/messages", requireAuth, (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "messages.html"));
  });

  app.get("/analytics", requireTeacher, (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "analytics.html"));
  });
}

module.exports = {
  registerPageRoutes,
};

