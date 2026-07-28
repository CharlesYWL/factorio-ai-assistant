import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import luaparse from "luaparse";

const modDirectory = fileURLToPath(new URL("../factorio-mod/", import.meta.url));
const infoPath = new URL("../factorio-mod/info.json", import.meta.url);

const info = JSON.parse(await readFile(infoPath, "utf8"));
assert.equal(info.factorio_version, "2.0", "info.json must target Factorio 2.0");
assert.deepEqual(
  info.dependencies,
  ["base >= 2.0"],
  "The mod may only depend on base >= 2.0",
);

const luaFiles = (await readdir(modDirectory))
  .filter((fileName) => fileName.endsWith(".lua"))
  .sort();

for (const fileName of luaFiles) {
  const source = await readFile(new URL(`../factorio-mod/${fileName}`, import.meta.url), "utf8");
  luaparse.parse(source, { luaVersion: "5.2" });
}

const controlSource = await readFile(
  new URL("../factorio-mod/control.lua", import.meta.url),
  "utf8",
);
const collectorSource = await readFile(
  new URL("../factorio-mod/state_collector.lua", import.meta.url),
  "utf8",
);
const uiSource = await readFile(
  new URL("../factorio-mod/ui.lua", import.meta.url),
  "utf8",
);
const uiStateSource = await readFile(
  new URL("../factorio-mod/ui_state.lua", import.meta.url),
  "utf8",
);
const dataSource = await readFile(
  new URL("../factorio-mod/data.lua", import.meta.url),
  "utf8",
);
const englishLocale = await readFile(
  new URL("../factorio-mod/locale/en/locale.cfg", import.meta.url),
  "utf8",
);
const chineseLocale = await readFile(
  new URL("../factorio-mod/locale/zh-CN/locale.cfg", import.meta.url),
  "utf8",
);

for (const requiredApi of [
  "helpers.send_udp",
  "helpers.recv_udp",
  "defines.events.on_udp_packet_received",
]) {
  assert.ok(controlSource.includes(requiredApi), `control.lua must use ${requiredApi}`);
}

assert.doesNotMatch(
  controlSource,
  /defines\.events\.on_tick\b/,
  "The collector must not run a per-tick handler",
);
assert.doesNotMatch(
  controlSource,
  /script\.on_event\(\s*\{[^}]*\}\s*,\s*[^,()]+\s*,\s*[^)]+\)/su,
  "Filtered Factorio events must be registered one at a time",
);
assert.ok(
  collectorSource.includes('type = "electric-pole"'),
  "The one-time entity scan must be restricted to electric poles",
);
assert.ok(
  collectorSource.includes("#encoded > MAX_PACKET_BYTES"),
  "State packets must enforce the byte hard limit",
);
assert.ok(
  collectorSource.includes("omitted_series"),
  "Dynamic truncation must report omitted series",
);
assert.ok(
  controlSource.includes("game.create_profiler()"),
  "Dynamic sampling must record collection duration",
);
assert.ok(
  controlSource.includes("local function run_every_second_tasks()")
    && controlSource.includes("maybe_send_dynamic_snapshot()\n  update_connection_status()")
    && controlSource.includes(
      "script.on_nth_tick(UI_REFRESH_INTERVAL_TICKS, run_every_second_tasks)",
    ),
  "Dynamic sampling and UI refresh must share the single 60-tick handler",
);
for (const packetType of [
  "assistant_request",
  "assistant_cancel",
  "assistant_response",
  "calculation_request",
  "calculation_response",
]) {
  assert.ok(
    controlSource.includes(packetType),
    `control.lua must handle ${packetType}`,
  );
}
for (const transition of [
  "queue_chat",
  "clear_chat",
  "complete_chat",
  "queue_calculation",
  "complete_calculation",
  "expire_requests",
  "dismiss_alert",
  "restore_alert",
  "is_alert_dismissed",
  "forget_alert",
]) {
  assert.ok(
    uiStateSource.includes(`function ui_state.${transition}`),
    `ui_state.lua must define ${transition}`,
  );
}
const appendChatDeclaration = uiStateSource.indexOf("local append_chat");
assert.ok(
  appendChatDeclaration >= 0
    && appendChatDeclaration
      < uiStateSource.indexOf("function ui_state.queue_chat"),
  "append_chat must be declared before UI state transitions capture it",
);
assert.ok(
  uiSource.includes("player.gui.screen"),
  "The advisor panel must use a movable screen GUI",
);
assert.ok(
  uiSource.includes("scroll_to_bottom()"),
  "The chat pane must be able to snap back to the newest message",
);
assert.ok(
  uiSource.includes("mod_gui.get_frame_flow"),
  "The persistent alert list must live in the top-left mod frame flow",
);
assert.ok(
  uiSource.includes("function ui.refresh_alerts_hud"),
  "ui.lua must expose the persistent alert list refresh",
);
for (const action of ["clear-chat", "dismiss-alert", "restore-alert"]) {
  assert.ok(
    controlSource.includes(`action == "${action}"`),
    `control.lua must handle the ${action} GUI action`,
  );
}
assert.ok(
  controlSource.includes("factorio-ai-assistant-mock"),
  "The in-game UI mock harness must stay available",
);
assert.ok(
  controlSource.includes("component_version_mismatch")
    && controlSource.includes("protocol_mismatch"),
  "The Mod must surface component and protocol version mismatches",
);
for (const input of [
  "factorio-ai-assistant-toggle-input",
  "factorio-ai-assistant-tab-1",
  "factorio-ai-assistant-tab-2",
  "factorio-ai-assistant-tab-3",
  "factorio-ai-assistant-tab-4",
]) {
  assert.ok(dataSource.includes(input), `data.lua must declare ${input}`);
}
assert.deepEqual(
  localeKeys(chineseLocale),
  localeKeys(englishLocale),
  "zh-CN and English locale files must expose the same keys",
);

console.log(`Factorio mod lint passed (${luaFiles.length} Lua files).`);

function localeKeys(source) {
  let section = "";
  const keys = [];
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1];
      continue;
    }
    const separator = line.indexOf("=");
    if (separator > 0) {
      keys.push(`${section}/${line.slice(0, separator)}`);
    }
  }
  return keys.sort();
}
