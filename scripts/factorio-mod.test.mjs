import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { lauxlib, lua, lualib, to_luastring } from "fengari";

const modDirectory = new URL("../factorio-mod/", import.meta.url);
const luaDirectory = new URL("./lua/", import.meta.url);

const SPEC_NAMES = ["pause_spec", "alerts_spec", "integration_spec"];

const modSources = await readLuaDirectory(modDirectory);
const testSources = await readLuaDirectory(luaDirectory);

for (const specName of SPEC_NAMES) {
  assert.ok(testSources[specName] !== undefined, `missing spec ${specName}`);
}

const report = runLuaSpecs();
assert.ok(report.length > 0, "The Lua specs must report at least one result");

for (const line of report) {
  const [outcome, name, message] = line.split("\t");
  test(`factorio-mod: ${name}`, () => {
    assert.equal(outcome, "PASS", message);
  });
}

function runLuaSpecs() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  pushStringTable(L, modSources);
  lua.lua_setglobal(L, to_luastring("MOD_SOURCES"));
  pushStringTable(L, testSources);
  lua.lua_setglobal(L, to_luastring("TEST_SOURCES"));
  pushStringArray(L, SPEC_NAMES);
  lua.lua_setglobal(L, to_luastring("SPEC_NAMES"));

  const loadStatus = lauxlib.luaL_loadbuffer(
    L,
    to_luastring(testSources.run_specs, true),
    null,
    to_luastring("@run_specs.lua"),
  );
  assert.equal(loadStatus, lua.LUA_OK, `Lua load failed: ${lua.lua_tojsstring(L, -1)}`);

  const callStatus = lua.lua_pcall(L, 0, 1, 0);
  assert.equal(callStatus, lua.LUA_OK, `Lua run failed: ${lua.lua_tojsstring(L, -1)}`);

  const output = lua.lua_tojsstring(L, -1) ?? "";
  return output.split("\n").filter((line) => line.length > 0);
}

function pushStringTable(L, entries) {
  const keys = Object.keys(entries);
  lua.lua_createtable(L, 0, keys.length);
  for (const key of keys) {
    lua.lua_pushstring(L, to_luastring(entries[key], true));
    lua.lua_setfield(L, -2, to_luastring(key));
  }
}

function pushStringArray(L, values) {
  lua.lua_createtable(L, values.length, 0);
  for (const [index, value] of values.entries()) {
    lua.lua_pushstring(L, to_luastring(value, true));
    lua.lua_seti(L, -2, index + 1);
  }
}

async function readLuaDirectory(directory) {
  const fileNames = (await readdir(directory))
    .filter((fileName) => fileName.endsWith(".lua"))
    .sort();
  const sources = {};
  for (const fileName of fileNames) {
    sources[fileName.slice(0, -".lua".length)] = await readFile(
      new URL(fileName, directory),
      "utf8",
    );
  }
  return sources;
}
