#!/usr/bin/env node
// Development watcher: incrementally compiles the TypeScript project and
// restarts the companion process whenever emitted JavaScript changes.
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { stopCompanionProcesses } from "./lib/companion-processes.mjs";

const RESTART_DEBOUNCE_MS = 300;
const SHUTDOWN_GRACE_MS = 3_000;
// The previous companion may still hold the UDP port for a moment after exiting,
// so a failed start is retried with a widening delay instead of leaving the game
// without a listener.
const BIND_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPath = path.join(root, "companion", "dist", "index.js");
const watchRoots = [
  path.join(root, "companion", "dist"),
  path.join(root, "packages", "protocol", "dist"),
  path.join(root, "packages", "calculator", "dist"),
  path.join(root, "packages", "guide", "dist"),
];

const configPath = resolveConfigPath();
const compilerPath = path.join(root, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(compilerPath)) {
  process.stderr.write(
    "[dev] TypeScript is not installed. Run `npm install` first.\n",
  );
  process.exit(1);
}

let companionProcess = null;
let restartTimer = null;
let restarting = false;
let restartPending = false;
let shuttingDown = false;
let bindRetries = 0;
let bindRetryTimer = null;

log(`config: ${configPath ?? "(none — defaults + environment only)"}`);

// A companion orphaned by an earlier crashed watcher keeps the port and
// silently swallows every packet the game sends.
stopCompanionProcesses(process.pid, log);

const compiler = spawn(
  process.execPath,
  [compilerPath, "-b", "--watch", "--preserveWatchOutput"],
  { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
);
compiler.on("exit", (code) => {
  if (shuttingDown) return;
  log(`tsc watcher exited with code ${code}; stopping dev mode`);
  void shutdown(code ?? 1);
});

for (const directory of watchRoots) {
  watchDirectory(directory);
}

scheduleRestart();

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

function watchDirectory(directory) {
  if (!existsSync(directory)) {
    // The directory only appears after the first successful compile; poll for
    // it, then trigger a restart since its files were written before we
    // attached the watcher.
    const poll = setInterval(() => {
      if (shuttingDown) {
        clearInterval(poll);
        return;
      }
      if (!existsSync(directory)) return;
      clearInterval(poll);
      watchDirectory(directory);
      scheduleRestart();
    }, 500);
    poll.unref();
    return;
  }

  const watcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (typeof filename === "string" && !filename.endsWith(".js")) return;
    scheduleRestart();
  });
  watcher.on("error", (error) => {
    log(`watch error on ${path.relative(root, directory)}: ${error.message}`);
  });
}

function scheduleRestart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => void restartCompanion(), RESTART_DEBOUNCE_MS);
}

async function restartCompanion() {
  if (shuttingDown) return;
  // A rebuild touches several output directories at once, so restarts can be
  // requested while one is already running. Remember that another is due and
  // run it after, rather than dropping it or starting a second companion that
  // would collide on the port.
  if (restarting) {
    restartPending = true;
    return;
  }
  restarting = true;

  try {
    do {
      restartPending = false;
      bindRetries = 0;
      clearTimeout(bindRetryTimer);
      await stopCompanion();
      if (shuttingDown) return;
      if (!existsSync(entryPath)) {
        log("waiting for the first successful compile…");
        return;
      }
      startCompanion();
    } while (restartPending && !shuttingDown);
  } finally {
    restarting = false;
  }
}

function startCompanion() {
  const env = { ...process.env };
  if (configPath !== undefined) {
    env.FACTORIO_ASSISTANT_CONFIG = configPath;
  }

  log("starting companion");
  const child = spawn(process.execPath, [entryPath], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env,
  });
  companionProcess = child;
  const startedAt = Date.now();
  // Surviving this long means it bound the port, so earlier failures are history.
  const healthyTimer = setTimeout(() => {
    if (companionProcess === child) {
      bindRetries = 0;
    }
  }, 5_000);
  healthyTimer.unref();
  child.on("exit", (code, signal) => {
    clearTimeout(healthyTimer);
    // A child replaced by a newer start is none of this handler's business.
    if (companionProcess !== child) return;
    companionProcess = null;

    if (shuttingDown || restarting) return;
    log(`companion exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);

    // Exiting almost immediately means it never got to serve traffic; the usual
    // cause is the previous process still releasing the port.
    if (code === 0 || Date.now() - startedAt > 5_000) {
      bindRetries = 0;
      return;
    }
    if (bindRetries >= BIND_RETRY_DELAYS_MS.length) {
      log(
        "!! companion is NOT running — the game will get no answers or reminders.",
      );
      log("!! another process is holding UDP 34197. Run `npm run dev:stop`.");
      return;
    }
    const delay = BIND_RETRY_DELAYS_MS[bindRetries];
    bindRetries += 1;
    log(
      `retrying start in ${delay}ms ` +
        `(${bindRetries}/${BIND_RETRY_DELAYS_MS.length})…`,
    );
    clearTimeout(bindRetryTimer);
    bindRetryTimer = setTimeout(() => {
      // A rebuild may have started a fresh companion while this retry waited.
      if (shuttingDown || companionProcess !== null) return;
      // Whatever holds the port is not a child we track, so it can only be an
      // orphan from an earlier watcher.
      stopCompanionProcesses(process.pid, log);
      startCompanion();
    }, delay);
  });
}

function stopCompanion() {
  const child = companionProcess;
  if (child === null || child.exitCode !== null) {
    companionProcess = null;
    return Promise.resolve();
  }

  companionProcess = null;
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, SHUTDOWN_GRACE_MS);
    forceTimer.unref();

    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  clearTimeout(bindRetryTimer);

  await stopCompanion();
  if (compiler.exitCode === null) {
    compiler.kill("SIGTERM");
  }
  process.exit(exitCode);
}

function resolveConfigPath() {
  const explicit = process.env.FACTORIO_ASSISTANT_CONFIG?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const candidates = [
    path.join(root, "companion.config.local.json"),
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "FactorioAI Assistant",
      "factorio-ai-assistant-companion-0.1.0",
      "companion.config.json",
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function log(message) {
  process.stdout.write(`[dev] ${message}\n`);
}
