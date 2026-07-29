/**
 * Offline gate for `compat/todo-list`.
 *
 * The patch under `compat/todo-list/patches` is the single source of truth for
 * the upstream `todo_list` remote interface, so this test reads the Lua out of
 * the patch itself, parses it and then runs it against a stand-in for the small
 * part of the Factorio API the interface touches. Nothing here needs the
 * network or a checkout of the third party mod.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { lauxlib, lua, lualib, to_luastring } from "fengari";
import luaparse from "luaparse";

const compatDirectory = new URL("../compat/todo-list/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("upstream.json", compatDirectory), "utf8"));
const patchSource = await readFile(
  new URL(manifest.patches[0], compatDirectory),
  "utf8",
);
const readme = await readFile(new URL("README.md", compatDirectory), "utf8");

const addedFiles = collectAddedFiles(patchSource);
const interfaceSource = requireAddedFile("src/todo/features/remote_interface.lua");
const specSource = requireAddedFile("spec/remote_interface_spec.lua");

function requireAddedFile(name) {
  const source = addedFiles.get(name);
  assert.equal(typeof source, "string", `The patch must add ${name}`);
  assert.ok(source.length > 200, `The patch must add a non-trivial ${name}`);
  return source;
}

test("compat/todo-list: the patch pins the reviewed upstream revision", () => {
  assert.match(manifest.upstream.commit, /^[0-9a-f]{40}$/u);
  assert.equal(manifest.upstream.tag, `v${manifest.upstream.version}`);
  assert.equal(manifest.upstream.license, "MIT");
  assert.equal(manifest.upstream_contribution.status, "not-submitted");
  assert.ok(
    readme.includes(manifest.upstream.commit),
    "The README must record the upstream commit for provenance",
  );
});

test("compat/todo-list: the patch only touches the files it claims to", () => {
  const touched = [...patchSource.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)].map(
    ([, left, right]) => {
      assert.equal(left, right, "The patch must not rename files");
      return left;
    },
  );

  assert.deepEqual(touched.slice().sort(), [
    ".luacheckrc",
    "README.md",
    "changelog.txt",
    "spec/remote_interface_spec.lua",
    "src/control.lua",
    "src/info.json",
    "src/todo/features/remote_interface.lua",
    "src/todo/todo.lua",
  ]);
});

test("compat/todo-list: the patch bumps the upstream mod version", () => {
  assert.ok(
    patchSource.includes(`-  "version": "${manifest.upstream.version}"`),
    "The patch must start from the pinned upstream version",
  );
  assert.ok(
    patchSource.includes(`+  "version": "${manifest.patched.version}"`),
    "The patch must set the patched version recorded in upstream.json",
  );
});

test("compat/todo-list: the patch registers the interface at control.lua load time", () => {
  assert.ok(patchSource.includes("+todo.register_remote_interface()"));
  assert.ok(patchSource.includes('+require("todo/features/remote_interface")'));
  assert.ok(
    patchSource.includes('"storage", "remote"}'),
    "luacheck must learn about the remote global",
  );
});

test("compat/todo-list: the added Lua parses as Factorio-compatible Lua", () => {
  for (const source of [interfaceSource, specSource]) {
    luaparse.parse(source, { luaVersion: "5.2" });
  }
});

test("compat/todo-list: every error code is implemented, specced and documented", () => {
  const declared = new Set(manifest.remote_interface.errors);
  const implemented = new Set([
    ...[...interfaceSource.matchAll(/failure\(\s*"([a-z_]+)"/gu)].map(([, code]) => code),
    ...[...interfaceSource.matchAll(/_error = "([a-z_]+)"/gu)].map(([, code]) => code),
  ]);

  assert.deepEqual(
    [...implemented].sort(),
    [...declared].sort(),
    "The interface must implement exactly the error codes upstream.json declares",
  );

  for (const code of declared) {
    assert.ok(specSource.includes(`"${code}"`), `spec/remote_interface_spec.lua must cover ${code}`);
    assert.ok(readme.includes(code), `compat/todo-list/README.md must document ${code}`);
  }
});

test("compat/todo-list: the interface never reaches into storage.todo directly", () => {
  const body = interfaceSource
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  assert.ok(
    body.includes("todo.assemble_task"),
    "Task creation must reuse the upstream assemble_task helper",
  );
  assert.ok(body.includes("todo.save_task_to_open_list"));
  assert.ok(body.includes("todo.update_main_task_list_for_everyone"));
  assert.doesNotMatch(body, /storage\.todo\.open\s*\[/u);
  assert.doesNotMatch(body, /table\.insert\(\s*storage/u);
  assert.doesNotMatch(body, /\bloadstring\b|\bload\(|\bdofile\b|\brequire\(/u);
});

test("compat/todo-list: the interface exposes only api_version and add_task", () => {
  const world = createWorld();
  world.call("todo.register_remote_interface()");

  assert.deepEqual(world.eval("return table.concat(REGISTERED_CALLS, ',')"), "add_task,api_version");
  assert.equal(world.eval("return REGISTERED_NAME"), manifest.remote_interface.name);
  assert.equal(
    world.eval("return todo.remote_api_version()"),
    manifest.remote_interface.api_version,
  );
});

test("compat/todo-list: a valid call creates a task and refreshes every player", () => {
  const world = createWorld();
  const result = world.add({
    player_index: 1,
    title: "Build 4 more assemblers",
    description: "Iron gears are the bottleneck.",
    assignee: "Jonas",
  });

  assert.deepEqual(result, { created: true, id: 1 });
  assert.deepEqual(world.tasks(), [
    {
      id: 1,
      title: "Build 4 more assemblers",
      task: "Iron gears are the bottleneck.",
      assignee: "Jonas",
      created_by: "Charles",
      updated_by: "Charles",
    },
  ]);
  assert.equal(world.eval("return REFRESHED"), 1);
});

test("compat/todo-list: add_to_top controls the position, ids keep increasing", () => {
  const world = createWorld();
  world.add({ player_index: 1, title: "first" });
  world.add({ player_index: 2, title: "second" });
  const third = world.add({ player_index: 1, title: "third", add_to_top: true });

  assert.equal(third.id, 3);
  assert.deepEqual(
    world.tasks().map((task) => task.title),
    ["third", "first", "second"],
  );
  assert.deepEqual(
    world.tasks().map((task) => task.created_by),
    ["Charles", "Charles", "Jonas"],
  );
});

test("compat/todo-list: description is optional and `task` is accepted as an alias", () => {
  const world = createWorld();
  world.add({ player_index: 1, title: "no body" });
  world.add({ player_index: 1, title: "alias", task: "body" });

  assert.deepEqual(
    world.tasks().map((task) => task.task),
    ["", "body"],
  );
});

test("compat/todo-list: control characters are stripped, line breaks survive", () => {
  const world = createWorld();
  world.add({
    player_index: 1,
    title: "  spa\u0001ced  ",
    description: "line one\nline two\u0007\ttabbed",
  });

  assert.deepEqual(world.tasks(), [
    {
      id: 1,
      title: "spaced",
      task: "line one\nline two\ttabbed",
      assignee: null,
      created_by: "Charles",
      updated_by: "Charles",
    },
  ]);
});

const rejections = [
  ["a payload that is not a table", "invalid_payload", '"nope"'],
  ["a missing player index", "invalid_player_index", "{ title = 'x' }"],
  ["a player index of the wrong type", "invalid_player_index", "{ player_index = '1', title = 'x' }"],
  ["an unknown player", "unknown_player", "{ player_index = 99, title = 'x' }"],
  ["a fractional player index", "invalid_player_index", "{ player_index = 1.5, title = 'x' }"],
  ["a negative player index", "invalid_player_index", "{ player_index = -1, title = 'x' }"],
  ["a player index of zero", "invalid_player_index", "{ player_index = 0, title = 'x' }"],
  [
    "an infinite player index",
    "invalid_player_index",
    "{ player_index = math.huge, title = 'x' }",
  ],
  [
    "a player index that is not a number at all",
    "invalid_player_index",
    "{ player_index = 0 / 0, title = 'x' }",
  ],
  ["a missing title", "invalid_title", "{ player_index = 1 }"],
  ["a blank title", "invalid_title", "{ player_index = 1, title = '  \\1 ' }"],
  ["a title of the wrong type", "invalid_title", "{ player_index = 1, title = 42 }"],
  [
    "an oversized title",
    "title_too_long",
    "{ player_index = 1, title = string.rep('a', 201) }",
  ],
  [
    "a description of the wrong type",
    "invalid_description",
    "{ player_index = 1, title = 'x', description = {} }",
  ],
  [
    "an oversized description",
    "description_too_long",
    "{ player_index = 1, title = 'x', description = string.rep('a', 4001) }",
  ],
  [
    "an assignee of the wrong type",
    "invalid_assignee",
    "{ player_index = 1, title = 'x', assignee = 7 }",
  ],
  [
    "an unknown assignee",
    "unknown_assignee",
    "{ player_index = 1, title = 'x', assignee = 'Nobody' }",
  ],
  [
    "an add_to_top that is not a boolean",
    "invalid_add_to_top",
    "{ player_index = 1, title = 'x', add_to_top = 'yes' }",
  ],
];

for (const [name, code, expression] of rejections) {
  test(`compat/todo-list: rejects ${name} without touching the save`, () => {
    const world = createWorld();
    const result = world.eval(`return ENCODE(todo.remote_add_task(${expression}))`);
    const parsed = JSON.parse(result);

    assert.equal(parsed.created, false);
    assert.equal(parsed.error, code);
    assert.equal(typeof parsed.message, "string");
    assert.ok(parsed.id === undefined, "A rejected call must not report a task id");
    assert.deepEqual(world.tasks(), []);
    assert.equal(world.eval("return REFRESHED"), 0);
  });
}

test("compat/todo-list: refuses to write before the mod is initialized", () => {
  const world = createWorld();
  world.call("storage.todo = nil");
  const result = world.eval(
    "return ENCODE(todo.remote_add_task({ player_index = 1, title = 'x' }))",
  );

  assert.equal(JSON.parse(result).error, "not_initialized");
});

test("compat/todo-list: a broken GUI refresh still reports the task as created", () => {
  const world = createWorld();
  world.call("todo.update_main_task_list_for_everyone = function() error('gui exploded') end");
  const result = world.add({ player_index: 1, title: "resilient" });

  assert.equal(result.created, true);
  assert.equal(world.tasks().length, 1);
});

test("compat/todo-list: a task that landed despite a failing save side effect is reported created", () => {
  const world = createWorld();
  world.call("todo.update_export_dialog_button_state = function() error('half built frame') end");
  const result = world.add({ player_index: 1, title: "already saved" });

  assert.equal(result.created, true);
  assert.equal(result.id, 1);
  assert.deepEqual(
    world.tasks().map((task) => task.title),
    ["already saved"],
  );
});

test("compat/todo-list: an internal failure is reported instead of raised", () => {
  const world = createWorld();
  world.call("todo.save_task_to_open_list = function() error('disk on fire') end");
  const result = world.eval(
    "return ENCODE(todo.remote_add_task({ player_index = 1, title = 'x' }))",
  );

  assert.equal(JSON.parse(result).error, "internal_error");
});

/**
 * Extracts every file a unified diff creates, keyed by its path.
 */
