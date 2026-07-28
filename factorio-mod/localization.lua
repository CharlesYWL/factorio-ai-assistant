local localization = {}

local PROTOCOL_VERSION = 1
local STATE_SCHEMA_VERSION = 2
local MAX_PACKET_BYTES = 16 * 1024
local PACKET_TARGET_BYTES = MAX_PACKET_BYTES - 512
local MAX_ENTRIES_PER_PACKET = 256
local MAX_TRACKED_NAMES = 2048
local MAX_REQUESTS_PER_REFRESH = 32
local MAX_NAME_CHARACTERS = 128
local TRANSLATION_TIMEOUT_TICKS = 1800

local KINDS = {
  item = true,
  fluid = true,
  recipe = true,
  technology = true,
  machine = true,
}

-- Identifiers the deterministic advisor rules and the first-run fixtures always
-- name, so their display names are ready before the first alert is rendered.
local SEEDED_IDS = {
  { kind = "item", id = "iron-plate" },
  { kind = "item", id = "copper-plate" },
  { kind = "item", id = "steel-plate" },
  { kind = "item", id = "electronic-circuit" },
  { kind = "item", id = "advanced-circuit" },
  { kind = "item", id = "processing-unit" },
  { kind = "item", id = "automation-science-pack" },
  { kind = "item", id = "logistic-science-pack" },
  { kind = "item", id = "military-science-pack" },
  { kind = "item", id = "chemical-science-pack" },
  { kind = "item", id = "production-science-pack" },
  { kind = "item", id = "utility-science-pack" },
  { kind = "item", id = "space-science-pack" },
  { kind = "fluid", id = "crude-oil" },
  { kind = "fluid", id = "heavy-oil" },
  { kind = "fluid", id = "light-oil" },
  { kind = "fluid", id = "petroleum-gas" },
  { kind = "fluid", id = "lubricant" },
  { kind = "technology", id = "advanced-oil-processing" },
  { kind = "technology", id = "robotics" },
  { kind = "technology", id = "construction-robotics" },
  { kind = "machine", id = "assembling-machine-1" },
  { kind = "machine", id = "assembling-machine-2" },
  { kind = "machine", id = "assembling-machine-3" },
}

local function entry_key(kind, id)
  return kind .. ":" .. id
end

local function split_key(key)
  local separator = string.find(key, ":", 1, true)
  if separator == nil then
    return nil, nil
  end
  return string.sub(key, 1, separator - 1), string.sub(key, separator + 1)
end

function localization.ensure(state)
  state.localization = state.localization or {}
  local loc = state.localization

  loc.locale = loc.locale or nil
  loc.names = loc.names or {}
  loc.name_count = loc.name_count or 0
  loc.pending = loc.pending or {}
  loc.pending_count = loc.pending_count or 0
  loc.requested = loc.requested or {}
  loc.requested_count = loc.requested_count or 0
  loc.request_keys = loc.request_keys or {}
  loc.unavailable = loc.unavailable or {}
  loc.outbound = loc.outbound or {}
  loc.reset_pending = loc.reset_pending ~= false
  loc.seeded = loc.seeded or false

  return loc
end

local function prototype_for(kind, id)
  if kind == "item" then
    return prototypes.item[id]
  elseif kind == "fluid" then
    return prototypes.fluid[id]
  elseif kind == "recipe" then
    return prototypes.recipe[id]
  elseif kind == "technology" then
    return prototypes.technology[id]
  elseif kind == "machine" then
    return prototypes.entity[id]
  end

  return nil
end

--- Queue one prototype identifier for translation. Unknown kinds, unknown
--- prototypes, and already known identifiers are ignored.
function localization.register(state, kind, id)
  if not KINDS[kind] or type(id) ~= "string" or id == "" or #id > 256 then
    return
  end

  local loc = localization.ensure(state)
  local key = entry_key(kind, id)

  if loc.names[key] ~= nil
    or loc.pending[key]
    or loc.requested[key] ~= nil
    or loc.unavailable[key]
  then
    return
  end

  if loc.name_count + loc.pending_count + loc.requested_count
    >= MAX_TRACKED_NAMES
  then
    return
  end

  loc.pending[key] = true
  loc.pending_count = loc.pending_count + 1
end

function localization.register_flows(state, items, fluids)
  for _, metric in ipairs(items or {}) do
    localization.register(state, "item", metric.id)
  end
  for _, metric in ipairs(fluids or {}) do
    localization.register(state, "fluid", metric.id)
  end
end

