local ui_state = {}

local MAX_CHAT_HISTORY = 30
--- Todos are a short, player-curated list, not a log: a hard cap keeps the save
--- small and the Alerts tab readable, and a full list rejects new adds instead
--- of silently evicting something the player chose to keep.
local MAX_TODOS = 25
--- Character limit, matched to the protocol's `MAX_SUGGESTED_ACTION_TEXT_CHARACTERS`.
--- Counting bytes here would silently drop suggestions in Chinese, where the
--- shipped guide objectives are well past 240 UTF-8 bytes. The byte guard is a
--- separate, deliberately loose safety net for a hostile sender.
local MAX_TODO_TEXT = 320
local MAX_TODO_TEXT_BYTES = MAX_TODO_TEXT * 4
local MAX_TODO_ID = 64
local MAX_SUGGESTED_ACTIONS = 3
local TODO_SOURCES = {
  guide = true,
  alert = true,
  calculation = true,
  model = true,
}
local VALID_TABS = {
  chat = true,
  alerts = true,
  status = true,
}
local SIZES = { "compact", "normal", "large" }
local valid_size
local append_chat
local touch_chat
local find_todo
local utf8_length

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
      todos = {},
      todo_sequence = 0,
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
  -- Saves written before the todo feature existed simply have no list yet.
  player_state.todos = player_state.todos or {}
  player_state.todo_sequence = player_state.todo_sequence or 0
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
          suggested_actions =
            ui_state.sanitize_suggested_actions(payload.suggested_actions),
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

function ui_state.append_mock_message(player_state, role, text, tick, actions)
  append_chat(player_state, {
    role = role,
    text = text,
    tick = tick,
    suggested_actions = ui_state.sanitize_suggested_actions(actions),
  })
end

--- Narrow validation of the optional `suggested_actions` field. A malformed or
--- oversized list is dropped instead of rejecting the whole answer, so a mixed
--- Mod/Companion install still shows the text. Returns nil when nothing usable
--- survives, so callers can treat "no structured actions" as one case.
function ui_state.sanitize_suggested_actions(value)
  if type(value) ~= "table" then
    return nil
  end

  local actions = {}
  local seen = {}
  for _, entry in ipairs(value) do
    if #actions >= MAX_SUGGESTED_ACTIONS then
      break
    end
    if type(entry) == "table"
      and type(entry.action_id) == "string"
      and #entry.action_id > 0
      and #entry.action_id <= MAX_TODO_ID
      and string.match(entry.action_id, "^[%w_%-]+$") ~= nil
      and type(entry.text) == "string"
      and #entry.text > 0
      and #entry.text <= MAX_TODO_TEXT_BYTES
      and utf8_length(entry.text) <= MAX_TODO_TEXT
      and string.find(entry.text, "[%c]") == nil
      and TODO_SOURCES[entry.source]
      and not seen[entry.action_id]
    then
      seen[entry.action_id] = true
      table.insert(actions, {
        action_id = entry.action_id,
        text = entry.text,
        source = entry.source,
      })
    end
  end

  if #actions == 0 then
    return nil
  end
  return actions
end

--- Adopts one suggestion as a todo. Only ever called from a GUI click handler:
--- neither the Companion nor a model may create, complete or delete a todo.
--- Returns "added", "duplicate", "limit" or "invalid".
function ui_state.add_todo(player_state, action, tick)
  local sanitized = ui_state.sanitize_suggested_actions({ action })
  if sanitized == nil then
    return "invalid"
  end
  local entry = sanitized[1]

  player_state.todos = player_state.todos or {}
  if find_todo(player_state, entry.action_id) ~= nil then
    return "duplicate"
  end
  if #player_state.todos >= MAX_TODOS then
    return "limit"
  end

  player_state.todo_sequence = (player_state.todo_sequence or 0) + 1
  table.insert(player_state.todos, {
    id = entry.action_id,
    text = entry.text,
    source = entry.source,
    created_tick = tick or 0,
    order = player_state.todo_sequence,
    completed = false,
  })
  return "added"
end

function ui_state.has_todo(player_state, todo_id)
  return find_todo(player_state, todo_id) ~= nil
end

function ui_state.set_todo_completed(player_state, todo_id, completed, tick)
  local todo = find_todo(player_state, todo_id)
  if todo == nil or todo.completed == (completed and true or false) then
    return false
  end
  todo.completed = completed and true or false
  todo.completed_tick = todo.completed and (tick or 0) or nil
  return true
end

function ui_state.delete_todo(player_state, todo_id)
  if type(todo_id) ~= "string" or player_state.todos == nil then
    return false
  end
  for index, todo in ipairs(player_state.todos) do
    if todo.id == todo_id then
      table.remove(player_state.todos, index)
      return true
    end
  end
  return false
end

function ui_state.clear_completed_todos(player_state)
  local removed = 0
  local kept = {}
  for _, todo in ipairs(player_state.todos or {}) do
    if todo.completed then
      removed = removed + 1
    else
      table.insert(kept, todo)
    end
  end
  player_state.todos = kept
  return removed
end

function ui_state.clear_todos(player_state)
  local removed = #(player_state.todos or {})
  player_state.todos = {}
  return removed
end

function ui_state.open_todo_count(player_state)
  local open = 0
  for _, todo in ipairs(player_state.todos or {}) do
    if not todo.completed then
      open = open + 1
    end
  end
  return open
end

--- Display order: open todos first, oldest first inside each group. `order` is
--- a per-player counter rather than the tick, so two todos adopted on the same
--- tick still sort deterministically.
function ui_state.sorted_todos(player_state)
  local todos = {}
  for _, todo in ipairs(player_state.todos or {}) do
    table.insert(todos, todo)
  end
  table.sort(todos, function(left, right)
    if left.completed ~= right.completed then
      return not left.completed
    end
    if (left.order or 0) ~= (right.order or 0) then
      return (left.order or 0) < (right.order or 0)
    end
    return left.id < right.id
  end)
  return todos
end

find_todo = function(player_state, todo_id)
  if type(todo_id) ~= "string" then
    return nil
  end
  for _, todo in ipairs(player_state.todos or {}) do
    if todo.id == todo_id then
      return todo
    end
  end
  return nil
end

--- Counts UTF-8 code points, not bytes: continuation bytes are 0x80..0xBF.
utf8_length = function(value)
  local _, count = string.gsub(value, "[^\128-\191]", "")
  return count
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
