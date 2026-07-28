import { loadCompanionConfig } from "./config.js";
import { JsonLogger } from "./logger.js";
import { COMPANION_VERSION, startCompanionServer } from "./server.js";

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${COMPANION_VERSION}\n`);
    return;
  }
  if (args.length > 0) {
    throw new Error(`Unknown command-line option ${args[0]}`);
  }

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
  await main(process.argv.slice(2));
} catch (error: unknown) {
  new JsonLogger().error("companion_start_failed", {
    error_name: error instanceof Error ? error.name : "unknown",
    error_message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
