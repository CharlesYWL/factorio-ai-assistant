local state_collector = require("state_collector")
local localization = require("localization")
local pause = require("pause")
local ui = require("ui")
local ui_state = require("ui_state")

local PROTOCOL_VERSION = 1
local STATE_SCHEMA_VERSION = 2
local MAX_PACKET_BYTES = 16 * 1024
local POLL_INTERVAL_TICKS = 15
local UI_REFRESH_INTERVAL_TICKS = 60
local HELLO_INTERVAL_TICKS = 300
local DEFAULT_SAMPLE_INTERVAL_TICKS = 300
local MIN_SAMPLE_INTERVAL_TICKS = 60
local MAX_SAMPLE_INTERVAL_TICKS = 3600
local STATIC_RETRY_INTERVAL_TICKS = 300
-- Ore fields do not move, and scanning every charted chunk is expensive, so
-- refresh them rarely: once every two game minutes.
local RESOURCE_INTERVAL_TICKS = 7200
local CONNECTION_TIMEOUT_TICKS = 600
local PENDING_TIMEOUT_TICKS = 1200
-- The Companion may need several model round trips for one question: it looks
-- recipes up, decides what to mark, then writes the answer. Waiting well past
-- its own budget is better than discarding an answer that is about to arrive.
local UI_REQUEST_TIMEOUT_TICKS = 14400

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
local ASSISTANT_MODES = {
  ["local"] = true,
  ["local-model"] = true,
  ["remote-model"] = true,
}
local ASSISTANT_RESPONSE_MODES = {
  ["local"] = true,
  model = true,
}
local PRIVACY_MODES = {
  ["local-only"] = true,
  ["remote-provider"] = true,
}
local RESPONSE_STATUSES = {
  ok = true,
  cancelled = true,
  error = true,
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
    sampling_interval_ticks = DEFAULT_SAMPLE_INTERVAL_TICKS,
    last_dynamic_tick = nil,
    receive_error_logged = false,
    unsupported_version_logged = false,
    ui_players = {},
    toast_expiry = {},
    highlights = {},
    highlight_tags = {},
  }

  local state = storage.factorio_ai_assistant
  state.sequence = state.sequence or 0
  state.pending = state.pending or {}
  state.static_pending = state.static_pending or {}
  state.advisor_alerts = state.advisor_alerts or {}
  state.highlights = state.highlights or {}
  state.highlight_tags = state.highlight_tags or {}
  state.sampling_interval_ticks =
    state.sampling_interval_ticks or DEFAULT_SAMPLE_INTERVAL_TICKS
  state.receive_error_logged = state.receive_error_logged or false
  state.unsupported_version_logged = state.unsupported_version_logged or false
  state.ui_players = state.ui_players or {}
  state.toast_expiry = state.toast_expiry or {}
  state.protocol_version = PROTOCOL_VERSION
  state.schema_version = STATE_SCHEMA_VERSION
  state.mod_version =
    script.active_mods["factorio-ai-assistant"] or "unknown"

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

local function localized_rule(rule_id)
  return { "factorio-ai-assistant.rule-" .. rule_id }
end

local function localized_severity(severity)
  return { "factorio-ai-assistant.severity-" .. severity }
end

local function refresh_player_ui(player)
  if not player.valid then
    return
  end

  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  ui.ensure_button(player)
  ui.refresh_alerts_hud(player, state, player_state)
  ui.render(player, state, player_state)
end

local function refresh_all_ui()
  for _, player in pairs(game.players) do
    refresh_player_ui(player)
  end
end

local function refresh_all_status()
  local state = get_state()
  for _, player in pairs(game.players) do
    ui.ensure_button(player)
    ui.refresh_status(player, state)
  end
end

--- Every way of showing the advisor goes through these three helpers: the top
--- button, the toggle shortcut, the tab shortcuts, the alert cards and the mock
--- harness. Auto-pause is only correct while a single open and a single close
--- path own it.
--- Opens the panel. `claim_pause` is false when the panel opens by itself
-- rather than because the player asked for it: freezing the game because an
-- answer happened to arrive would interrupt whatever they walked off to do.
local function open_advisor(player, claim_pause)
  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  local was_open = ui.is_open(player)

  ui.open(player, state, player_state)

  if claim_pause ~= false and not was_open and ui.is_open(player) then
    pause.on_panel_opened(player, player_state)
  end
  return player_state
end

local function close_advisor(player)
  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)

  -- Save on the way out too: dragging fires on_gui_location_changed, but a
  -- resize can shift the frame without that event, and the player expects the
  -- panel to reopen where they last left it.
  ui.save_location(player, player_state)
  -- The input is a GUI element, so closing destroys whatever was typed. Keep
  -- it: a half-written question should survive an accidental Esc.
  ui.save_draft(player, player_state)
  ui.close(player)
  pause.on_panel_closed(player_state)
end

local function toggle_advisor(player)
  if ui.is_open(player) then
    close_advisor(player)
  else
    open_advisor(player)
  end
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
    refresh_all_status()
    return false
  end

  return true
end

local function next_message_id(state, kind)
  state.sequence = state.sequence + 1
  return "factorio-" .. kind .. "-" .. game.tick .. "-" .. state.sequence
end

local function send_ui_packet(packet, description)
  local encoded = helpers.table_to_json(packet)
  if #encoded > MAX_PACKET_BYTES then
    log(
      "[factorio-ai-assistant] "
        .. description
        .. " exceeds packet limit: "
        .. #encoded
    )
    return false
  end
  return send_udp_payload(encoded, description)
end

local function trim(value)
  return string.match(value or "", "^%s*(.-)%s*$")
end

local function utf8_length(value)
  local _, count = string.gsub(value, "[^\128-\191]", "")
  return count
end

local CHAT_HISTORY_SETTING = "factorio-ai-assistant-send-chat-history"
local MAX_HISTORY_TURNS = 4
local MAX_HISTORY_TEXT = 2000

