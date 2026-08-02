import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import luaparse from "luaparse";

const modDirectory = fileURLToPath(new URL("../factorio-mod/", import.meta.url));
const infoPath = new URL("../factorio-mod/info.json", import.meta.url);

/**
 * Reads mod source with line endings normalized to LF. Checkouts on Windows
 * use CRLF, which silently breaks any assertion whose literal spans a newline.
 */
async function readSource(relativePath) {
  const source = await readFile(
    new URL(`../factorio-mod/${relativePath}`, import.meta.url),
    "utf8",
  );
  return source.replace(/\r\n/gu, "\n");
}

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

const controlSource = await readSource("control.lua");
const collectorSource = await readSource("state_collector.lua");
const uiSource = await readSource("ui.lua");
const uiStateSource = await readSource("ui_state.lua");
const pauseSource = await readSource("pause.lua");
const settingsSource = await readSource("settings.lua");
const localizationSource = await readSource("localization.lua");
const dataSource = await readSource("data.lua");
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
// The point is that periodic work shares one handler rather than each feature
// registering its own timer, not the exact order of calls inside it.
const everySecondBody = controlSource.match(
  /local function run_every_second_tasks\(\)\n([\s\S]*?)\nend\n/u,
)?.[1];
assert.ok(
  everySecondBody !== undefined
    && everySecondBody.includes("maybe_send_dynamic_snapshot()")
    && everySecondBody.includes("update_connection_status()")
    && controlSource.includes(
      "script.on_nth_tick(UI_REFRESH_INTERVAL_TICKS, run_every_second_tasks)",
    ),
  "Dynamic sampling and UI refresh must share the single 60-tick handler",
);
assert.equal(
  (controlSource.match(/script\.on_nth_tick\(/gu) ?? []).length,
  3,
  "Periodic work must stay on the existing timers rather than adding new ones",
);
for (const packetType of [
  "assistant_request",
  "assistant_cancel",
  "assistant_response",
  "calculation_response",
  "localization_update",
]) {
  assert.ok(
    controlSource.includes(packetType) || localizationSource.includes(packetType),
    `The Mod must handle ${packetType}`,
  );
}
for (const requiredApi of [
  "request_translation",
  "defines.events.on_string_translated",
]) {
  assert.ok(
    controlSource.includes(requiredApi) || localizationSource.includes(requiredApi),
    `Display names must use the official ${requiredApi} translation path`,
  );
}
assert.ok(
  localizationSource.includes("#encoded > MAX_PACKET_BYTES"),
  "Localization packets must enforce the byte hard limit",
);
assert.ok(
  /localised_name/u.test(localizationSource),
  "Prototype display names must come from the prototype localised_name",
);
assert.doesNotMatch(
  uiSource,
  /CALCULATOR_|render_calculator\b/u,
  "The player-facing calculator form must stay removed; chat drives calculations",
);
assert.doesNotMatch(
  controlSource,
  /calculation_request/u,
  "The Mod must not send calculation requests now that chat owns calculations",
);
for (const seededId of [
  "iron-plate",
  "copper-plate",
  "steel-plate",
  "electronic-circuit",
  "advanced-circuit",
  "processing-unit",
  "automation-science-pack",
  "logistic-science-pack",
  "military-science-pack",
  "chemical-science-pack",
  "production-science-pack",
  "utility-science-pack",
  "space-science-pack",
  "crude-oil",
  "heavy-oil",
  "light-oil",
  "petroleum-gas",
  "lubricant",
  "assembling-machine-2",
]) {
  assert.ok(
    localizationSource.includes(`id = "${seededId}"`),
    `localization.lua must seed a display name request for ${seededId}`,
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
  "pending_alerts",
  "dismiss_all_alerts",
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
for (const action of [
  "clear-chat",
  "dismiss-alert",
  "restore-alert",
  "clear-alerts",
]) {
  assert.ok(
    controlSource.includes(`action == "${action}"`),
    `control.lua must handle the ${action} GUI action`,
  );
}
assert.ok(
  uiSource.includes('tags = { action = "clear-alerts" }'),
  "The Alerts tab and the persistent alert card must offer a clear-all action",
);
assert.equal(
  countOccurrences(uiSource, 'action = "clear-alerts"'),
  2,
  "Clear-all must be offered both on the Alerts tab and on the persistent card",
);

// Auto-pause is only correct while exactly one open path and one close path own
// the claim, so control.lua must funnel every entry point through its helpers.
for (const helper of ["open_advisor", "close_advisor", "toggle_advisor"]) {
  assert.ok(
    new RegExp(`local function ${helper}\\(player[,)]`, "u").test(controlSource),
    `control.lua must define ${helper}`,
  );
}
assert.equal(
  countOccurrences(controlSource, "ui.open("),
  1,
  "control.lua may only call ui.open from open_advisor",
);
assert.equal(
  countOccurrences(controlSource, "ui.close("),
  1,
  "control.lua may only call ui.close from close_advisor",
);
assert.doesNotMatch(
  uiSource,
  /function ui\.toggle\b/u,
  "ui.lua must not expose a second toggle path that skips the pause handling",
);
assert.ok(
  uiSource.includes("player.opened = frame"),
  "The advisor panel must register as the opened GUI so ESC raises on_gui_closed",
);
for (const cleanup of [
  "defines.events.on_player_left_game",
  "defines.events.on_player_removed",
]) {
  assert.ok(
    controlSource.includes(cleanup),
    `control.lua must release the auto-pause claim on ${cleanup}`,
  );
}
assert.ok(
  controlSource.includes("pause.reconcile(get_state())"),
  "control.lua must reconcile a stale pause claim from the periodic handler",
);
assert.ok(
  pauseSource.includes("game.is_multiplayer()"),
  "pause.lua must gate auto-pause on single player",
);
for (const source of [controlSource, uiSource, uiStateSource]) {
  assert.doesNotMatch(
    source,
    /game\.tick_paused/u,
    "Only pause.lua may read or write game.tick_paused",
  );
}
assert.match(
  settingsSource,
  /name = "factorio-ai-assistant-auto-pause-on-open",\s*setting_type = "runtime-per-user",\s*default_value = true,/u,
  "Auto-pause must ship as a per-player runtime setting that defaults to on",
);
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
]) {
  assert.ok(dataSource.includes(input), `data.lua must declare ${input}`);
}
for (const localeKey of [
  "clear-alerts",
  "clear-alerts-tooltip",
  "alerts-cleared",
  "status-auto-pause",
  "auto-pause-on",
  "auto-pause-off",
  "auto-pause-multiplayer",
  "factorio-ai-assistant-auto-pause-on-open",
]) {
  assert.ok(
    englishLocale.includes(`\n${localeKey}=`),
    `The locale files must define ${localeKey}`,
  );
}
assert.deepEqual(
  localeKeys(chineseLocale),
  localeKeys(englishLocale),
  "zh-CN and English locale files must expose the same keys",
);

console.log(`Factorio mod lint passed (${luaFiles.length} Lua files).`);

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

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
