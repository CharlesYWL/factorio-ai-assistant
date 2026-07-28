local mod_gui = require("__core__.lualib.mod-gui")

local PROTOCOL_VERSION = 1
local POLL_INTERVAL_TICKS = 15
local UI_REFRESH_INTERVAL_TICKS = 60
local HELLO_INTERVAL_TICKS = 300
local CONNECTION_TIMEOUT_TICKS = 600
local PENDING_TIMEOUT_TICKS = 1200

local BUTTON_NAME = "factorio-ai-assistant-toggle"
local PANEL_NAME = "factorio-ai-assistant-panel"
local STATUS_LABEL_NAME = "factorio-ai-assistant-status"
local LAST_RESPONSE_LABEL_NAME = "factorio-ai-assistant-last-response"
local PING_BUTTON_NAME = "factorio-ai-assistant-ping"

local UDP_EVENT = defines.events.on_udp_packet_received
local UDP_AVAILABLE = UDP_EVENT ~= nil
  and helpers.send_udp ~= nil
  and helpers.recv_udp ~= nil

local function get_state()
  storage.factorio_ai_assistant = storage.factorio_ai_assistant or {
    connected = false,
    last_response_tick = nil,
    last_hello_tick = nil,
    sequence = 0,
    pending = {},
    receive_error_logged = false,
    unsupported_version_logged = false,
  }

  return storage.factorio_ai_assistant
end

local function get_companion_port()
  return settings.startup["factorio-ai-assistant-companion-port"].value
end

local function ensure_button(player)
  local button_flow = mod_gui.get_button_flow(player)
  if not button_flow[BUTTON_NAME] then
    button_flow.add({
      type = "button",
      name = BUTTON_NAME,
      caption = { "factorio-ai-assistant.button-caption" },
      tooltip = { "factorio-ai-assistant.button-tooltip" },
    })
  end
end

local function format_last_response(state)
  if not state.last_response_tick then
    return { "factorio-ai-assistant.never" }
  end

  local elapsed_ticks = math.max(0, game.tick - state.last_response_tick)
  return {
    "factorio-ai-assistant.seconds-ago",
    math.floor(elapsed_ticks / 60),
  }
end

local function refresh_player_ui(player)
  if not player.valid then
    return
  end

  ensure_button(player)

  local frame = mod_gui.get_frame_flow(player)[PANEL_NAME]
  if not frame then
    return
  end

  local state = get_state()
  local status_label = frame[STATUS_LABEL_NAME]
  local last_response_label = frame[LAST_RESPONSE_LABEL_NAME]

  if status_label then
    if state.connected then
      status_label.caption = {
        "factorio-ai-assistant.status",
        { "factorio-ai-assistant.connected" },
      }
      status_label.style.font_color = { r = 0.22, g = 0.82, b = 0.47 }
    else
      status_label.caption = {
        "factorio-ai-assistant.status",
        { "factorio-ai-assistant.disconnected" },
      }
      status_label.style.font_color = { r = 1, g = 0.35, b = 0.32 }
    end
  end

  if last_response_label then
    last_response_label.caption = {
      "factorio-ai-assistant.last-response",
      format_last_response(state),
    }
  end
end

local function refresh_all_ui()
  for _, player in pairs(game.players) do
    refresh_player_ui(player)
  end
end

local function open_panel(player)
  local frame_flow = mod_gui.get_frame_flow(player)
  if frame_flow[PANEL_NAME] then
    return
  end

  local frame = frame_flow.add({
    type = "frame",
    name = PANEL_NAME,
    direction = "vertical",
    caption = { "factorio-ai-assistant.panel-title" },
  })

  frame.add({
    type = "label",
    name = STATUS_LABEL_NAME,
  })
  frame.add({
    type = "label",
    name = LAST_RESPONSE_LABEL_NAME,
  })
  frame.add({
    type = "button",
    name = PING_BUTTON_NAME,
    caption = { "factorio-ai-assistant.ping" },
  })

  refresh_player_ui(player)
end

local function cleanup_pending(state)
  for message_id, sent_tick in pairs(state.pending) do
    if game.tick - sent_tick > PENDING_TIMEOUT_TICKS then
      state.pending[message_id] = nil
    end
  end
end

