const { startServer } = require("./app");

startServer().catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});