-- Opt-in only. The Mod owns the transcript, so history is read from this
-- player's own state and can never carry another player's questions.
local function collect_chat_history(player, player_state)
  local player_settings = settings.get_player_settings(player)
  local setting = player_settings ~= nil
    and player_settings[CHAT_HISTORY_SETTING]
    or nil
  if setting == nil or setting.value ~= true then
    return nil
  end

  local entries = player_state.chat_history or {}
  local turns = {}

  -- Walk backwards pairing each assistant answer with the question above it,
  -- then reverse so the model sees the exchanges oldest first.
  local index = #entries
  while index > 1 and #turns < MAX_HISTORY_TURNS do
    local answer = entries[index]
    local question = entries[index - 1]
    if answer.role == "assistant" and question.role == "user" then
      local question_text = question.text
      local answer_text = answer.text
      if type(question_text) == "string"
        and type(answer_text) == "string"
        and question_text ~= ""
        and answer_text ~= ""
        and utf8_length(question_text) <= MAX_HISTORY_TEXT
        and utf8_length(answer_text) <= MAX_HISTORY_TEXT
      then
        table.insert(turns, { question = question_text, answer = answer_text })
      end
      index = index - 2
    else
      index = index - 1
    end
  end

  if #turns == 0 then
    return nil
  end

  local ordered = {}
  for position = #turns, 1, -1 do
    table.insert(ordered, turns[position])
  end
  return ordered
end

local function send_chat_request(player, question)
  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  question = trim(question)
  if state.protocol_mismatch ~= nil
    or state.component_version_mismatch ~= nil
    or (state.connected and state.assistant_status == nil)
  then
    ui_state.append_system(
      player_state,
      "protocol-incompatible",
      game.tick
    )
    ui.render(player, state, player_state)
    return
  end
  if not state.connected then
    ui_state.append_system(player_state, "chat-offline", game.tick)
    ui.render(player, state, player_state)
    return
  end
  if question == ""
    or #question > 4096
    or utf8_length(question) > 2000
  then
    ui_state.append_system(player_state, "chat-invalid-input", game.tick)
    ui.render(player, state, player_state)
    return
  end
  if player_state.chat_pending ~= nil then
    return
  end

  local message_id = next_message_id(state, "assistant")
  local packet = {
    protocol_version = PROTOCOL_VERSION,
    schema_version = STATE_SCHEMA_VERSION,
    message_id = message_id,
    type = "assistant_request",
    tick = game.tick,
    payload = {
      force_id = player.force.name,
      question = question,
    },
  }
  local history = collect_chat_history(player, player_state)
  if history ~= nil then
    packet.payload.history = history
  end
  if not send_ui_packet(packet, "assistant request") then
    ui_state.append_system(player_state, "chat-offline", game.tick)
    ui.render(player, state, player_state)
    return
  end

  ui_state.queue_chat(player_state, message_id, question, game.tick)
  ui.render(player, state, player_state)
end

local function cancel_chat_request(player)
  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  local request_id = ui_state.cancel_chat(player_state, game.tick)
  if request_id ~= nil and state.connected then
    send_ui_packet({
      protocol_version = PROTOCOL_VERSION,
      schema_version = STATE_SCHEMA_VERSION,
      message_id = next_message_id(state, "cancel"),
      type = "assistant_cancel",
      tick = game.tick,
      payload = {
        request_id = request_id,
      },
    }, "assistant cancellation")
  end
  ui.render(player, state, player_state)
end

local function clear_chat_history(player)
  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  local request_id = ui_state.clear_chat(player_state)
  if request_id ~= nil and state.connected then
    send_ui_packet({
      protocol_version = PROTOCOL_VERSION,
      schema_version = STATE_SCHEMA_VERSION,
      message_id = next_message_id(state, "cancel"),
      type = "assistant_cancel",
      tick = game.tick,
      payload = {
        request_id = request_id,
      },
    }, "assistant cancellation")
  end
  ui.render(player, state, player_state)
end

local function send_hello()
  local state = get_state()

  if not UDP_AVAILABLE then
    state.connected = false
    if not state.unsupported_version_logged then
      log("[factorio-ai-assistant] Lua UDP requires Factorio 2.0.59 or newer")
      state.unsupported_version_logged = true
    end
    refresh_all_status()
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

  local sampling_interval_ticks = state.sampling_interval_ticks
  state.last_dynamic_tick = game.tick
  local profiler = game.create_profiler()
  local result =
    state_collector.build_dynamic_snapshot(state, sampling_interval_ticks)

  profiler.stop()

  if result == nil then
    return
  end

  -- A sample may span several datagrams; every chunk must go out or the
  -- Companion discards the incomplete sample.
  local chunks = result.packets or { result }

  for _, chunk in ipairs(chunks) do
    for _, force_summary in ipairs(chunk.packet.payload.forces) do
      localization.register_force_summary(state, force_summary)
    end
  end

  local total_bytes = 0
  for _, chunk in ipairs(chunks) do
    send_udp_payload(chunk.encoded, "dynamic snapshot send")
    total_bytes = total_bytes + #chunk.encoded
  end

  if state_collector.should_log_sample(state, result.packet) then
    log(
      "[factorio-ai-assistant] State sample: interval="
        .. sampling_interval_ticks
        .. " ticks, duration="
        .. tostring(profiler)
        .. ", bytes="
        .. total_bytes
        .. ", chunks="
        .. #chunks
        .. ", omitted_forces="
        .. result.packet.payload.omitted_forces
        .. ", omitted_series="
        .. result.packet.payload.omitted_series
    )
  end
end

local function send_area_snapshot(player, area, entities)
  local state = get_state()

  if not UDP_AVAILABLE or not state.connected then
    return false
  end

  state.selection_sequence = (state.selection_sequence or 0) + 1
  local selection_id = state.selection_sequence
  local profiler = game.create_profiler()
  local result = state_collector.build_area_snapshot(
    state,
    player.force.name,
    selection_id,
    area,
    entities
  )
  profiler.stop()

  if result == nil then
    return false
  end

  -- Every chunk must arrive or the Companion discards the selection, the same
  -- contract dynamic samples use.
  for _, chunk in ipairs(result.packets) do
    if not send_udp_payload(chunk.encoded, "area snapshot send") then
      return false
    end
  end

  log(
    "[factorio-ai-assistant] Area selection: entities="
      .. result.detailed_count
      .. ", omitted="
      .. result.omitted
      .. ", chunks="
      .. #result.packets
      .. ", duration="
      .. tostring(profiler)
  )
  return true
end

