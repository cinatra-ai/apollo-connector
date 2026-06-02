import path from "node:path";

// Dependency-free leaf module — see openai-connector/src/log-directory.ts for the
// ESM init-order cycle this breaks (logging.ts reads this at module-init).
export const APOLLO_API_LOG_DIRECTORY = path.join(process.cwd(), "data", "logs", "apollo-api");