function localization.register_force_summary(state, force_summary)
  if type(force_summary) ~= "table" then
    return
  end

  localization.register_flows(state, force_summary.items, force_summary.fluids)

  if type(force_summary.research) == "table" then
    localization.register(
      state,
      "technology",
      force_summary.research.technology_id
    )
  end
end

--- Queue every identifier a calculation result will display.
function localization.register_calculation_result(state, result)
  if type(result) ~= "table" then
    return
  end

  if type(result.target) == "table" then
    localization.register(state, result.target.kind, result.target.id)
  end

  for _, recipe in ipairs(result.recipes or {}) do
    localization.register(state, "recipe", recipe.recipe_id)
    localization.register(state, "machine", recipe.machine_id)
    for _, module_id in ipairs(recipe.module_ids or {}) do
      localization.register(state, "item", module_id)
    end
  end

  for _, resource in ipairs(result.external_inputs or {}) do
    localization.register(state, resource.kind, resource.id)
  end

  for _, resource in ipairs(result.byproducts or {}) do
    localization.register(state, resource.kind, resource.id)
  end
end

local function seed(state)
  local loc = localization.ensure(state)
  if loc.seeded then
    return
  end

  loc.seeded = true
  for _, entry in ipairs(SEEDED_IDS) do
    localization.register(state, entry.kind, entry.id)
  end
end

--- The player whose locale the Companion-facing names follow. The Companion is a
--- single local process, so the lowest connected player index wins deterministically.
local function translation_player()
  local selected = nil

  for _, player in pairs(game.connected_players) do
    if selected == nil or player.index < selected.index then
      selected = player
    end
  end

  return selected
end

function localization.locale_of(player)
  if player == nil or not player.valid then
    return nil
  end

  local locale = player.locale
  if type(locale) ~= "string" or locale == "" or #locale > 32 then
    return nil
  end

  return locale
end

local function forget_translations(loc)
  loc.names = {}
  loc.name_count = 0
  loc.pending = {}
  loc.pending_count = 0
  loc.requested = {}
  loc.requested_count = 0
  loc.request_keys = {}
  loc.unavailable = {}
  loc.outbound = {}
  loc.reset_pending = true
end

--- Re-queue every identifier we already care about after a locale switch.
local function requeue_known(loc, known_keys)
  for _, key in ipairs(known_keys) do
    if not loc.pending[key] then
      loc.pending[key] = true
      loc.pending_count = loc.pending_count + 1
    end
  end
end

local function all_known_keys(loc)
  local keys = {}

  for key in pairs(loc.names) do
    table.insert(keys, key)
  end
  for key in pairs(loc.unavailable) do
    table.insert(keys, key)
  end
  for key in pairs(loc.requested) do
    table.insert(keys, key)
  end
  for key in pairs(loc.pending) do
    table.insert(keys, key)
  end

  return keys
end

--- Requests are fire-and-forget: a translation can be lost when the requesting
--- player disconnects or the save is reloaded. Return timed-out keys to the queue
--- so they are retried instead of blocking their identifier forever.
local function expire_requests(loc)
  local expired = {}

  for key, request in pairs(loc.requested) do
    if game.tick - (request.tick or 0) > TRANSLATION_TIMEOUT_TICKS then
      table.insert(expired, key)
    end
  end

  for _, key in ipairs(expired) do
    local request = loc.requested[key]
    loc.request_keys[request.id] = nil
    loc.requested[key] = nil
    loc.requested_count = math.max(0, loc.requested_count - 1)
    if not loc.pending[key] then
      loc.pending[key] = true
      loc.pending_count = loc.pending_count + 1
    end
  end
end

function localization.refresh(state)
  local loc = localization.ensure(state)
  local player = translation_player()
  local locale = localization.locale_of(player)

  if locale == nil then
    return
  end

  seed(state)

  if loc.locale ~= locale then
    local known_keys = all_known_keys(loc)
    forget_translations(loc)
    requeue_known(loc, known_keys)
    loc.locale = locale
  else
    expire_requests(loc)
  end

  local dispatched = 0
  local keys = {}

  for key in pairs(loc.pending) do
    table.insert(keys, key)
  end
  table.sort(keys)

  for _, key in ipairs(keys) do
    if dispatched >= MAX_REQUESTS_PER_REFRESH then
      break
    end

    local kind, id = split_key(key)
    local prototype = kind ~= nil and prototype_for(kind, id) or nil

    loc.pending[key] = nil
    loc.pending_count = math.max(0, loc.pending_count - 1)

    if prototype == nil then
      loc.unavailable[key] = true
    else
      local success, request_id =
        pcall(player.request_translation, prototype.localised_name)

      if success and type(request_id) == "number" then
        loc.requested[key] = { id = request_id, tick = game.tick }
        loc.requested_count = loc.requested_count + 1
        loc.request_keys[request_id] = key
        dispatched = dispatched + 1
      else
        -- Retry on the next refresh; the player may be mid-join.
        loc.pending[key] = true
        loc.pending_count = loc.pending_count + 1
        break
      end
    end
  end