--- Sends the charted ore fields, so the model knows where things are.
-- Scanning walks every charted chunk, which is far too expensive for the 5s
-- sample loop, but ore does not move: a slow refresh is entirely adequate.
local function maybe_send_resource_snapshot()
  local state = get_state()
  if state.last_resource_tick ~= nil
    and game.tick - state.last_resource_tick < RESOURCE_INTERVAL_TICKS
  then
    return
  end

  local player = game.players[1]
  local force_name = player ~= nil and player.force.name or "player"
  local profiler = game.create_profiler()
  local ok, packet = pcall(
    state_collector.build_resource_snapshot,
    state,
    force_name
  )
  profiler.stop()
  if not ok or packet == nil then
    -- Try again next cycle rather than never: a transient failure here should
    -- not silently disable map awareness for the rest of the session.
    state.last_resource_tick = game.tick
    return
  end

  state.last_resource_tick = game.tick
  local encoded = helpers.table_to_json(packet)
  if #encoded > MAX_PACKET_BYTES then
    log("[factorio-ai-assistant] Resource snapshot too large; skipped")
    return
  end
  send_udp_payload(encoded, "resource snapshot send")
  log(
    "[factorio-ai-assistant] Resource scan: patches="
      .. #packet.payload.patches
      .. ", omitted="
      .. packet.payload.omitted_patches
      .. ", duration="
      .. tostring(profiler)
  )
end

local function maybe_send_dynamic_snapshot()
  local state = get_state()
  if state.last_dynamic_tick ~= nil
    and game.tick - state.last_dynamic_tick < state.sampling_interval_ticks
  then
    return
  end

  send_dynamic_snapshot()
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

local function is_valid_assistant_status(value)
  return type(value) == "table"
    and ASSISTANT_MODES[value.mode]
    and is_non_empty_string(value.provider, 256)
    and (
      value.model == nil
      or is_non_empty_string(value.model, 256)
    )
    and is_non_empty_string(value.reason, 512)
    and PRIVACY_MODES[value.privacy]
end

local function handle_hello_ack(packet, event)
  if not is_non_negative_integer(packet.timestamp)
    or not is_non_empty_string(packet.payload.reply_to)
    or not is_non_empty_string(packet.payload.companion_version)
    or (
      packet.payload.static_revision ~= nil
      and not is_non_negative_integer(packet.payload.static_revision)
    )
    or (
      packet.payload.sampling_interval_ticks ~= nil
      and (
        not is_non_negative_integer(packet.payload.sampling_interval_ticks)
        or packet.payload.sampling_interval_ticks < MIN_SAMPLE_INTERVAL_TICKS
        or packet.payload.sampling_interval_ticks > MAX_SAMPLE_INTERVAL_TICKS
      )
    )
    or (
      packet.payload.assistant_status ~= nil
      and not is_valid_assistant_status(packet.payload.assistant_status)
    )
    or (
      packet.payload.localized_name_count ~= nil
      and not is_non_negative_integer(packet.payload.localized_name_count)
    )
  then
    return
  end

  local state = get_state()
  if not state.pending[packet.payload.reply_to] then
    return
  end

  local was_connected = state.connected
  state.pending[packet.payload.reply_to] = nil
  state.connected = true
  state.last_response_tick = event.tick
  state.companion_version = packet.payload.companion_version
  state.static_revision = packet.payload.static_revision or 0
  state.protocol_mismatch = nil
  state.component_version_mismatch = nil
  if packet.payload.companion_version ~= state.mod_version then
    state.connected = false
    state.component_version_mismatch = {
      mod_version = state.mod_version,
      companion_version = packet.payload.companion_version,
    }
    state.assistant_status = nil
    state.static_pending = {}
    refresh_all_status()
    return
  end

  state.assistant_status = packet.payload.assistant_status
  if packet.payload.sampling_interval_ticks ~= nil then
    state.sampling_interval_ticks = packet.payload.sampling_interval_ticks
  end

  local companion_name_count = packet.payload.localized_name_count
  if companion_name_count ~= nil then
    -- Idempotent reconciliation: a restarted Companion reports an empty cache and
    -- a lost datagram shows up as a count gap, so both self-heal on the next hello.
    if localization.needs_resend(state, companion_name_count) then
      localization.resend_all(state)
    end
  elseif not was_connected then
    localization.resend_all(state)
  end

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

  refresh_all_status()
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
  state.last_sync_tick = event.tick
  state.static_revision = packet.payload.revision

  if not has_static_pending(state)
    and state_collector.static_is_dirty(state)
  then
    queue_static_snapshot()
  end

  refresh_all_status()
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
  refresh_all_status()
end

local function notify_proactive_alert(alert)
  if settings.global["factorio-ai-assistant-advisor-quiet-mode"].value then
    return
  end

  local state = get_state()
  for _, player in pairs(game.connected_players) do
    if player.force.name == alert.force_id then
      local player_state = ui_state.ensure_player(state, player.index)
      if not ui_state.is_alert_dismissed(player_state, alert) then
        ui.show_toast(player, state, alert)
      end
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
    ui_state.forget_alert(state, alert.id)
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

local HIGHLIGHT_SEVERITIES = {
  problem = { 1, 0.25, 0.2 },
  warning = { 1, 0.75, 0.15 },
  info = { 0.4, 0.75, 1 },
}
local MAX_HIGHLIGHT_MARKERS = 12
local MAX_HIGHLIGHT_DURATION_SECONDS = 300
--- Icon carried by the advisor's own alerts, which is also the filter that
--- removes them: clearing must not touch the player's other alerts.
local HIGHLIGHT_ALERT_ICON = { type = "virtual", name = "signal-alert" }
--- Only real problems become alerts. A suggestion ("build an outpost here") is
--- not something going wrong, and the alert list is where players look for
--- things that are.
local ALERT_SEVERITIES = { problem = true, warning = true }

--- Removes every marker drawn for an earlier answer, including its map tag.
local function clear_highlights(state)
  for _, id in ipairs(state.highlights or {}) do
    local object = rendering.get_object_by_id(id)
    if object ~= nil and object.valid then
      object.destroy()
    end
  end
  state.highlights = {}

  -- Map tags belong to a force rather than to the rendering system, so they
  -- have to be looked up and destroyed separately. Group by force and surface
  -- so the tag list is scanned once rather than once per marker.
  local wanted = {}
  for _, record in ipairs(state.highlight_tags or {}) do
    local key = record.force .. "\0" .. record.surface
    local group = wanted[key]
    if group == nil then
      group = { force = record.force, surface = record.surface, numbers = {} }
      wanted[key] = group
    end
    group.numbers[record.number] = true
  end

  for _, group in pairs(wanted) do
    local force = game.forces[group.force]
    if force ~= nil and force.valid then
      local found_ok, tags = pcall(force.find_chart_tags, group.surface)
      if found_ok and tags ~= nil then
        for _, tag in ipairs(tags) do
          if tag.valid and group.numbers[tag.tag_number] then
            tag.destroy()
          end
        end
      end
    end
  end
  state.highlight_tags = {}

  -- Alerts are per force and identified by our own icon, so this removes only
  -- what the advisor raised.
  for _, force in pairs(game.forces) do
    if force.valid then
      pcall(force.remove_alert, { icon = HIGHLIGHT_ALERT_ICON })
    end
  end
