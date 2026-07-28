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
for (const packetType of [
  "assistant_request",
  "assistant_cancel",
  "assistant_response",
  "calculation_request",
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
  /localised_name/u.test(localizationSource) && /localised_name/u.test(uiSource),
  "Prototype display names must come from the prototype localised_name",
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
  "complete_chat",
  "queue_calculation",
  "complete_calculation",
  "expire_requests",
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
