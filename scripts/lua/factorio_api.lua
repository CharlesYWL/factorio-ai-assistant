--- Deterministic stand-in for the parts of the Factorio 2.0 runtime API that
--- the Mod touches, so `control.lua`, `ui.lua`, `ui_state.lua` and `pause.lua`
--- can be loaded and driven unmodified from Node.
---
--- Only behaviour the Mod actually depends on is modelled. The one place this
--- goes out of its way to be faithful is `player.opened`: assigning `nil` to it
--- raises `on_gui_closed` exactly like the real engine, because that re-entrant
--- close path is what ESC and the close button share.
local api = {}

local registry = setmetatable({}, { __mode = "k" })

local ELEMENT_METHODS = {
  add = true,
  destroy = true,
  clear = true,
  focus = true,
  scroll_to_bottom = true,
}

local ELEMENT_FIELDS = {
  caption = true,
  column_count = true,
  direction = true,
  drag_target = true,
  enabled = true,
  ignored_by_interaction = true,
  location = true,
  name = true,
  style = true,
  tags = true,
  text = true,
  tooltip = true,
  type = true,
  valid = true,
  visible = true,
}

local create_element

local function invalidate(element)
  local data = registry[element]
  if data == nil then
    return
  end
  data.valid = false
  for _, child in ipairs(data.children) do
    invalidate(child)
  end
  data.children = {}
end

create_element = function(spec, parent)
  local element = {}
  local data = {
    type = spec.type,
    name = spec.name,
    caption = spec.caption,
    tooltip = spec.tooltip,
    tags = spec.tags or {},
    text = spec.text or "",
    enabled = true,
    visible = true,
    valid = true,
    direction = spec.direction,
    column_count = spec.column_count,
    location = nil,
    drag_target = nil,
    ignored_by_interaction = false,
    style = { name = spec.style or spec.type },
    children = {},
    parent = parent,
    scrolled_to_bottom = 0,
    focused = 0,
  }
  registry[element] = data

  local methods = {}

  methods.add = function(child_spec)
    local child = create_element(child_spec, element)
    table.insert(data.children, child)
    return child
  end

  methods.destroy = function()
    local parent_data = parent ~= nil and registry[parent] or nil
    if parent_data ~= nil then
      for index = #parent_data.children, 1, -1 do
        if parent_data.children[index] == element then
          table.remove(parent_data.children, index)
        end
      end
    end
    invalidate(element)
  end

  methods.clear = function()
    for _, child in ipairs(data.children) do
      invalidate(child)
    end
    data.children = {}
  end

  methods.focus = function()
    data.focused = data.focused + 1
  end

  methods.scroll_to_bottom = function()
    data.scrolled_to_bottom = data.scrolled_to_bottom + 1
  end

  setmetatable(element, {
    __index = function(_, key)
      if ELEMENT_METHODS[key] then
        return methods[key]
      end
      if key == "children" then
        local copy = {}
        for index, child in ipairs(data.children) do
          copy[index] = child
        end
        return copy
      end
      if ELEMENT_FIELDS[key] then
        return data[key]
      end
      if type(key) == "string" then
        for _, child in ipairs(data.children) do
          if registry[child].name == key then
            return child
          end
        end
        return nil
      end
      return data[key]
    end,
    __newindex = function(_, key, value)
      if key == "style" and type(value) == "string" then
        data.style = { name = value }
        return
      end
      data[key] = value
    end,
  })

  return element
end

local function each_element(root, visit)
  if root == nil then
    return
  end
  visit(root)
  for _, child in ipairs(root.children) do
    each_element(child, visit)
  end
end

--- Reads the settings prototypes straight out of `factorio-mod/settings.lua`, so
--- the fake stores exactly the settings and defaults the Mod ships.
local function load_setting_prototypes(source)
  local prototypes = {}
  local data_stub = {
    extend = function(_, list)
      for _, prototype in ipairs(list) do
        prototypes[prototype.name] = prototype
      end
    end,
  }
  local env = setmetatable({ data = data_stub }, { __index = _G })
  assert(load(source, "@settings.lua", "t", env))()
  return prototypes
end