end

--- Clears every marker and tells the player, when there was something to clear.
local function clear_highlights_for(player)
  local state = get_state()
  local removed = #(state.highlights or {}) + #(state.highlight_tags or {})
  clear_highlights(state)
  if removed > 0 then
    player.print({ "factorio-ai-assistant.highlights-cleared" })
  end
end

--- Draws a box, a label and a map tag on each marked entity.
-- Markers persist until the player clears them: a timer that expires while
-- they are still walking over is worse than one stale box.
local function handle_highlight(packet, event)
  local payload = packet.payload
  if packet.schema_version ~= STATE_SCHEMA_VERSION
    or not is_non_negative_integer(packet.timestamp)
    or not is_non_empty_string(payload.request_id, 256)
    or not is_non_negative_integer(payload.duration_seconds)
    or payload.duration_seconds > MAX_HIGHLIGHT_DURATION_SECONDS
    or type(payload.markers) ~= "table"
    or #payload.markers == 0
    or #payload.markers > MAX_HIGHLIGHT_MARKERS
  then
    return
  end

  local state = get_state()
  state.connected = true
  state.last_response_tick = event.tick

  -- A new answer replaces the previous set rather than stacking on it.
  clear_highlights(state)

  -- Map tags belong to a force. The selection came from the player's force, so
  -- that is who should see the tags.
  local force = game.forces.player

  for _, marker in ipairs(payload.markers) do
    local colour = type(marker) == "table"
      and HIGHLIGHT_SEVERITIES[marker.severity]
      or nil
    if colour ~= nil and is_non_empty_string(marker.text, 60) then
      local entity = nil
      if is_non_negative_integer(marker.unit) then
        local found_ok, found = pcall(
          game.get_entity_by_unit_number,
          marker.unit
        )
        if found_ok and found ~= nil and found.valid then
          entity = found
        end
      end

      -- Prefer the entity, so the box sits where it actually is; fall back to
      -- the position the Companion recorded when the entity is gone.
      local surface = entity ~= nil and entity.surface or game.surfaces[1]
      local position = entity ~= nil and entity.position or nil
      if position == nil
        and type(marker.x) == "number"
        and type(marker.y) == "number"
      then
        position = { x = marker.x, y = marker.y }
      end

      if position ~= nil and surface ~= nil then
        local box = rendering.draw_rectangle({
          color = colour,
          width = 3,
          filled = false,
          left_top = { position.x - 0.6, position.y - 0.6 },
          right_bottom = { position.x + 0.6, position.y + 0.6 },
          surface = surface,
        })
        table.insert(state.highlights, box.id)

        local label = rendering.draw_text({
          text = marker.text,
          surface = surface,
          target = { position.x, position.y - 1.1 },
          color = colour,
          scale = 1.2,
          alignment = "center",
        })
        table.insert(state.highlights, label.id)

        -- The world markers are only visible on screen, so mirror each one as a
        -- map tag: that is what makes a marked machine findable from the map.
        if force ~= nil and force.valid then
          local tag_ok, tag = pcall(force.add_chart_tag, surface, {
            position = position,
            text = marker.text,
          })
          if tag_ok and tag ~= nil and tag.valid then
            table.insert(state.highlight_tags, {
              number = tag.tag_number,
              force = force.name,
              surface = surface.name,
            })
          end

          -- A problem also goes to the alert list, which is where players
          -- already look for things going wrong: hovering shows the message and
          -- clicking opens the map at the machine. Needs a real entity, since
          -- that is what the engine focuses on.
          if entity ~= nil and ALERT_SEVERITIES[marker.severity] then
            pcall(
              force.add_custom_alert,
              entity,
              HIGHLIGHT_ALERT_ICON,
              marker.text,
              true
            )
          end
        end
      end
    end
  end
end

local function is_optional_string(value, maximum_length)
  return value == nil or is_non_empty_string(value, maximum_length)
end

local function handle_assistant_response(packet, event)
  local payload = packet.payload
  if packet.schema_version ~= STATE_SCHEMA_VERSION
    or not is_non_negative_integer(packet.timestamp)
    or not is_non_empty_string(payload.reply_to)
    or not RESPONSE_STATUSES[payload.status]
    or (
      payload.status == "ok"
      and (
        not ASSISTANT_RESPONSE_MODES[payload.mode]
        or not is_non_empty_string(payload.text, 8192)
        or not is_optional_string(payload.provider, 256)
        or not is_optional_string(payload.model, 256)
        or not is_optional_string(payload.fallback_reason, 128)
        or payload.error_code ~= nil
        or payload.error_message ~= nil
      )
    )
    or (
      payload.status == "cancelled"
      and (
        payload.mode ~= nil
        or payload.text ~= nil
        or payload.error_code ~= nil
        or payload.error_message ~= nil
      )
    )
    or (
      payload.status == "error"
      and (
        not is_non_empty_string(payload.error_code, 128)
        or not is_non_empty_string(payload.error_message, 1024)
        or payload.mode ~= nil
        or payload.text ~= nil
      )
    )
  then
    return
  end

  local state = get_state()
  state.connected = true
  state.last_response_tick = event.tick
  local player_index =
    ui_state.complete_chat(state, payload.reply_to, payload, event.tick)
  if player_index ~= nil then
    local player = game.get_player(player_index)
    if player ~= nil then
      local player_state = ui_state.ensure_player(state, player_index)
      -- A question asked with /ai is answered in chat, because the player who
      -- used the command may not have the panel open at all.
      local from_chat_command = state.chat_command_requests ~= nil
        and state.chat_command_requests[payload.reply_to] ~= nil
      if from_chat_command then
        state.chat_command_requests[payload.reply_to] = nil
        if payload.status == "ok" and payload.text ~= nil then
          player.print(payload.text)
        elseif payload.status == "error" then
          player.print({ "factorio-ai-assistant.ai-command-failed" })
        end
      end

      -- An answer can take a couple of minutes, so the player may well have
      -- closed the panel and walked off. Reopen it in mini mode rather than
      -- letting the answer sit unseen; it restores their previous size once
      -- they switch out of mini. A /ai question is excluded: that player chose
      -- to stay out of the panel, and already has the answer in chat.
      if not from_chat_command
        and not ui.is_open(player)
        and payload.status == "ok"
        and is_non_empty_string(payload.text)
      then
        if not ui_state.is_mini(player_state) then
          ui_state.toggle_mini(player_state)
        end
        -- Through open_advisor so the panel opens the same way everywhere, but
        -- without claiming the pause: the player did not ask for this.
        open_advisor(player, false)
      else
        ui.render(player, state, player_state)
      end
    end
  end
