import assert from "node:assert/strict";
import test from "node:test";

import { JsonLogger } from "./logger.js";

void test("emits structured logs with sensitive fields and tokens redacted", () => {
  const lines: string[] = [];
  const logger = new JsonLogger(
    { write: (line) => lines.push(line) },
    () => new Date("2026-07-28T00:00:00.000Z"),
  );

  logger.warn("provider Bearer top-secret", {
    request_id: "assistant-1",
    api_key: "sk-supersecret123",
    authorization: "Bearer top-secret",
    message: "request failed for sk-anothersecret456",
    state_summary: "full factory state",
  });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(record.timestamp, "2026-07-28T00:00:00.000Z");
  assert.equal(record.level, "warn");
  assert.equal(record.event, "provider [REDACTED]");
  assert.equal(record.request_id, "assistant-1");
  assert.equal(record.api_key, "[REDACTED]");
  assert.equal(record.authorization, "[REDACTED]");
  assert.equal(record.message, "request failed for [REDACTED]");
  assert.equal(record.state_summary, "[REDACTED]");
});
