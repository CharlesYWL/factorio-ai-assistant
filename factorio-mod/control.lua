local mod_gui = require("__core__.lualib.mod-gui")
local state_collector = require("state_collector")

local PROTOCOL_VERSION = 1
local STATE_SCHEMA_VERSION = 2
local MAX_PACKET_BYTES = 16 * 1024
local POLL_INTERVAL_TICKS = 15
local UI_REFRESH_INTERVAL_TICKS = 60
local HELLO_INTERVAL_TICKS = 300
local SAMPLE_INTERVAL_TICKS = 300
local STATIC_RETRY_INTERVAL_TICKS = 300
local CONNECTION_TIMEOUT_TICKS = 600
local PENDING_TIMEOUT_TICKS = 1200

local BUTTON_NAME = "factorio-ai-assistant-toggle"
local PANEL_NAME = "factorio-ai-assistant-panel"
local STATUS_LABEL_NAME = "factorio-ai-assistant-status"
local LAST_RESPONSE_LABEL_NAME = "factorio-ai-assistant-last-response"
local ALERTS_LABEL_NAME = "factorio-ai-assistant-alerts"
local PING_BUTTON_NAME = "factorio-ai-assistant-ping"

local ADVISOR_RULE_IDS = {
  ["research-idle"] = true,
  ["power-low"] = true,
  ["lubricant-zero"] = true,
  ["oil-imbalance"] = true,
  ["robotics-stalled"] = true,
  ["material-deficit"] = true,
  ["production-decline"] = true,
}
local ADVISOR_SETTING_NAMES = {
  ["factorio-ai-assistant-advisor-quiet-mode"] = true,
  ["factorio-ai-assistant-advisor-muted-rules"] = true,
  ["factorio-ai-assistant-advisor-notification-cooldown-seconds"] = true,
  ["factorio-ai-assistant-advisor-critical-power-bypass"] = true,
  ["factorio-ai-assistant-advisor-recovery-seconds"] = true,
  ["factorio-ai-assistant-advisor-research-idle-minutes"] = true,
  ["factorio-ai-assistant-advisor-power-satisfaction-threshold"] = true,
  ["factorio-ai-assistant-advisor-critical-power-threshold"] = true,
  ["factorio-ai-assistant-advisor-power-low-seconds"] = true,
  ["factorio-ai-assistant-advisor-lubricant-zero-minutes"] = true,
  ["factorio-ai-assistant-advisor-oil-imbalance-minutes"] = true,
  ["factorio-ai-assistant-advisor-oil-surplus-min-per-minute"] = true,
  ["factorio-ai-assistant-advisor-petroleum-deficit-min-per-minute"] = true,
  ["factorio-ai-assistant-advisor-science-stable-minutes"] = true,
  ["factorio-ai-assistant-advisor-blue-science-min-per-minute"] = true,
  ["factorio-ai-assistant-advisor-material-deficit-ratio"] = true,
  ["factorio-ai-assistant-advisor-material-deficit-min-per-minute"] = true,
  ["factorio-ai-assistant-advisor-material-deficit-minutes"] = true,
  ["factorio-ai-assistant-advisor-crude-decline-ratio"] = true,
  ["factorio-ai-assistant-advisor-crude-baseline-min-per-minute"] = true,
  ["factorio-ai-assistant-advisor-crude-decline-minutes"] = true,
  ["factorio-ai-assistant-advisor-key-material-baseline-min-per-minute"] = true,
  ["factorio-ai-assistant-advisor-production-stop-minutes"] = true,
}
local ADVISOR_SEVERITIES = {
  info = true,
  warning = true,
  critical = true,
}
local ADVISOR_EVENTS = {
  opened = true,
  reminder = true,
  closed = true,
}

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
    static_pending = {},
    advisor_alerts = {},
    receive_error_logged = false,
    unsupported_version_logged = false,
  }

  local state = storage.factorio_ai_assistant
  state.sequence = state.sequence or 0
  state.pending = state.pending or {}
  state.static_pending = state.static_pending or {}
  state.advisor_alerts = state.advisor_alerts or {}
  state.receive_error_logged = state.receive_error_logged or false
  state.unsupported_version_logged = state.unsupported_version_logged or false

  return state
