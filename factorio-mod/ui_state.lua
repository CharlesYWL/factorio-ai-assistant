local ui_state = {}

local MAX_CHAT_HISTORY = 30
local VALID_TABS = {
  chat = true,
  alerts = true,
  status = true,
}
local SIZES = { "compact", "normal", "large" }
local valid_size
local append_chat
local touch_chat

function ui_state.ensure_player(state, player_index)
  state.ui_players = state.ui_players or {}
  local player_state = state.ui_players[player_index]
  if player_state == nil then
    player_state = {
      active_tab = "chat",
      size = "compact",
      location = nil,
      chat_history = {},
      chat_pending = nil,
      chat_sequence = 0,
      chat_revision = 0,
      dismissed_alerts = {},
      -- Protocol-compatibility holder only: the calculator form was removed and
      -- chat drives calculations, but a legacy in-flight request must still be
      -- able to resolve without crashing a mixed Mod/Companion install.
      calculator = {
        pending = nil,
        result = nil,
        error_code = nil,
        error_message = nil,
      },
    }
    state.ui_players[player_index] = player_state
  end

  player_state.active_tab =
    VALID_TABS[player_state.active_tab] and player_state.active_tab or "chat"
  player_state.size = valid_size(player_state.size)
  player_state.chat_history = player_state.chat_history or {}
  player_state.chat_sequence = player_state.chat_sequence or 0
  player_state.chat_revision = player_state.chat_revision or 0
  player_state.dismissed_alerts = player_state.dismissed_alerts or {}
  for _, entry in ipairs(player_state.chat_history) do
    if entry.seq == nil then
      player_state.chat_sequence = player_state.chat_sequence + 1
      entry.seq = player_state.chat_sequence
    end
  end
  player_state.calculator = player_state.calculator or {}

  return player_state
end

function ui_state.set_tab(player_state, tab)
  if VALID_TABS[tab] then
    player_state.active_tab = tab
    return true
  end
  return false
end

