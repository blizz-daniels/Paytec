const { app, initDatabase, db, run, get, all, startServer } = require("./src/app");

if (require.main === module) {
  startServer().catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
}

module.exports = {
  app,
  initDatabase,
  db,
  run,
  get,
  all,
};