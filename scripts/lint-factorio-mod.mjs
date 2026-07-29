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
const pauseSource = await readFile(
  new URL("../factorio-mod/pause.lua", import.meta.url),
  "utf8",
);
const settingsSource = await readFile(
  new URL("../factorio-mod/settings.lua", import.meta.url),
  "utf8",
);
const localizationSource = await readFile(
  new URL("../factorio-mod/localization.lua", import.meta.url),
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
  "sanitize_suggested_actions",
  "add_todo",
  "has_todo",
  "set_todo_completed",
  "delete_todo",
  "clear_completed_todos",
  "clear_todos",
  "open_todo_count",
  "sorted_todos",
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
  "add-todo",
  "complete-todo",
  "restore-todo",
  "delete-todo",
  "clear-completed-todos",
  "clear-todos",
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

// A todo may only ever appear because the player clicked "add to todo": the
// packet path must stop at storing the suggestion on the chat entry.
assert.equal(
  countOccurrences(controlSource, "ui_state.add_todo("),
  2,
  "Only adopt_suggested_action and the UI mock may create a todo",
);
for (const writer of [
  "ui_state.set_todo_completed(",
  "ui_state.delete_todo(",
  "ui_state.clear_completed_todos(",
  "ui_state.clear_todos(",
]) {
  assert.doesNotMatch(
    controlSource.slice(
      0,
      controlSource.indexOf("local function refresh_todo_views"),
    ),
    new RegExp(writer.replace(/[.()]/gu, "\\$&"), "u"),
    `${writer} must only be reachable from a GUI click handler`,
  );
}
assert.ok(
  controlSource.includes("payload.suggested_actions ~= nil")
    && controlSource.includes(
      'type(payload.suggested_actions) ~= "table"',
    ),
  "control.lua must validate the optional suggested_actions field on the wire",
);
assert.ok(
  uiStateSource.includes("local MAX_TODOS")
    && uiStateSource.includes("#player_state.todos >= MAX_TODOS"),
  "ui_state.lua must cap the todo list",
);
assert.ok(
  uiStateSource.includes("player_state.todos = player_state.todos or {}"),
  "ui_state.lua must migrate a save written before todos existed",
);
assert.ok(
  uiSource.includes("ui_state.open_todo_count(player_state)"),
  "The persistent HUD must surface the open todo count",
);
assert.doesNotMatch(
  uiSource,
  /open_todos[\s\S]{0,400}ui\.show_toast/u,
  "Todos must never raise a toast",
);

// Auto-pause is only correct while exactly one open path and one close path own
// the claim, so control.lua must funnel every entry point through its helpers.
for (const helper of ["open_advisor", "close_advisor", "toggle_advisor"]) {
  assert.ok(
    controlSource.includes(`local function ${helper}(player)`),
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
  "suggested-actions",
  "add-todo",
  "add-todo-tooltip",
  "todo-added",
  "todo-added-tooltip",
  "todo-limit-reached",
  "todos-title",
  "todos-empty",
  "todo-meta",
  "todo-source-guide",
  "todo-source-alert",
  "todo-source-calculation",
  "todo-source-model",
  "todo-complete",
  "todo-restore",
  "todo-delete",
  "todo-clear-completed",
  "todo-clear-all",
  "todos-cleared",
  "todo-hud-title",
  "todo-hud-open",
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