end

local function is_non_negative_number(value)
  return type(value) == "number"
    and value >= 0
    and value == value
    and value < math.huge
end

local function is_valid_resource_rate(value)
  return type(value) == "table"
    and (value.kind == "item" or value.kind == "fluid")
    and is_non_empty_string(value.id, 256)
    and is_non_negative_number(value.per_minute)
end

local function is_valid_resource_rates(values)
  if type(values) ~= "table" or #values > 16 then
    return false
  end
  for _, value in ipairs(values) do
    if not is_valid_resource_rate(value) then
      return false
    end
  end
  return true
end

local function is_valid_recipe_summary(value)
  if type(value) ~= "table"
    or not is_non_empty_string(value.recipe_id, 256)
    or not is_non_empty_string(value.machine_id, 256)
    or not is_non_negative_number(value.machines_exact)
    or not is_non_negative_integer(value.machines_rounded_up)
    or type(value.module_ids) ~= "table"
    or #value.module_ids > 16
  then
    return false
  end
  for _, module_id in ipairs(value.module_ids) do
    if not is_non_empty_string(module_id, 256) then
      return false
    end
  end
  return true
end

local function is_valid_calculation_result(value)
  if type(value) ~= "table"
    or not is_valid_resource_rate(value.target)
    or type(value.recipes) ~= "table"
    or #value.recipes > 16
    or not is_valid_resource_rates(value.external_inputs)
    or not is_valid_resource_rates(value.byproducts)
    or not is_non_empty_string(value.rounding, 512)
    or type(value.truncated) ~= "boolean"
  then
    return false
  end
  for _, recipe in ipairs(value.recipes) do
    if not is_valid_recipe_summary(recipe) then
      return false
    end
  end
  return true
end

local function handle_calculation_response(packet, event)
  local payload = packet.payload
  if packet.schema_version ~= STATE_SCHEMA_VERSION
    or not is_non_negative_integer(packet.timestamp)
    or not is_non_empty_string(payload.reply_to)
    or (payload.status ~= "ok" and payload.status ~= "error")
    or (
      payload.status == "ok"
      and (
        not is_valid_calculation_result(payload.result)
        or payload.error_code ~= nil
        or payload.error_message ~= nil
      )
    )
    or (
      payload.status == "error"
      and (
        payload.result ~= nil
        or not is_non_empty_string(payload.error_code, 128)
        or not is_non_empty_string(payload.error_message, 1024)
      )
    )
  then
    return
  end

  local state = get_state()
  state.connected = true
  state.last_response_tick = event.tick
  if payload.status == "ok" then
    localization.register_calculation_result(state, payload.result)
    localization.refresh(state)
  end
  -- The player-facing calculator form is gone; chat now drives every
  -- calculation through the Companion. A response is still validated and
  -- consumed so a mixed Mod/Companion install cannot leave a request pending.
  ui_state.complete_calculation(state, payload.reply_to, payload)
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

  if packet.protocol_version ~= PROTOCOL_VERSION then
    if is_non_negative_integer(packet.protocol_version) then
      local state = get_state()
      state.connected = false
      state.assistant_status = nil
      state.protocol_mismatch = packet.protocol_version
      state.component_version_mismatch = nil
      refresh_all_status()
    end
    return
  end

  if not is_non_empty_string(packet.message_id)
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
  elseif packet.type == "highlight" then
    handle_highlight(packet, event)
  elseif packet.type == "assistant_response" then
    handle_assistant_response(packet, event)
  elseif packet.type == "calculation_response" then
    handle_calculation_response(packet, event)
  end
end

local function update_connection_status()
  local state = get_state()
  local connection_changed = false
  cleanup_pending(state)

  if state.connected
    and state.last_response_tick
    and game.tick - state.last_response_tick > CONNECTION_TIMEOUT_TICKS
  then
    state.connected = false
    connection_changed = true
  end

  local expired = ui_state.expire_requests(
    state,
    game.tick,
    UI_REQUEST_TIMEOUT_TICKS
  )
  for _, player_index in ipairs(expired) do
    local player = game.get_player(player_index)
    if player ~= nil then
      ui.render(
        player,
        state,
        ui_state.ensure_player(state, player_index)
      )
    end
  end
  ui.expire_toasts(state, game.tick)
  if connection_changed then
    refresh_all_ui()
  else
    refresh_all_status()
  end
end

local function initialize_player(player)
  ui.ensure_button(player)
  ui_state.ensure_player(get_state(), player.index)
  refresh_player_ui(player)
end