function collectAddedFiles(patch) {
  const files = new Map();
  const lines = patch.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const header = /^diff --git a\/(\S+) b\/\S+$/u.exec(lines[index]);
    if (header === null || !/^new file mode \d+$/u.test(lines[index + 1] ?? "")) {
      continue;
    }

    const content = [];
    let cursor = index + 1;
    while (cursor < lines.length && !lines[cursor].startsWith("@@ ")) {
      cursor += 1;
    }
    cursor += 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.startsWith("diff --git ")) {
        break;
      }
      if (line.startsWith("+")) {
        content.push(line.slice(1));
      }
    }

    files.set(header[1], `${content.join("\n")}\n`);
  }

  return files;
}

/**
 * A Lua state with the patched interface loaded on top of the upstream helpers
 * it depends on and a minimal Factorio API. `assemble_task`,
 * `save_task_to_open_list` and `next_task_id` are copied from upstream
 * v19.15.3 so the interface runs against the code path it is supposed to reuse.
 */
function createWorld() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  exec(L, "prelude", PRELUDE);
  exec(L, "remote_interface.lua", interfaceSource);

  const world = {
    call(chunk) {
      exec(L, "spec", chunk);
    },
    eval(chunk) {
      exec(L, "spec", chunk, 1);
      const value = lua.lua_isnumber(L, -1)
        ? lua.lua_tonumber(L, -1)
        : lua.lua_tojsstring(L, -1);
      lua.lua_pop(L, 1);
      return value;
    },
    add(payload) {
      return JSON.parse(world.eval(`return ENCODE(todo.remote_add_task(${toLuaLiteral(payload)}))`));
    },
    tasks() {
      return JSON.parse(world.eval("return ENCODE_TASKS()"));
    },
  };

  return world;
}