function ui_state.cycle_size(player_state)
  local index = 1
  for candidate_index, size in ipairs(SIZES) do
    if size == player_state.size then
      index = candidate_index
      break
    end
  end
  player_state.size = SIZES[index % #SIZES + 1]
  return player_state.size
end

function ui_state.set_location(player_state, location)
  if type(location) ~= "table"
    or type(location.x) ~= "number"
    or type(location.y) ~= "number"
  then
    return false
  end
  player_state.location = {
    x = math.max(0, math.floor(location.x)),
    y = math.max(0, math.floor(location.y)),
  }
  return true
end

function ui_state.queue_chat(player_state, message_id, question, tick)
  if player_state.chat_pending ~= nil then
    return false
  end
  append_chat(player_state, {
    role = "user",
    text = question,
    tick = tick,
  })
  player_state.chat_pending = {
    message_id = message_id,
    sent_tick = tick,
  }
  touch_chat(player_state)
  return true
end

function ui_state.clear_chat(player_state)
  local pending = player_state.chat_pending
  player_state.chat_pending = nil
  player_state.chat_history = {}
  touch_chat(player_state)
  return pending ~= nil and pending.message_id or nil
end

function ui_state.cancel_chat(player_state, tick)
  local pending = player_state.chat_pending
  if pending == nil then
    return nil
  end
  player_state.chat_pending = nil
  append_chat(player_state, {
    role = "system",
    locale = "chat-cancelled",
    tick = tick,
  })
  return pending.message_id
end

function ui_state.complete_chat(state, reply_to, payload, tick)
  for player_index, player_state in pairs(state.ui_players or {}) do
    local pending = player_state.chat_pending
    if pending ~= nil and pending.message_id == reply_to then
      player_state.chat_pending = nil
      if payload.status == "ok" then
        append_chat(player_state, {
          role = "assistant",
          text = payload.text,
          mode = payload.mode,
          provider = payload.provider,
          model = payload.model,
          fallback_reason = payload.fallback_reason,
          tick = tick,
        })
      elseif payload.status == "cancelled" then
        append_chat(player_state, {
          role = "system",
          locale = "chat-cancelled",
          tick = tick,
        })
      else
        append_chat(player_state, {
          role = "system",
          locale = "chat-error",
          error_code = payload.error_code,
          tick = tick,
        })
      end
      return player_index
    end
  end
  return nil
end

--- Retained with complete_calculation for protocol compatibility only: chat now
--- drives every calculation, but a legacy in-flight request must still resolve.
function ui_state.queue_calculation(player_state, message_id, tick)
  local calculator = player_state.calculator
  if calculator.pending ~= nil then
    return false
  end
  calculator.pending = {
    message_id = message_id,
    sent_tick = tick,
  }
  calculator.result = nil
  calculator.error_code = nil
  calculator.error_message = nil
  return true
end

function ui_state.complete_calculation(state, reply_to, payload)
  for player_index, player_state in pairs(state.ui_players or {}) do
    local calculator = player_state.calculator
    local pending = calculator.pending
    if pending ~= nil and pending.message_id == reply_to then
      calculator.pending = nil
      if payload.status == "ok" then
        calculator.result = payload.result
        calculator.error_code = nil
        calculator.error_message = nil
      else
        calculator.result = nil
        calculator.error_code = payload.error_code or "UNKNOWN"
        calculator.error_message = payload.error_message
      end
      return player_index
    end
  end
  return nil
end

function ui_state.expire_requests(state, tick, timeout_ticks)
  local changed = {}
  for player_index, player_state in pairs(state.ui_players or {}) do
    local did_change = false
    local chat_pending = player_state.chat_pending
    if chat_pending ~= nil
      and tick - chat_pending.sent_tick >= timeout_ticks
    then
      player_state.chat_pending = nil
      append_chat(player_state, {
        role = "system",
        locale = "chat-timeout",
        tick = tick,
      })
      did_change = true
    end

    local calculator = player_state.calculator
    local calculation_pending = calculator.pending
    if calculation_pending ~= nil
      and tick - calculation_pending.sent_tick >= timeout_ticks
    then
      calculator.pending = nil
      calculator.result = nil
      calculator.error_code = "TIMEOUT"
      calculator.error_message = nil
      did_change = true
    end

    if did_change then
      table.insert(changed, player_index)
    end
  end
  return changed
end

function ui_state.reset_player(state, player_index)
  if state.ui_players ~= nil then
    state.ui_players[player_index] = nil
  end
  return ui_state.ensure_player(state, player_index)
end

function ui_state.dismiss_alert(player_state, alert)
  if type(alert) ~= "table" or type(alert.id) ~= "string" then
    return false
  end
  player_state.dismissed_alerts = player_state.dismissed_alerts or {}
  player_state.dismissed_alerts[alert.id] = alert.first_seen or 0
  return true
end

function ui_state.restore_alert(player_state, alert_id)
  if type(alert_id) ~= "string" or player_state.dismissed_alerts == nil then
    return false
  end
  if player_state.dismissed_alerts[alert_id] == nil then
    return false
  end
  player_state.dismissed_alerts[alert_id] = nil
  return true
end

function ui_state.is_alert_dismissed(player_state, alert)
  if type(alert) ~= "table" or player_state.dismissed_alerts == nil then
    return false
  end
  local dismissed_at = player_state.dismissed_alerts[alert.id]
  return dismissed_at ~= nil and dismissed_at == (alert.first_seen or 0)
end

function ui_state.forget_alert(state, alert_id)
  if type(alert_id) ~= "string" then
    return
  end
  for _, player_state in pairs(state.ui_players or {}) do
    if player_state.dismissed_alerts ~= nil then
      player_state.dismissed_alerts[alert_id] = nil
    end
  end
end

function ui_state.append_mock_message(player_state, role, text, tick)
  append_chat(player_state, {
    role = role,
    text = text,
    tick = tick,
  })
end

function ui_state.append_system(player_state, locale, tick, error_code)
  append_chat(player_state, {
    role = "system",
    locale = locale,
    error_code = error_code,
    tick = tick,
  })
end

append_chat = function(player_state, entry)
  player_state.chat_sequence = (player_state.chat_sequence or 0) + 1
  entry.seq = player_state.chat_sequence
  table.insert(player_state.chat_history, entry)
  while #player_state.chat_history > MAX_CHAT_HISTORY do
    table.remove(player_state.chat_history, 1)
  end
  touch_chat(player_state)
end

touch_chat = function(player_state)
  player_state.chat_revision = (player_state.chat_revision or 0) + 1
end

valid_size = function(size)
  for _, candidate in ipairs(SIZES) do
    if candidate == size then
      return size
    end
  end
  return "compact"
end

return ui_state
