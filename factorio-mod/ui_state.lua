local ui_state = {}

local MAX_CHAT_HISTORY = 30
local VALID_TABS = {
  chat = true,
  alerts = true,
  status = true,
}
local SIZES = { "compact", "normal", "large" }
--- Mini is a separate mode rather than a step in the resize cycle: it changes
--- what is shown, not just how large it is, and has its own toggle.
local MINI_SIZE = "mini"
--- Matches the Companion's question limit, so a draft cannot grow past what
--- could ever be sent.
local MAX_DRAFT_LENGTH = 2000
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
  -- Saves written by v0.1.0-rc.4 still carry the withdrawn todo list and the
  -- structured suggestions it was adopted from. The feature is gone, so the
  -- dead data is dropped here instead of being kept alive in every later save.
  player_state.todos = nil
  player_state.todo_sequence = nil
  for _, entry in ipairs(player_state.chat_history) do
    entry.suggested_actions = nil
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

--- Remembers what the player last selected with the inspector, so the panel can
--- show it and the Companion answer can be read in that context.
function ui_state.set_selection(player_state, selection)
  player_state.selection = selection
  touch_chat(player_state)
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

--- The most recent assistant answer, which is all mini mode shows.
function ui_state.last_answer(player_state)
  local history = player_state.chat_history or {}
  for index = #history, 1, -1 do
    local entry = history[index]
    if entry.role == "assistant" then
      return entry
    end
  end
  return nil
end

function ui_state.is_mini(player_state)
  return player_state.size == MINI_SIZE
end

--- Switches between mini and the size the player was using before, so leaving
--- mini restores their layout rather than resetting it.
function ui_state.toggle_mini(player_state)
  if player_state.size == MINI_SIZE then
    player_state.size = valid_size(player_state.size_before_mini)
    player_state.size_before_mini = nil
  else
    player_state.size_before_mini = player_state.size
    player_state.size = MINI_SIZE
  end
  return player_state.size
end

--- Remembers what the player had typed but not sent. The panel's input is a
-- GUI element, so closing the window destroys it along with the draft; a
-- half-written question is worth keeping across an accidental Esc.
function ui_state.set_draft(player_state, text)
  if type(text) ~= "string" or text == "" then
    player_state.draft = nil
    return
  end
  player_state.draft = string.sub(text, 1, MAX_DRAFT_LENGTH)
end

function ui_state.draft(player_state)
  local draft = player_state.draft
  return type(draft) == "string" and draft or ""
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
  -- The question is on its way, so the draft it came from is spent. The flag
  -- tells the renderer to blank the input, which still holds the sent text.
  player_state.draft = nil
  player_state.draft_sent = true
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

--- Alerts of one force that this player has not dismissed in their current
--- lifecycle. Muted rules stay in the list: muting silences a whole rule type
--- and remains a separate switch from dismissing what is open right now.
function ui_state.pending_alerts(state, player_state, force_id)
  local pending = {}
  for _, alert in pairs(state.advisor_alerts or {}) do
    if alert.force_id == force_id
      and not ui_state.is_alert_dismissed(player_state, alert)
    then
      table.insert(pending, alert)
    end
  end
  return pending
end

--- Batch dismiss: writes only this player's dismissed_alerts and never touches
--- state.advisor_alerts, quiet mode or muted rules, so a dismissed alert comes
--- back once it closes and triggers again.
function ui_state.dismiss_all_alerts(state, player_state, force_id)
  local dismissed = 0
  for _, alert in ipairs(ui_state.pending_alerts(state, player_state, force_id)) do
    if ui_state.dismiss_alert(player_state, alert) then
      dismissed = dismissed + 1
    end
  end
  return dismissed
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
  if size == MINI_SIZE then
    return size
  end
  for _, candidate in ipairs(SIZES) do
    if candidate == size then
      return size
    end
  end
  return "compact"
end

return ui_state