function exec(L, name, source, results = 0) {
  const loadStatus = lauxlib.luaL_loadbuffer(
    L,
    to_luastring(source, true),
    null,
    to_luastring(`@${name}`),
  );
  assert.equal(loadStatus, lua.LUA_OK, `Lua load failed: ${lua.lua_tojsstring(L, -1)}`);
  const callStatus = lua.lua_pcall(L, 0, results, 0);
  assert.equal(callStatus, lua.LUA_OK, `Lua run failed: ${lua.lua_tojsstring(L, -1)}`);
}

/** Renders a JSON-ish JavaScript value as the Lua literal a caller would pass. */
function toLuaLiteral(value) {
  if (value === null || value === undefined) {
    return "nil";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    const body = [...value]
      .map((character) => {
        const code = character.codePointAt(0);
        if (character === '"') {
          return '\\"';
        }
        if (character === "\\") {
          return "\\\\";
        }
        if (code < 0x20 || code === 0x7f) {
          return `\\${String(code).padStart(3, "0")}`;
        }
        return character;
      })
      .join("");
    return `"${body}"`;
  }

  const fields = Object.entries(value).map(
    ([key, entry]) => `[${toLuaLiteral(key)}] = ${toLuaLiteral(entry)}`,
  );
  return `{ ${fields.join(", ")} }`;
}