end

local function get_companion_port()
  return settings.startup["factorio-ai-assistant-companion-port"].value
end

local function get_advisor_config()
  local muted_rules = {}
  local seen_muted_rules = {}
  local muted_value =
    settings.global["factorio-ai-assistant-advisor-muted-rules"].value

  for rule_id in string.gmatch(muted_value, "[^,%s]+") do
    if ADVISOR_RULE_IDS[rule_id] and not seen_muted_rules[rule_id] then
      table.insert(muted_rules, rule_id)
      seen_muted_rules[rule_id] = true
    end
  end
  table.sort(muted_rules)

  local power_threshold =
    settings.global[
      "factorio-ai-assistant-advisor-power-satisfaction-threshold"
    ].value
  local critical_power_threshold = math.min(
    power_threshold,
    settings.global[
      "factorio-ai-assistant-advisor-critical-power-threshold"
    ].value
  )

  return {
    quiet_mode =
      settings.global["factorio-ai-assistant-advisor-quiet-mode"].value,
    muted_rules = muted_rules,
    notification_cooldown_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-notification-cooldown-seconds"
      ].value * 60,
    critical_power_bypass =
      settings.global[
        "factorio-ai-assistant-advisor-critical-power-bypass"
      ].value,
    recovery_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-recovery-seconds"
      ].value * 60,
    research_idle_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-research-idle-minutes"
      ].value * 3600,
    power_satisfaction_threshold = power_threshold,
    critical_power_threshold = critical_power_threshold,
    power_low_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-power-low-seconds"
      ].value * 60,
    lubricant_zero_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-lubricant-zero-minutes"
      ].value * 3600,
    oil_imbalance_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-oil-imbalance-minutes"
      ].value * 3600,
    oil_surplus_min_per_minute =
      settings.global[
        "factorio-ai-assistant-advisor-oil-surplus-min-per-minute"
      ].value,
    petroleum_deficit_min_per_minute =
      settings.global[
        "factorio-ai-assistant-advisor-petroleum-deficit-min-per-minute"
      ].value,
    science_stable_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-science-stable-minutes"
      ].value * 3600,
    blue_science_min_per_minute =
      settings.global[
        "factorio-ai-assistant-advisor-blue-science-min-per-minute"
      ].value,
    material_deficit_ratio =
      settings.global[
        "factorio-ai-assistant-advisor-material-deficit-ratio"
      ].value,
    material_deficit_min_per_minute =
      settings.global[
        "factorio-ai-assistant-advisor-material-deficit-min-per-minute"
      ].value,
    material_deficit_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-material-deficit-minutes"
      ].value * 3600,
    crude_decline_ratio =
      settings.global[
        "factorio-ai-assistant-advisor-crude-decline-ratio"
      ].value,
    crude_baseline_min_per_minute =
      settings.global[
        "factorio-ai-assistant-advisor-crude-baseline-min-per-minute"
      ].value,
    crude_decline_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-crude-decline-minutes"
      ].value * 3600,
    key_material_baseline_min_per_minute =
      settings.global[
        "factorio-ai-assistant-advisor-key-material-baseline-min-per-minute"
      ].value,
    production_stop_ticks =
      settings.global[
        "factorio-ai-assistant-advisor-production-stop-minutes"
      ].value * 3600,
  }
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

local function localized_rule(rule_id)
  return { "factorio-ai-assistant.rule-" .. rule_id }
end

local function localized_severity(severity)
  return { "factorio-ai-assistant.severity-" .. severity }
end

