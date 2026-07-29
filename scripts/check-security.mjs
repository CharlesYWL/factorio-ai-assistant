import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [
  configSource,
  serverSource,
  assistantSource,
  loggerSource,
  protocolSource,
  controlSource,
  collectorSource,
  exampleConfigSource,
  gitignore,
  startPowerShell,
  startCmd,
] = await Promise.all([
  read("companion/src/config.ts"),
  read("companion/src/server.ts"),
  read("companion/src/assistant-service.ts"),
  read("companion/src/logger.ts"),
  read("packages/protocol/src/index.ts"),
  read("factorio-mod/control.lua"),
  read("factorio-mod/state_collector.lua"),
  read("companion.config.example.json"),
  read(".gitignore"),
  read("distribution/windows/start-companion.ps1"),
  read("distribution/windows/start-companion.cmd"),
]);
const exampleConfig = JSON.parse(exampleConfigSource);

assert.match(configSource, /LOOPBACK_HOST = "127\.0\.0\.1"/u);
assert.match(configSource, /host !== LOOPBACK_HOST/u);
assert.match(serverSource, /socket\.bind\(\{\s*address: LOOPBACK_HOST,/u);
assert.match(serverSource, /remote\.address !== LOOPBACK_HOST/u);
assert.doesNotMatch(`${configSource}\n${serverSource}`, /0\.0\.0\.0/u);

assert.equal(exampleConfig.host, "127.0.0.1");
assert.ok(!Object.hasOwn(exampleConfig, "api_key"), "Example config must not contain an API key");
assert.match(gitignore, /^\.env$/mu);
assert.match(gitignore, /^\.env\.\*$/mu);
assert.doesNotMatch(`${startPowerShell}\n${startCmd}`, /FACTORIO_ASSISTANT_API_KEY/u);
assert.match(assistantSource, /config\.apiKey === undefined[\s\S]*!isLoopbackUrl/u);

for (const sensitiveName of [
  "api.?key",
  "authorization",
  "context",
  "prompt",
  "question",
  "secret",
  "state",
  "token",
]) {
  assert.ok(loggerSource.includes(sensitiveName), `Logger must redact ${sensitiveName}`);
}
assert.match(loggerSource, /Bearer\\s\+/u);
assert.match(loggerSource, /sk-/u);

assert.match(protocolSource, /MAX_PACKET_BYTES = 16 \* 1024/u);
assert.match(controlSource, /MAX_PACKET_BYTES = 16 \* 1024/u);
assert.match(collectorSource, /MAX_PACKET_BYTES = 16 \* 1024/u);
assert.match(controlSource, /#question > 4096/u);
assert.match(controlSource, /utf8_length\(question\) > 2000/u);
assert.match(serverSource, /MAX_ASSISTANT_RESPONSE_BYTES = 8_000/u);

// Suggestions become clickable in-game todos, so they may never be a raw
// provider field: only reconciled model lines and deterministic grounded
// actions reach the wire, and both are re-checked for length and safety.
assert.match(
  assistantSource,
  /function sanitizeSuggestedActionText[\s\S]*?MAX_SUGGESTED_ACTION_TEXT_CHARACTERS[\s\S]*?containsExecutableInstruction\(text\)/u,
);
assert.match(
  assistantSource,
  /collectSuggestedActions\(\s*grounding,\s*reconciled\.lines,\s*\)/u,
);
assert.match(assistantSource, /collectSuggestedActions\(grounding, \[\]\)/u);
assert.match(protocolSource, /MAX_SUGGESTED_ACTIONS = 3/u);
assert.match(protocolSource, /MAX_SUGGESTED_ACTION_TEXT_CHARACTERS = 240/u);
assert.match(controlSource, /type\(payload\.suggested_actions\) ~= "table"/u);

console.log(
  "Security/privacy checks passed (loopback bind, credential handling, redaction, and message limits).",
);

function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}