const PRELUDE = String.raw`
todo = {}
serpent = { block = function() return "" end, dump = function() return "" end }
storage = { todo = { open = {}, done = {}, settings = {} } }
REFRESHED = 0
REGISTERED_NAME = nil
REGISTERED_CALLS = {}

local players = {
  { index = 1, name = "Charles", valid = true },
  { index = 2, name = "Jonas", valid = true },
}

game = {
  players = players,
  -- Mirrors the API: get_player raises instead of returning nil when the index
  -- is not a uint.
  get_player = function(index)
    if type(index) ~= "number" or index ~= index or index % 1 ~= 0
      or index < 0 or index > 4294967295 then
      error("Value must be a valid uint")
    end
    return players[index]
  end,
}

remote = {
  add_interface = function(name, functions)
    REGISTERED_NAME = name
    REGISTERED_CALLS = {}
    for call_name in pairs(functions) do
      table.insert(REGISTERED_CALLS, call_name)
    end
    table.sort(REGISTERED_CALLS)
  end,
}

function todo.log() end
function todo.update_export_dialog_button_state() end
function todo.update_main_task_list_for_everyone()
  REFRESHED = REFRESHED + 1
end

-- Verbatim from upstream v19.15.3 src/todo/features/add_task.lua.
function todo.assemble_task(input, player)
    local task = {}
    task.id = todo.next_task_id()
    task.title = input.title
    task.task = input.task
    task.assignee = input.assignee
    task.created_by = player.name
    task.updated_by = player.name
    return task
end

function todo.next_task_id()
    if not storage.todo.next_id then
        storage.todo.next_id = 1
    end

    storage.todo.next_id = storage.todo.next_id + 1
    return storage.todo.next_id - 1
end

function todo.save_task_to_open_list(task, should_add_to_top)
    todo.log("Saving task: " .. serpent.block(task))

    local add_index = 1
    if not should_add_to_top then
        add_index = #storage.todo.open + 1
    end

    table.insert(storage.todo.open, add_index, task)

    todo.update_export_dialog_button_state()

    return task
end

-- Verbatim from upstream v19.15.3 src/todo/helper.lua.
function todo.get_task_by_id(id)
    for _, task in pairs(storage.todo.open) do
        if (task.id == id) then
            return task
        end
    end

    for _, task in pairs(storage.todo.done) do
        if (task.id == id) then
            return task
        end
    end
end

local function escape(text)
  local out = string.gsub(text, '[%c"\\]', function(char)
    if char == '"' then return '\\"' end
    if char == "\\" then return "\\\\" end
    if char == "\n" then return "\\n" end
    if char == "\t" then return "\\t" end
    return string.format("\\u%04x", string.byte(char))
  end)
  return '"' .. out .. '"'
end

local function encode(value)
  local kind = type(value)
  if kind == "nil" then return "null" end
  if kind == "boolean" then return tostring(value) end
  if kind == "number" then return string.format("%d", value) end
  if kind == "string" then return escape(value) end

  local parts = {}
  local keys = {}
  for key in pairs(value) do table.insert(keys, key) end
  table.sort(keys)
  for _, key in ipairs(keys) do
    table.insert(parts, escape(key) .. ":" .. encode(value[key]))
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

function ENCODE(value)
  return encode(value)
end

function ENCODE_TASKS()
  local parts = {}
  for _, task in ipairs(storage.todo.open) do
    table.insert(parts, '{"id":' .. task.id
      .. ',"title":' .. escape(task.title)
      .. ',"task":' .. escape(task.task)
      .. ',"assignee":' .. (task.assignee and escape(task.assignee) or "null")
      .. ',"created_by":' .. escape(task.created_by)
      .. ',"updated_by":' .. escape(task.updated_by) .. "}")
  end
  return "[" .. table.concat(parts, ",") .. "]"
end
`;