script.on_init(function()
  local state = get_state()
  state.static_pending = {}
  state_collector.initialize(state)
  state_collector.invalidate_static(state)
  localization.invalidate(state)

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
  localization.invalidate(state)
  -- Render ids do not survive a version change, so drop the stale handles
  -- rather than let them accumulate forever. Map tags do survive, so clear
  -- them properly first.
  clear_highlights(state)

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

script.on_event(defines.events.on_player_left_game, function(event)
  local player = game.get_player(event.player_index)
  if player then
    close_advisor(player)
  end
end)

script.on_event(defines.events.on_player_removed, function(event)
  local state = get_state()
  local player_state = (state.ui_players or {})[event.player_index]
  if player_state ~= nil then
    pause.on_panel_closed(player_state)
    state.ui_players[event.player_index] = nil
  end
  if state.toast_expiry ~= nil then
    state.toast_expiry[event.player_index] = nil
  end
end)

script.on_event(defines.events.on_runtime_mod_setting_changed, function(event)
  if ADVISOR_SETTING_NAMES[event.setting] then
    send_hello()
    refresh_all_ui()
  elseif event.setting == pause.SETTING_NAME then
    local player = event.player_index ~= nil
      and game.get_player(event.player_index)
      or nil
    if player ~= nil then
      refresh_player_ui(player)
    else
      refresh_all_ui()
    end
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

for _, event_id in ipairs({
  defines.events.on_built_entity,
  defines.events.on_robot_built_entity,
  defines.events.script_raised_built,
  defines.events.script_raised_revive,
}) do
  script.on_event(event_id, handle_electric_pole_built, ELECTRIC_POLE_FILTER)
end

script.on_event(
  defines.events.on_entity_cloned,
  handle_electric_pole_built,
  ELECTRIC_POLE_FILTER
)

for _, event_id in ipairs({
  defines.events.on_player_mined_entity,
  defines.events.on_robot_mined_entity,
  defines.events.on_entity_died,
  defines.events.script_raised_destroy,
}) do
  script.on_event(event_id, handle_electric_pole_removed, ELECTRIC_POLE_FILTER)
end

script.on_event({
  defines.events.on_research_finished,
  defines.events.on_research_reversed,
}, handle_research_change)

script.on_event({
  defines.events.on_force_created,
  defines.events.on_forces_merged,
  defines.events.on_player_changed_force,
}, handle_force_context_change)

script.on_event(defines.events.on_string_translated, function(event)
  localization.handle_translation(get_state(), event)
end)

if defines.events.on_player_locale_changed ~= nil then
  script.on_event(defines.events.on_player_locale_changed, function()
    localization.refresh(get_state())
  end)
end

local QUICK_QUESTIONS = {
  ["zh-CN"] = {
    ["quick-1-question"] = "当前最大的生产瓶颈是什么？",
    ["quick-2-question"] = "下一步应该优先扩建什么？",
    ["quick-3-question"] = "当前电力和科研状态怎么样？",
    ["quick-4-question"] = "每分钟 45 个蓝瓶需要多少台机器？",
  },
  en = {
    ["quick-1-question"] = "What is the largest production bottleneck?",
    ["quick-2-question"] = "What should I expand next?",
    ["quick-3-question"] = "How are power and research doing?",
    ["quick-4-question"] =
      "How many machines do I need for 45 chemical science per minute?",
  },
}

local function quick_question(player, key)
  local language =
    type(player.locale) == "string"
      and string.sub(player.locale, 1, 2) == "zh"
      and "zh-CN"
    or "en"
  return QUICK_QUESTIONS[language][key]
end

local function set_rule_muted(player, rule_id, muted)
  if not ADVISOR_RULE_IDS[rule_id] then
    return
  end
  local muted_rules = {}
  local seen = {}
  local current =
    settings.global["factorio-ai-assistant-advisor-muted-rules"].value
  for existing in string.gmatch(current, "[^,%s]+") do
    if ADVISOR_RULE_IDS[existing] and not seen[existing] then
      table.insert(muted_rules, existing)
      seen[existing] = true
    end
  end
  if muted and not seen[rule_id] then
    table.insert(muted_rules, rule_id)
  elseif not muted and seen[rule_id] then
    for index = #muted_rules, 1, -1 do
      if muted_rules[index] == rule_id then
        table.remove(muted_rules, index)
      end
    end
  end
  table.sort(muted_rules)

  local success, error_message = pcall(function()
    settings.global[
      "factorio-ai-assistant-advisor-muted-rules"
    ] = { value = table.concat(muted_rules, ",") }
  end)
  if not success then
    player.print({
      "factorio-ai-assistant.setting-update-failed",
      tostring(error_message),
    })
    return
  end
  send_hello()
  refresh_all_ui()
end

local function set_alert_dismissed(player, alert_id, dismissed)
  if type(alert_id) ~= "string" then
    return
  end
  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  if dismissed then
    local alert = state.advisor_alerts[alert_id]
    if alert == nil or alert.force_id ~= player.force.name then
      return
    end
    ui_state.dismiss_alert(player_state, alert)
  elseif not ui_state.restore_alert(player_state, alert_id) then
    return
  end
  ui.refresh_alerts_hud(player, state, player_state)
  ui.render(player, state, player_state)
end

--- Batch dismiss of everything the player can currently see. Only this player's
--- dismissed_alerts change: the alerts themselves, quiet mode and muted rules
--- stay exactly as they were.
local function dismiss_all_alerts(player)
  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  local dismissed =
    ui_state.dismiss_all_alerts(state, player_state, player.force.name)
  if dismissed == 0 then
    return
  end

  ui.hide_toast(player, state)
  ui.refresh_alerts_hud(player, state, player_state)
  ui.render(player, state, player_state)
  player.print({ "factorio-ai-assistant.alerts-cleared", dismissed })
end

script.on_event(defines.events.on_gui_click, function(event)
  local element = event.element
  if not element.valid then
    return
  end

  local player = game.get_player(event.player_index)
  if not player then
    return
  end

  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  if element.name == ui.BUTTON_NAME then
    toggle_advisor(player)
    return
  end

  local tags = element.tags or {}
  local action = tags.action
  if action == "close" then
    close_advisor(player)
  elseif action == "resize" then
    ui.save_location(player, player_state)
    ui_state.cycle_size(player_state)
    ui.render(player, state, player_state)
  elseif action == "toggle-mini" then
    ui.save_location(player, player_state)
    -- Switching layouts rebuilds the input, so carry the draft across.
    ui.save_draft(player, player_state)
    ui_state.toggle_mini(player_state)
    ui.render(player, state, player_state)
    ui.focus_chat_input(player)
  elseif action == "tab" then
    ui.save_draft(player, player_state)
    if ui_state.set_tab(player_state, tags.tab) then
      ui.render(player, state, player_state)
      if tags.tab == "chat" then
        ui.focus_chat_input(player)
      end
    end
  elseif action == "open-alerts" then
    ui.hide_toast(player, state)
    ui_state.set_tab(player_state, "alerts")
    open_advisor(player)
  elseif action == "quick-question" then
    local question = quick_question(player, tags.question_key)
    if question ~= nil then
      send_chat_request(player, question)
    end
  elseif action == "send-chat" then
    send_chat_request(player, ui.read_chat_input(player))
  elseif action == "cancel-chat" then
    cancel_chat_request(player)
  elseif action == "clear-chat" then
    clear_chat_history(player)
  elseif action == "clear-highlights" then
    clear_highlights_for(player)
  elseif action == "dismiss-alert" then
    set_alert_dismissed(player, tags.alert_id, true)
  elseif action == "restore-alert" then
    set_alert_dismissed(player, tags.alert_id, false)
  elseif action == "clear-alerts" then
    dismiss_all_alerts(player)
  elseif action == "mute-rule" then
    set_rule_muted(player, tags.rule_id, true)
  elseif action == "unmute-rule" then
    set_rule_muted(player, tags.rule_id, false)
  elseif action == "reconnect" then
    send_hello()
    ui.render(player, state, player_state)
  end
end)

script.on_event(defines.events.on_gui_confirmed, function(event)
  local element = event.element
  if element == nil or not element.valid then
    return
  end
  local player = game.get_player(event.player_index)
  if player == nil then
    return
  end
  if element.name == ui.CHAT_INPUT_NAME then
    send_chat_request(player, element.text)
  end
end)

script.on_event(defines.events.on_gui_location_changed, function(event)
  local element = event.element
  if element == nil
    or not element.valid
    or element.name ~= ui.PANEL_NAME
  then
    return
  end
  local player = game.get_player(event.player_index)
  if player ~= nil then
    local state = get_state()
    ui.save_location(
      player,
      ui_state.ensure_player(state, event.player_index)
    )
  end
end)

script.on_event(defines.events.on_gui_closed, function(event)
  if event.element ~= nil
    and event.element.valid
    and event.element.name == ui.PANEL_NAME
  then
    local player = game.get_player(event.player_index)
    if player ~= nil then
      close_advisor(player)
    end
  end
end)

script.on_event("factorio-ai-assistant-clear-highlights", function(event)
  local player = game.get_player(event.player_index)
  if player ~= nil then
    clear_highlights_for(player)
  end
end)

script.on_event("factorio-ai-assistant-toggle-input", function(event)
  local player = game.get_player(event.player_index)
  if player ~= nil then
    toggle_advisor(player)
  end
end)

local function handle_selected_area(event)
  if event.item ~= "factorio-ai-assistant-inspector" then
    return
  end

  local player = game.get_player(event.player_index)
  if player == nil then
    return
  end

  local state = get_state()
  local player_state = ui_state.ensure_player(state, player.index)
  local area = {
    x1 = event.area.left_top.x,
    y1 = event.area.left_top.y,
    x2 = event.area.right_bottom.x,
    y2 = event.area.right_bottom.y,
  }

  local sent = send_area_snapshot(player, area, event.entities or {})
  ui_state.set_selection(
    player_state,
    sent and {
      count = #(event.entities or {}),
      tick = event.tick,
    } or nil
  )
  if not sent then
    ui_state.append_system(player_state, "chat-offline", game.tick)
  end

  ui_state.set_tab(player_state, "chat")
  -- Opening through open_advisor keeps the single open path that the auto-pause
  -- claim depends on.
  open_advisor(player)
end

script.on_event(defines.events.on_player_selected_area, handle_selected_area)
script.on_event(defines.events.on_player_alt_selected_area, handle_selected_area)

for index, tab in ipairs({ "chat", "alerts", "status" }) do
  local tab_name = tab
  script.on_event("factorio-ai-assistant-tab-" .. index, function(event)
    local player = game.get_player(event.player_index)
    if player ~= nil then
      local state = get_state()
      local player_state =
        ui_state.ensure_player(state, event.player_index)
      -- Asking for a specific tab means the player wants the tabbed panel;
      -- mini has no tabs to show.
      ui.save_draft(player, player_state)
      if ui_state.is_mini(player_state) then
        ui_state.toggle_mini(player_state)
      end
      ui_state.set_tab(player_state, tab_name)
      open_advisor(player)
      if tab_name == "chat" then
        ui.focus_chat_input(player)
      end
    end
  end)
end

local function copy_table(value)
  if type(value) ~= "table" then
    return value
  end
  local result = {}
  for key, child in pairs(value) do
    result[copy_table(key)] = copy_table(child)
  end
  return result
end

local function mock_alert(player, rule_id, severity, evidence, recommendation, age)
  return {
    id = rule_id .. ":" .. player.force.name,
    rule_id = rule_id,
    force_id = player.force.name,
    severity = severity,
    evidence = evidence,
    recommendation = recommendation,
    first_seen = math.max(0, game.tick - age),
    last_seen = game.tick,
  }
end

local function mock_alert_set(player, mode)
  local alerts = {}
  if mode == "none" then
    return alerts
  end
  local power = mock_alert(
    player,
    "power-low",
    "warning",
    "电力满足率为 78%（发电 62 MW，用电 80 MW）。",
    "增加发电或燃料，并检查过载电网。",
    3600
  )
  alerts[power.id] = power
  if mode == "one" then
    return alerts
  end
  local material = mock_alert(
    player,
    "material-deficit",
    "critical",
    "铁板 10 分钟消费 2400/min，生产 900/min。",
    "扩建铁矿冶炼或减少下游消耗。",
    7200
  )
  alerts[material.id] = material
  local research = mock_alert(
    player,
    "research-idle",
    "info",
    "当前没有进行中的研究，已空闲 12 分钟。",
    "在科技树中选择下一个研究目标。",
    1800
  )
  alerts[research.id] = research
  return alerts
end

local function reopen_mock_alerts(player, state)
  local reopened = {}
  for alert_id, alert in pairs(state.advisor_alerts) do
    if alert.force_id == player.force.name then
      state.advisor_alerts[alert_id] = nil
      ui_state.forget_alert(state, alert_id)
      local copy = copy_table(alert)
      copy.first_seen = game.tick
      copy.last_seen = game.tick
      reopened[alert_id] = copy
    end
  end
  if next(reopened) == nil then
    reopened = mock_alert_set(player, "one")
    for alert_id in pairs(reopened) do
      ui_state.forget_alert(state, alert_id)
    end
  end
  for alert_id, alert in pairs(reopened) do
    state.advisor_alerts[alert_id] = alert
  end
end

local function close_mock_alerts(player, state)
  for alert_id, alert in pairs(state.advisor_alerts) do
    if alert.force_id == player.force.name then
      state.advisor_alerts[alert_id] = nil
      ui_state.forget_alert(state, alert_id)
    end
  end
end

local function apply_ui_mock(player, mode)
  local state = get_state()
  if mode == "clear" then
    local backup = state.ui_mock_backup
    if backup ~= nil then
      state.connected = backup.connected
      state.last_response_tick = backup.last_response_tick
      state.last_sync_tick = backup.last_sync_tick
      state.companion_version = backup.companion_version
      state.assistant_status = backup.assistant_status
      state.protocol_mismatch = backup.protocol_mismatch
      state.component_version_mismatch =
        backup.component_version_mismatch
      state.static_revision = backup.static_revision
      state.advisor_alerts = backup.advisor_alerts
      state.ui_mock_backup = nil
    end
    -- Dropping the player state would also drop the auto-pause claim, so close
    -- the panel through the shared path first.
    close_advisor(player)
    local player_state = ui_state.reset_player(state, player.index)
    ui.refresh_alerts_hud(player, state, player_state)
    open_advisor(player)
    send_hello()
    return
  end

  if mode == "chat-append"
    or mode == "chat-cleared"
    or mode == "alert-close"
    or mode == "alert-reopen"
  then
    local player_state = ui_state.ensure_player(state, player.index)
    if mode == "chat-append" then
      ui_state.append_mock_message(
        player_state,
        "assistant",
        "新增回答 #"
          .. tostring(#player_state.chat_history + 1)
          .. "：电力满足率回升到 96%，可以继续扩建。",
        game.tick
      )
    elseif mode == "chat-cleared" then
      ui_state.clear_chat(player_state)
    elseif mode == "alert-close" then
      close_mock_alerts(player, state)
    else
      reopen_mock_alerts(player, state)
    end
    ui.refresh_alerts_hud(player, state, player_state)
    open_advisor(player)
    return
  end

  if state.ui_mock_backup == nil then
    state.ui_mock_backup = {
      connected = state.connected,
      last_response_tick = state.last_response_tick,
      last_sync_tick = state.last_sync_tick,
      companion_version = state.companion_version,
      assistant_status = copy_table(state.assistant_status),
      protocol_mismatch = state.protocol_mismatch,
      component_version_mismatch =
        copy_table(state.component_version_mismatch),
      static_revision = state.static_revision,
      advisor_alerts = copy_table(state.advisor_alerts),
    }
  end

  close_advisor(player)
  local player_state = ui_state.reset_player(state, player.index)
  state.companion_version = "mock-0.2.0"
  state.static_revision = 7
  state.last_response_tick = game.tick - 120
  state.last_sync_tick = game.tick - 300
  state.assistant_status = {
    mode = "local",
    provider = "local",
    reason = "mock",
    privacy = "local-only",
  }
  state.protocol_mismatch = nil
  state.component_version_mismatch = nil
  state.advisor_alerts = {}

  if mode == "offline" then
    state.connected = false
    state.assistant_status = nil
  elseif mode == "incompatible" then
    state.connected = false
    state.assistant_status = nil
    state.protocol_mismatch = PROTOCOL_VERSION + 1
  elseif mode == "loading" then
    state.connected = true
    ui_state.append_mock_message(
      player_state,
      "user",
      "当前最大的生产瓶颈是什么？",
      game.tick
    )
    player_state.chat_pending = {
      message_id = "mock-loading",
      sent_tick = game.tick,
    }
  elseif mode == "timeout" then
    state.connected = true
    ui_state.append_system(player_state, "chat-timeout", game.tick)
  elseif mode == "chat-long" then
    state.connected = true
    for index = 1, 8 do
      ui_state.append_mock_message(
        player_state,
        "user",
        "第 " .. index .. " 个问题：这条产线的瓶颈在哪里？",
        game.tick - (9 - index) * 120
      )
      ui_state.append_mock_message(
        player_state,
        "assistant",
        "第 "
          .. index
          .. " 条回答：瓶颈在铜板供应，当前 "
          .. (index * 30)
          .. "/min，需要 "
          .. (index * 45)
          .. "/min。假设：无插件。",
        game.tick - (9 - index) * 120 + 60
      )
    end
  elseif mode == "alerts-none"
    or mode == "alerts-one"
    or mode == "alerts-many"
  then
    state.connected = true
    state.advisor_alerts =
      mock_alert_set(player, string.sub(mode, 8))
    ui_state.set_tab(player_state, "alerts")
  elseif mode == "ready" then
    state.connected = true
    ui_state.append_mock_message(
      player_state,
      "user",
      "每分钟 45 蓝瓶需要多少机器？",
      game.tick - 180
    )
    ui_state.append_mock_message(
      player_state,
      "assistant",
      "[计算结果]\n"
        .. "[C1] 化学科技包 45/min：组装机 3 精确 7.2 台，向上取整 8 台。\n"
        .. "[推断]\n机器数量直接采用确定性计算结果，不由模型估算。\n"
        .. "[假设]\n无插件，机器数向上取整。",
      game.tick - 120
    )
    state.advisor_alerts = mock_alert_set(player, "one")
  else
    player.print({ "factorio-ai-assistant.mock-invalid-mode" })
    return
  end

  ui.refresh_alerts_hud(player, state, player_state)
  open_advisor(player)
end

commands.add_command(
  "factorio-ai-assistant-mock",
  { "factorio-ai-assistant.mock-command-help" },
  function(command)
    local player = command.player_index
      and game.get_player(command.player_index)
    if player == nil then
      log("[factorio-ai-assistant] UI mock command requires a player")
      return
    end
    apply_ui_mock(player, trim(command.parameter or "ready"))
  end
)

commands.add_command(
  "ai",
  { "factorio-ai-assistant.ai-command-help" },
  function(command)
    local player = command.player_index
      and game.get_player(command.player_index)
    if player == nil then
      return
    end

    local question = trim(command.parameter or "")
    if question == "" then
      player.print({ "factorio-ai-assistant.ai-command-usage" })
      return
    end

    local state = get_state()
    local player_state = ui_state.ensure_player(state, player.index)
    send_chat_request(player, question)

    local pending = player_state.chat_pending
    if pending == nil then
      -- send_chat_request already appended a system entry explaining why.
      return
    end
    state.chat_command_requests = state.chat_command_requests or {}
    state.chat_command_requests[pending.message_id] = true
    player.print({ "factorio-ai-assistant.ai-command-sent" })
  end
)

local function send_localization_updates()
  if not UDP_AVAILABLE then
    return
  end

  local state = get_state()
  if not state.connected then
    return
  end

  localization.refresh(state)

  local packets = localization.build_packets(state, function()
    return next_message_id(state, "locale")
  end)

  for _, packet in ipairs(packets) do
    send_udp_payload(packet.encoded, "localization send")
  end
end

local function run_periodic_network_tasks()
  send_hello()
  retry_static_packets()
  send_localization_updates()
end

local function run_every_second_tasks()
  maybe_send_dynamic_snapshot()
  maybe_send_resource_snapshot()
  update_connection_status()
  -- Reaching this handler means ticks are running again, so a pause the Mod
  -- still claims to own was lifted by the player.
  pause.reconcile(get_state())
end

if UDP_AVAILABLE then
  script.on_event(UDP_EVENT, handle_udp_packet)
  script.on_nth_tick(POLL_INTERVAL_TICKS, poll_udp)
  script.on_nth_tick(HELLO_INTERVAL_TICKS, run_periodic_network_tasks)
end

script.on_nth_tick(UI_REFRESH_INTERVAL_TICKS, run_every_second_tasks)
