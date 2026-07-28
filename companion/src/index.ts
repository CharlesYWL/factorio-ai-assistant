import { parseCompanionPort, startCompanionServer } from "./server.js";

async function main(): Promise<void> {
  const port = parseCompanionPort(process.env.FACTORIO_ASSISTANT_COMPANION_PORT);
  const server = await startCompanionServer({ port });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.info(`Received ${signal}; closing companion.`);
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