end

function localization.handle_translation(state, event)
  local loc = localization.ensure(state)
  local key = loc.request_keys[event.id]

  if key == nil then
    return false
  end

  loc.request_keys[event.id] = nil
  if loc.requested[key] ~= nil then
    loc.requested[key] = nil
    loc.requested_count = math.max(0, loc.requested_count - 1)
  end

  if not event.translated
    or type(event.result) ~= "string"
    or event.result == ""
  then
    loc.unavailable[key] = true
    return false
  end

  local name = event.result
  if #name > MAX_NAME_CHARACTERS then
    name = string.sub(name, 1, MAX_NAME_CHARACTERS)
  end

  if loc.names[key] == nil then
    loc.name_count = loc.name_count + 1
  end
  loc.names[key] = name
  loc.outbound[key] = true
  return true
end

local function packet_for(locale, reset, names, message_id)
  return {
    protocol_version = PROTOCOL_VERSION,
    schema_version = STATE_SCHEMA_VERSION,
    message_id = message_id,
    type = "localization_update",
    tick = game.tick,
    payload = {
      locale = locale,
      reset = reset,
      names = names,
    },
  }
end

--- Build the pending `localization_update` packets. Each packet stays inside the
--- 16 KiB transport budget; entries that do not fit stay queued for the next call.
--- A pending cache reset always rides along with the first non-empty batch, so no
--- packet ever carries an empty `names` array.
function localization.build_packets(state, message_id_factory)
  local loc = localization.ensure(state)

  if loc.locale == nil or next(loc.outbound) == nil then
    return {}
  end

  local keys = {}
  for key in pairs(loc.outbound) do
    table.insert(keys, key)
  end
  table.sort(keys)

  local packets = {}
  local index = 1
  local reset = loc.reset_pending and true or false

  repeat
    local names = {}
    local message_id = message_id_factory()
    local consumed = {}

    while index <= #keys and #names < MAX_ENTRIES_PER_PACKET do
      local key = keys[index]
      local kind, id = split_key(key)
      local name = loc.names[key]

      if kind == nil or name == nil then
        loc.outbound[key] = nil
        index = index + 1
      else
        table.insert(names, { kind = kind, id = id, name = name })
        local encoded =
          helpers.table_to_json(packet_for(loc.locale, reset, names, message_id))

        if #encoded > PACKET_TARGET_BYTES then
          table.remove(names)
          break
        end

        table.insert(consumed, key)
        index = index + 1
      end
    end

    if #names == 0 then
      break
    end

    local packet = packet_for(loc.locale, reset, names, message_id)
    local encoded = helpers.table_to_json(packet)

    if #encoded > MAX_PACKET_BYTES then
      log(
        "[factorio-ai-assistant] Localization packet budget exceeded; "
          .. #names
          .. " names were dropped"
      )
      for _, key in ipairs(consumed) do
        loc.outbound[key] = nil
      end
      break
    end

    for _, key in ipairs(consumed) do
      loc.outbound[key] = nil
    end

    table.insert(packets, {
      message_id = message_id,
      encoded = encoded,
    })
    reset = false
  until index > #keys

  loc.reset_pending = reset
  return packets
end

--- True when the Companion's reported cache disagrees with what this Mod believes
--- it has delivered and no batch is already in flight.
function localization.needs_resend(state, companion_name_count)
  local loc = localization.ensure(state)

  if loc.locale == nil
    or loc.reset_pending
    or next(loc.outbound) ~= nil
  then
    return false
  end

  return companion_name_count ~= loc.name_count
end

--- Queue every already translated name for re-delivery with a cache reset. Used
--- when a Companion (re)connects with an empty cache.
function localization.resend_all(state)
  local loc = localization.ensure(state)

  loc.reset_pending = true
  for key in pairs(loc.names) do
    loc.outbound[key] = true
  end
end

--- Drop every translation and re-request it. Used when the prototype set may have
--- changed, so cached names cannot be trusted.
function localization.invalidate(state)
  local loc = localization.ensure(state)
  local known_keys = all_known_keys(loc)

  forget_translations(loc)
  requeue_known(loc, known_keys)
end

return localization
