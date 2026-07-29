--- Entry chunk for the Lua side of the Mod tests. The Node runner injects two
--- globals before loading this file:
---   MOD_SOURCES  — module name -> `factorio-mod/<name>.lua` source
---   TEST_SOURCES — file name   -> `scripts/lua/<name>.lua` source
---   SPEC_NAMES   — ordered list of spec files to run
--- and reads back one tab-separated line per test case.
local factorio_api =
  assert(load(TEST_SOURCES.factorio_api, "@factorio_api.lua", "t", _ENV))()

local results = {}
local suite = {}

function suite.test(name, body)
  local ok, failure = pcall(body)
  table.insert(results, {
    name = name,
    ok = ok,
    message = ok and "" or tostring(failure),
  })
end

--- A world with the Mod loaded, one player and `on_init` already run.
function suite.world(options)
  options = options or {}
  local world = factorio_api.create(MOD_SOURCES, options)
  for _, player_options in ipairs(options.players or { {} }) do
    world.add_player(player_options.index or 1, player_options.force)
  end
  return world.load_control()
end

function suite.equal(actual, expected, label)
  if actual ~= expected then
    error(
      (label or "value")
        .. ": expected "
        .. tostring(expected)
        .. ", got "
        .. tostring(actual),
      2
    )
  end
end

function suite.truthy(value, label)
  if not value then
    error((label or "value") .. ": expected a truthy value", 2)
  end
end

function suite.falsy(value, label)
  if value then
    error(
      (label or "value") .. ": expected a falsy value, got " .. tostring(value),
      2
    )
  end
end

function suite.count(list)
  local total = 0
  for _ in pairs(list) do
    total = total + 1
  end
  return total
end

--- Publishes an advisor alert and refreshes every player's UI, the way
--- `handle_advisor_update` does after an `advisor_update` packet arrives.
function suite.publish_alert(world, alert)
  local state = world.state()
  state.advisor_alerts[alert.id] = alert
  state.connected = true
  suite.refresh_all(world)
  return alert
end

--- The harness stand-in for control.lua's private `refresh_all_ui`.
function suite.refresh_all(world)
  local state = world.state()
  local ui = world.module("ui")
  local ui_state = world.module("ui_state")
  for _, player in pairs(world.game.players) do
    local player_state = ui_state.ensure_player(state, player.index)
    ui.ensure_button(player)
    ui.refresh_alerts_hud(player, state, player_state)
    ui.render(player, state, player_state)
  end
end

function suite.alert(rule_id, force_id, severity, first_seen)
  return {
    id = rule_id .. ":" .. force_id,
    rule_id = rule_id,
    force_id = force_id,
    severity = severity or "warning",
    evidence = "evidence for " .. rule_id,
    recommendation = "recommendation for " .. rule_id,
    first_seen = first_seen or 10,
    last_seen = (first_seen or 10) + 60,
  }
end

for _, spec_name in ipairs(SPEC_NAMES) do
  local source = assert(TEST_SOURCES[spec_name], "missing spec " .. spec_name)
  local spec = assert(load(source, "@" .. spec_name .. ".lua", "t", _ENV))()
  spec(suite)
end

local lines = {}
for _, result in ipairs(results) do
  local message = result.message:gsub("[\r\n\t]+", " ")
  table.insert(
    lines,
    (result.ok and "PASS" or "FAIL") .. "\t" .. result.name .. "\t" .. message
  )
end

return table.concat(lines, "\n")
