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

for (const requiredApi of [
  "helpers.send_udp",
  "helpers.recv_udp",
  "defines.events.on_udp_packet_received",
]) {
  assert.ok(controlSource.includes(requiredApi), `control.lua must use ${requiredApi}`);
}

console.log(`Factorio mod lint passed (${luaFiles.length} Lua files).`);