local function format_active_alerts(state, force_id)
  local alerts = {}
  for _, alert in pairs(state.advisor_alerts) do
    if alert.force_id == force_id then
      table.insert(alerts, alert)
    end
  end
  table.sort(alerts, function(left, right)
    return left.id < right.id
  end)

  if #alerts == 0 then
    return { "factorio-ai-assistant.no-active-alerts" }
  end

  local caption = {
    "",
    { "factorio-ai-assistant.active-alert-count", #alerts },
  }
  for _, alert in ipairs(alerts) do
    table.insert(caption, "\n")
    table.insert(caption, {
      "factorio-ai-assistant.alert-line",
      localized_severity(alert.severity),
      localized_rule(alert.rule_id),
      alert.evidence,
      alert.recommendation,
    })
  end
  return caption
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
  local alerts_label = frame[ALERTS_LABEL_NAME]

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

  if alerts_label then
    alerts_label.caption = format_active_alerts(state, player.force.name)
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
  local alerts_label = frame.add({
    type = "label",
    name = ALERTS_LABEL_NAME,
  })
  alerts_label.style.single_line = false
  alerts_label.style.maximal_width = 520
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

local function send_udp_payload(encoded, description)
  local success, error_message = pcall(
    helpers.send_udp,
    get_companion_port(),
    encoded
  )

  if not success then
    local state = get_state()
    state.connected = false
    log(
      "[factorio-ai-assistant] UDP "
        .. description
        .. " failed: "
        .. tostring(error_message)
    )
    refresh_all_ui()
    return false
  end

  return true
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
      advisor_config = get_advisor_config(),
    },
  }

  local encoded = helpers.table_to_json(packet)
  state.last_hello_tick = game.tick

  if not send_udp_payload(encoded, "hello send") then
    return false
  end

  state.pending[message_id] = game.tick
  return true
end

local function has_static_pending(state)
  return next(state.static_pending) ~= nil
end

local function transmit_static_packet(packet)
  packet.last_sent_tick = game.tick
  return send_udp_payload(packet.encoded, "state send")
end

local function queue_static_snapshot()
  if not UDP_AVAILABLE then
    return false
  end

  local state = get_state()
  local packets = state_collector.build_static_snapshot(state)

  if packets == nil then
    state_collector.invalidate_static(state)
    return false
  end

  state.static_pending = {}

  for _, packet in ipairs(packets) do
    state.static_pending[packet.message_id] = packet
    transmit_static_packet(packet)
  end

  return true
end

local function queue_static_delta(force)
  local state = get_state()

  if has_static_pending(state) then
    state_collector.invalidate_static(state)
    return
  end

  local packet, full_snapshot_required =
    state_collector.build_static_delta(state, force)

  if full_snapshot_required then
    queue_static_snapshot()
    return
  end

  if packet ~= nil then
    state.static_pending[packet.message_id] = packet
    transmit_static_packet(packet)
  end
end

local function retry_static_packets()
  local state = get_state()

  for _, packet in pairs(state.static_pending) do
    if game.tick - (packet.last_sent_tick or 0)
      >= STATIC_RETRY_INTERVAL_TICKS
    then
      transmit_static_packet(packet)
    end
  end

  if not has_static_pending(state)
    and state.connected
    and state_collector.static_is_dirty(state)
  then
    queue_static_snapshot()
  end
end

local function send_dynamic_snapshot()
  local state = get_state()

  if not UDP_AVAILABLE or not state.connected then
    return
  end

  local profiler = game.create_profiler()
  local result =
    state_collector.build_dynamic_snapshot(state, SAMPLE_INTERVAL_TICKS)

  profiler.stop()

  if result == nil then
    return
  end

  send_udp_payload(result.encoded, "dynamic snapshot send")

  if state_collector.should_log_sample(state, result.packet) then
    log(
      "[factorio-ai-assistant] State sample: interval="
        .. SAMPLE_INTERVAL_TICKS
        .. " ticks, duration="
        .. tostring(profiler)
        .. ", bytes="
        .. #result.encoded
        .. ", omitted_forces="
        .. result.packet.payload.omitted_forces
        .. ", omitted_series="
        .. result.packet.payload.omitted_series
    )
  end
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