function api.create(sources, options)
  options = options or {}

  local world = {}
  local prototypes = load_setting_prototypes(assert(sources.settings))
  local event_handlers = {}
  local nth_tick_handlers = {}
  local commands_registered = {}
  local logs = {}

  local defines = setmetatable({}, {
    __index = function(root, group)
      local ids = setmetatable({}, {
        __index = function(entries, key)
          local id = tostring(group) .. "." .. tostring(key)
          rawset(entries, key, id)
          return id
        end,
      })
      rawset(root, group, ids)
      return ids
    end,
  })

  local game = {
    tick = options.tick or 100,
    tick_paused = options.tick_paused or false,
    players = {},
    connected_players = {},
    forces = {},
    surfaces = {},
  }
  local multiplayer = options.multiplayer == true

  function game.get_player(index)
    return game.players[index]
  end

  function game.is_multiplayer()
    return multiplayer
  end

  function game.create_profiler()
    return setmetatable({ stop = function() end }, {
      __tostring = function()
        return "0.000 ms"
      end,
    })
  end

  local settings = { startup = {}, global = {}, players = {} }

  function settings.get_player_settings(player)
    local index = type(player) == "number" and player or player.index
    settings.players[index] = settings.players[index] or {}
    return settings.players[index]
  end

  local function default_player_settings()
    local values = {}
    for name, prototype in pairs(prototypes) do
      if prototype.setting_type == "runtime-per-user" then
        values[name] = { value = prototype.default_value }
      end
    end
    return values
  end

  for name, prototype in pairs(prototypes) do
    if prototype.setting_type == "startup" then
      settings.startup[name] = { value = prototype.default_value }
    elseif prototype.setting_type == "runtime-global" then
      settings.global[name] = { value = prototype.default_value }
    end
  end

  local script = {
    active_mods = { ["factorio-ai-assistant"] = "0.1.0" },
  }

  function script.on_init(handler)
    world.on_init = handler
  end

  function script.on_configuration_changed(handler)
    world.on_configuration_changed = handler
  end

  function script.on_event(event_id, handler)
    if type(event_id) == "table" then
      for _, single in ipairs(event_id) do
        event_handlers[single] = handler
      end
      return
    end
    event_handlers[event_id] = handler
  end

  function script.on_nth_tick(interval, handler)
    nth_tick_handlers[interval] = handler
  end

  local helpers = {
    send_udp = function()
      return true
    end,
    recv_udp = function()
      return true
    end,
    table_to_json = function()
      return "{}"
    end,
    json_to_table = function()
      return nil
    end,
  }

  local commands = {
    add_command = function(name, _, handler)
      commands_registered[name] = handler
    end,
  }

  local mod_gui = {
    get_button_flow = function(player)
      return player.gui.top
    end,
    get_frame_flow = function(player)
      return player.gui.left
    end,
  }

  local env = setmetatable({}, { __index = _G })
  env.game = game
  env.settings = settings
  env.script = script
  env.helpers = helpers
  env.commands = commands
  env.defines = defines
  env.storage = {}
  env.log = function(message)
    table.insert(logs, message)
  end

  local loaded = {}
  env.require = function(name)
    if name == "__core__.lualib.mod-gui" then
      return mod_gui
    end
    if loaded[name] ~= nil then
      return loaded[name]
    end
    local source = sources[name]
    assert(source ~= nil, "no Lua source registered for " .. tostring(name))
    local module = assert(load(source, "@" .. name .. ".lua", "t", env))()
    loaded[name] = module
    return module
  end

  local function raise(event_id, event)
    local handler = event_handlers[event_id]
    if handler == nil then
      return false
    end
    event.tick = event.tick or game.tick
    handler(event)
    return true
  end

  function world.add_player(index, force_name)
    local data = {
      index = index,
      valid = true,
      connected = true,
      locale = "en",
      force = { name = force_name or "player" },
      display_resolution = { width = 1920, height = 1080 },
      opened = nil,
      printed = {},
      gui = {
        screen = create_element({ type = "flow", name = "screen" }),
        top = create_element({ type = "flow", name = "top" }),
        left = create_element({ type = "flow", name = "left" }),
      },
    }
    local player = setmetatable({}, {
      __index = function(_, key)
        if key == "print" then
          return function(message)
            table.insert(data.printed, message)
          end
        end
        if key == "request_translation" then
          return function()
            return nil
          end
        end
        return data[key]
      end,
      __newindex = function(_, key, value)
        if key == "opened" then
          local previous = data.opened
          data.opened = value
          if value == nil and previous ~= nil then
            raise(defines.events.on_gui_closed, {
              player_index = index,
              element = previous,
            })
          end
          return
        end
        data[key] = value
      end,
    })
    game.players[index] = player
    table.insert(game.connected_players, player)
    settings.players[index] = default_player_settings()
    return player
  end

  function world.set_player_setting(index, name, value)
    settings.get_player_settings(index)[name] = { value = value }
  end

  function world.load_control()
    env.require("control")
    if world.on_init ~= nil then
      world.on_init()
    end
    return world
  end

  function world.module(name)
    return env.require(name)
  end

  function world.state()
    return env.storage.factorio_ai_assistant
  end

  world.raise = raise

  function world.run_nth_tick(interval)
    local handler = nth_tick_handlers[interval]
    assert(
      handler ~= nil,
      "no handler registered for interval " .. tostring(interval)
    )
    handler()
  end

  function world.run_command(name, player_index, parameter)
    local handler = commands_registered[name]
    assert(handler ~= nil, "no command registered as " .. tostring(name))
    handler({ player_index = player_index, parameter = parameter })
  end

  function world.find_all(player, predicate)
    local found = {}
    for _, root in ipairs({
      player.gui.screen,
      player.gui.left,
      player.gui.top,
    }) do
      each_element(root, function(element)
        if predicate(element) then
          table.insert(found, element)
        end
      end)
    end
    return found
  end

  function world.find_within(root, predicate)
    local found = {}
    each_element(root, function(element)
      if predicate(element) then
        table.insert(found, element)
      end
    end)
    return found
  end

  function world.find_by_action(player, action)
    return world.find_all(player, function(element)
      return (element.tags or {}).action == action
    end)[1]
  end

  function world.find_by_name(player, name)
    return world.find_all(player, function(element)
      return element.name == name
    end)[1]
  end

  function world.click(player, element)
    assert(element ~= nil, "cannot click a missing element")
    return raise(defines.events.on_gui_click, {
      player_index = player.index,
      element = element,
    })
  end

  function world.click_action(player, action)
    return world.click(player, world.find_by_action(player, action))
  end

  function world.custom_input(name, player)
    return raise(name, { player_index = player.index })
  end

  --- ESC: the engine clears `opened` itself, which raises on_gui_closed. A panel
  --- that never registered as the opened GUI simply cannot be closed this way.
  function world.press_escape(player)
    assert(player.opened ~= nil, "no GUI is registered as opened")
    player.opened = nil
    return true
  end

  function world.panel(player)
    return player.gui.screen["factorio-ai-assistant-panel"]
  end

  function world.hud(player)
    return player.gui.left["factorio-ai-assistant-alert-hud"]
  end

  function world.logs()
    return logs
  end

  world.game = game
  world.settings = settings
  world.defines = defines
  world.env = env

  return world
end

return api
