import { loadCompanionConfig } from "./config.js";
import { JsonLogger } from "./logger.js";
import { startCompanionServer } from "./server.js";

async function main(): Promise<void> {
  const config = await loadCompanionConfig();
  const logger = new JsonLogger();
  const server = await startCompanionServer({ config, logger });
  const status = server.assistant.status;
  logger.info("assistant_mode", {
    mode: status.mode,
    provider: status.provider,
    model: status.model,
    reason: status.reason,
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info("companion_shutdown", { signal });
    await server.close();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

try {
  await main();
} catch (error: unknown) {
  new JsonLogger().error("companion_start_failed", {
    error_name: error instanceof Error ? error.name : "unknown",
    error_message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