local function is_non_empty_string(value, maximum_length)
  return type(value) == "string"
    and value ~= ""
    and #value <= (maximum_length or 128)
end

local function is_non_negative_integer(value)
  return type(value) == "number" and value >= 0 and value % 1 == 0
end

local function handle_hello_ack(packet, event)
  if not is_non_negative_integer(packet.timestamp)
    or not is_non_empty_string(packet.payload.reply_to)
    or not is_non_empty_string(packet.payload.companion_version)
    or (
      packet.payload.static_revision ~= nil
      and not is_non_negative_integer(packet.payload.static_revision)
    )
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

  if not has_static_pending(state)
    and packet.payload.static_revision ~= nil
    and packet.payload.static_revision
      ~= state_collector.static_revision(state)
  then
    state_collector.prepare_resync(
      state,
      packet.payload.static_revision
    )
  end

  if not has_static_pending(state)
    and state_collector.static_is_dirty(state)
  then
    queue_static_snapshot()
  end

  refresh_all_ui()
end

local function handle_state_ack(packet, event)
  if packet.schema_version ~= STATE_SCHEMA_VERSION
    or not is_non_negative_integer(packet.timestamp)
    or not is_non_empty_string(packet.payload.reply_to)
    or not is_non_negative_integer(packet.payload.revision)
    or packet.payload.revision == 0
  then
    return
  end

  local state = get_state()
  local pending = state.static_pending[packet.payload.reply_to]

  if pending == nil or pending.revision ~= packet.payload.revision then
    return
  end

  state.static_pending[packet.payload.reply_to] = nil
  state.connected = true
  state.last_response_tick = event.tick

  if not has_static_pending(state)
    and state_collector.static_is_dirty(state)
  then
    queue_static_snapshot()
  end

  refresh_all_ui()
end

local function handle_resync_request(packet, event)
  if packet.schema_version ~= STATE_SCHEMA_VERSION
    or not is_non_negative_integer(packet.timestamp)
    or not is_non_negative_integer(packet.payload.expected_revision)
  then
    return
  end

  local state = get_state()
  state.static_pending = {}
  state.connected = true
  state.last_response_tick = event.tick
  state_collector.prepare_resync(
    state,
    packet.payload.expected_revision
  )
  queue_static_snapshot()
  refresh_all_ui()
end

local function notify_proactive_alert(alert)
  if settings.global["factorio-ai-assistant-advisor-quiet-mode"].value then
    return
  end

  for _, player in pairs(game.connected_players) do
    if player.force.name == alert.force_id then
      player.print({
        "factorio-ai-assistant.proactive-alert",
        localized_severity(alert.severity),
        localized_rule(alert.rule_id),
        alert.evidence,
        alert.recommendation,
      })
    end
  end
end

local function handle_advisor_update(packet, event)
  local payload = packet.payload
  local alert = payload.alert

  if packet.schema_version ~= STATE_SCHEMA_VERSION
    or not is_non_negative_integer(packet.timestamp)
    or not ADVISOR_EVENTS[payload.event]
    or type(payload.proactive) ~= "boolean"
    or type(alert) ~= "table"
    or not is_non_empty_string(alert.id, 512)
    or not ADVISOR_RULE_IDS[alert.rule_id]
    or not is_non_empty_string(alert.force_id, 256)
    or not ADVISOR_SEVERITIES[alert.severity]
    or not is_non_empty_string(alert.evidence, 1024)
    or not is_non_empty_string(alert.recommendation, 1024)
    or not is_non_negative_integer(alert.first_seen)
    or not is_non_negative_integer(alert.last_seen)
    or alert.last_seen < alert.first_seen
    or alert.id ~= alert.rule_id .. ":" .. alert.force_id
    or (payload.event == "closed" and payload.proactive)
  then
    return
  end

  local state = get_state()
  if payload.event == "closed" then
    state.advisor_alerts[alert.id] = nil
  else
    state.advisor_alerts[alert.id] = alert
  end
  state.connected = true
  state.last_response_tick = event.tick

  if payload.proactive and payload.event ~= "closed" then
    notify_proactive_alert(alert)
  end

  refresh_all_ui()