local function send_hello()
  local state = get_state()

  if not UDP_AVAILABLE then
    state.connected = false
    if not state.unsupported_version_logged then
      log("[factorio-ai-assistant] Lua UDP requires Factorio 2.0.59 or newer")
      state.unsupported_version_logged = true
    end
    refresh_all_ui()
    return false
  end

  cleanup_pending(state)

  state.sequence = state.sequence + 1
  local message_id = "factorio-" .. game.tick .. "-" .. state.sequence
  local packet = {
    protocol_version = PROTOCOL_VERSION,
    message_id = message_id,
    type = "hello",
    tick = game.tick,
    payload = {
      mod_version = script.active_mods["factorio-ai-assistant"] or "unknown",
    },
  }

  local encoded = helpers.table_to_json(packet)
  local success, error_message = pcall(
    helpers.send_udp,
    get_companion_port(),
    encoded
  )

  state.last_hello_tick = game.tick

  if not success then
    state.connected = false
    log("[factorio-ai-assistant] UDP send failed: " .. tostring(error_message))
    refresh_all_ui()
    return false
  end

  state.pending[message_id] = game.tick
  return true
end

local function poll_udp()
  if not UDP_AVAILABLE then
    return
  end

  local state = get_state()
  local success, error_message = pcall(helpers.recv_udp)

  if success then
    state.receive_error_logged = false
    return
  end

  if not state.receive_error_logged then
    log("[factorio-ai-assistant] UDP receive failed: " .. tostring(error_message))
    state.receive_error_logged = true
  end
end

local function is_non_empty_string(value)
  return type(value) == "string" and value ~= ""
end

local function handle_udp_packet(event)
  if event.source_port ~= get_companion_port() then
    return
  end

  local raw_packet = event.payload
  if type(raw_packet) ~= "string" then
    return
  end

  local success, packet = pcall(helpers.json_to_table, raw_packet)
  if not success or type(packet) ~= "table" then
    return
  end

  if packet.protocol_version ~= PROTOCOL_VERSION
    or packet.type ~= "hello_ack"
    or not is_non_empty_string(packet.message_id)
    or type(packet.timestamp) ~= "number"
    or packet.timestamp < 0
    or type(packet.payload) ~= "table"
    or not is_non_empty_string(packet.payload.reply_to)
    or not is_non_empty_string(packet.payload.companion_version)
  then
    return
  end

  local state = get_state()
  if not state.pending[packet.payload.reply_to] then
    return
  end

  state.pending[packet.payload.reply_to] = nil
  state.connected = true
  state.last_response_tick = event.tick
  state.companion_version = packet.payload.companion_version
  refresh_all_ui()
end

local function update_connection_status()
  local state = get_state()
  cleanup_pending(state)

  if state.connected
    and state.last_response_tick
    and game.tick - state.last_response_tick > CONNECTION_TIMEOUT_TICKS
  then
    state.connected = false
  end

  refresh_all_ui()
end

local function initialize_player(player)
  ensure_button(player)
  refresh_player_ui(player)
end

script.on_init(function()
  get_state()

  for _, player in pairs(game.players) do
    initialize_player(player)
  end

  send_hello()
end)

script.on_configuration_changed(function()
  get_state()

  for _, player in pairs(game.players) do
    initialize_player(player)
  end

  send_hello()
end)

script.on_event(defines.events.on_player_created, function(event)
  local player = game.get_player(event.player_index)
  if player then
    initialize_player(player)
  end
end)

script.on_event(defines.events.on_player_joined_game, function(event)
  local player = game.get_player(event.player_index)
  if player then
    initialize_player(player)
    send_hello()
  end
end)

script.on_event(defines.events.on_gui_click, function(event)
  local element = event.element
  if not element.valid then
    return
  end

  local player = game.get_player(event.player_index)
  if not player then
    return
  end

  if element.name == BUTTON_NAME then
    local frame = mod_gui.get_frame_flow(player)[PANEL_NAME]
    if frame then
      frame.destroy()
    else
      open_panel(player)
    end
    return
  end

  if element.name == PING_BUTTON_NAME then
    send_hello()
    refresh_player_ui(player)
  end
end)

if UDP_AVAILABLE then
  script.on_event(UDP_EVENT, handle_udp_packet)
  script.on_nth_tick(POLL_INTERVAL_TICKS, poll_udp)
  script.on_nth_tick(HELLO_INTERVAL_TICKS, send_hello)
end

script.on_nth_tick(UI_REFRESH_INTERVAL_TICKS, update_connection_status)