end

local function handle_udp_packet(event)
  if event.source_port ~= get_companion_port() then
    return
  end

  local raw_packet = event.payload
  if type(raw_packet) ~= "string" or #raw_packet > MAX_PACKET_BYTES then
    return
  end

  local success, packet = pcall(helpers.json_to_table, raw_packet)
  if not success or type(packet) ~= "table" then
    return
  end

  if packet.protocol_version ~= PROTOCOL_VERSION
    or not is_non_empty_string(packet.message_id)
    or type(packet.payload) ~= "table"
  then
    return
  end

  if packet.type == "hello_ack" then
    handle_hello_ack(packet, event)
  elseif packet.type == "state_ack" then
    handle_state_ack(packet, event)
  elseif packet.type == "resync_request" then
    handle_resync_request(packet, event)
  elseif packet.type == "advisor_update" then
    handle_advisor_update(packet, event)
  end
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
  local state = get_state()
  state.static_pending = {}
  state_collector.initialize(state)
  state_collector.invalidate_static(state)

  for _, player in pairs(game.players) do
    initialize_player(player)
  end

  send_hello()
end)

script.on_configuration_changed(function()
  local state = get_state()
  state.static_pending = {}
  state_collector.initialize(state)
  state_collector.invalidate_static(state)

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

script.on_event(defines.events.on_runtime_mod_setting_changed, function(event)
  if ADVISOR_SETTING_NAMES[event.setting] then
    send_hello()
    refresh_all_ui()
  end
end)

local function handle_electric_pole_built(event)
  local entity = event.entity or event.destination

  if entity ~= nil then
    state_collector.track_electric_pole(get_state(), entity)
  end
end

local function handle_electric_pole_removed(event)
  if event.entity ~= nil then
    state_collector.untrack_electric_pole(get_state(), event.entity)
  end
end

local function handle_research_change(event)
  queue_static_delta(event.research.force)
end

local function handle_force_context_change()
  local state = get_state()
  state_collector.invalidate_static(state)

  if state.connected and not has_static_pending(state) then
    queue_static_snapshot()
  end
end

local ELECTRIC_POLE_FILTER = {
  {
    filter = "type",
    type = "electric-pole",
  },
}

script.on_event({
  defines.events.on_built_entity,
  defines.events.on_robot_built_entity,
  defines.events.script_raised_built,
  defines.events.script_raised_revive,
}, handle_electric_pole_built, ELECTRIC_POLE_FILTER)

script.on_event(
  defines.events.on_entity_cloned,
  handle_electric_pole_built,
  ELECTRIC_POLE_FILTER
)

script.on_event({
  defines.events.on_player_mined_entity,
  defines.events.on_robot_mined_entity,
  defines.events.on_entity_died,
  defines.events.script_raised_destroy,
}, handle_electric_pole_removed, ELECTRIC_POLE_FILTER)

script.on_event({
  defines.events.on_research_finished,
  defines.events.on_research_reversed,
}, handle_research_change)

script.on_event({
  defines.events.on_force_created,
  defines.events.on_forces_merged,
  defines.events.on_player_changed_force,
}, handle_force_context_change)

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

local function run_periodic_network_tasks()
  send_hello()
  retry_static_packets()
  send_dynamic_snapshot()
end

if UDP_AVAILABLE then
  script.on_event(UDP_EVENT, handle_udp_packet)
  script.on_nth_tick(POLL_INTERVAL_TICKS, poll_udp)
  script.on_nth_tick(HELLO_INTERVAL_TICKS, run_periodic_network_tasks)
end

script.on_nth_tick(UI_REFRESH_INTERVAL_TICKS, update_connection_status)
