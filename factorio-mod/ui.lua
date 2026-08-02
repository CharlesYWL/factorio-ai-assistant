local mod_gui = require("__core__.lualib.mod-gui")
local pause = require("pause")
local ui_state = require("ui_state")

local ui = {}

ui.BUTTON_NAME = "factorio-ai-assistant-toggle"
ui.PANEL_NAME = "factorio-ai-assistant-panel"
ui.CHAT_INPUT_NAME = "factorio-ai-assistant-chat-input"
ui.CHAT_SEND_NAME = "factorio-ai-assistant-chat-send"
ui.CHAT_CANCEL_NAME = "factorio-ai-assistant-chat-cancel"
ui.CHAT_CLEAR_NAME = "factorio-ai-assistant-chat-clear"
ui.HIGHLIGHT_CLEAR_NAME = "factorio-ai-assistant-highlight-clear"
ui.CLEAR_ALERTS_NAME = "factorio-ai-assistant-clear-alerts"
ui.HUD_CLEAR_ALERTS_NAME = "factorio-ai-assistant-hud-clear-alerts"

local TITLEBAR_NAME = "factorio-ai-assistant-titlebar"
local HEADER_STATUS_NAME = "factorio-ai-assistant-header-status"
local CONTENT_NAME = "factorio-ai-assistant-content"
local NOTICE_NAME = "factorio-ai-assistant-notice"
local TABS_NAME = "factorio-ai-assistant-tabs"
local BODY_NAME = "factorio-ai-assistant-body"
local CHAT_HISTORY_NAME = "factorio-ai-assistant-chat-history"
local CHAT_ENTRY_PREFIX = "factorio-ai-assistant-chat-entry-"
local CHAT_EMPTY_NAME = "factorio-ai-assistant-chat-empty"
local CHAT_LOADING_NAME = "factorio-ai-assistant-chat-loading"
local TOAST_NAME = "factorio-ai-assistant-toast"
local ALERT_HUD_NAME = "factorio-ai-assistant-alert-hud"
local ALERT_SETTING_NAME = "factorio-ai-assistant-advisor-muted-rules"
local HUD_MAX_ALERTS = 4
local HUD_TEXT_WIDTH = 250
local QUICK_PROMPT_COUNT = 4
local QUICK_PROMPT_COLUMNS = 2

local SIZE_DIMENSIONS = {
  mini = { width = 460, height = 260 },
  compact = { width = 540, height = 620 },
  normal = { width = 700, height = 720 },
  large = { width = 860, height = 820 },
}
local TAB_ORDER = { "chat", "alerts", "status" }
local SEVERITY_RANK = {
  critical = 1,
  warning = 2,
  info = 3,
}
local SEVERITY_COLORS = {
  critical = { r = 1, g = 0.3, b = 0.25 },
  warning = { r = 1, g = 0.72, b = 0.2 },
  info = { r = 0.35, g = 0.72, b = 1 },
}
local apply_frame_size
local ensure_shell
local render_mini
local add_notice
local add_tabs
local update_tabs
local render_chat
local build_chat
local chat_signature
local sync_chat_entries
local update_chat_controls
local render_chat_entry
local render_alerts
local collect_force_alerts
local compare_alerts
local hud_alerts
local hud_signature
local render_status
local refresh_header_status
local incompatibility_caption
local add_state_banner
local add_wrapped_label
local add_status_row
local add_status_value
local localized_rule
local localized_severity
local muted_rule_set
local auto_pause_caption
local format_last_response
local panel_text_width
local find_element
local localization_summary

function ui.ensure_button(player)
  local button_flow = mod_gui.get_button_flow(player)
  if button_flow[ui.BUTTON_NAME] == nil then
    button_flow.add({
      type = "button",
      name = ui.BUTTON_NAME,
      caption = { "factorio-ai-assistant.button-caption" },
      tooltip = { "factorio-ai-assistant.button-tooltip" },
    })
  end
end

function ui.is_open(player)
  return player.gui.screen[ui.PANEL_NAME] ~= nil
end

function ui.open(player, state, player_state)
  if ui.is_open(player) then
    ui.render(player, state, player_state)
    return
  end

  local frame = player.gui.screen.add({
    type = "frame",
    name = ui.PANEL_NAME,
    direction = "vertical",
  })
  local titlebar = frame.add({
    type = "flow",
    name = TITLEBAR_NAME,
    direction = "horizontal",
  })
  titlebar.drag_target = frame
  local title = titlebar.add({
    type = "label",
    caption = { "factorio-ai-assistant.panel-title" },
    style = "frame_title",
  })
  title.ignored_by_interaction = true
  local drag_space = titlebar.add({
    type = "empty-widget",
    style = "draggable_space_header",
  })
  drag_space.style.horizontally_stretchable = true
  drag_space.style.height = 24
  drag_space.drag_target = frame
  titlebar.add({
    type = "label",
    name = HEADER_STATUS_NAME,
  })
  titlebar.add({
    type = "sprite-button",
    sprite = "utility/search",
    style = "frame_action_button",
    tooltip = { "factorio-ai-assistant.mini-tooltip" },
    tags = { action = "toggle-mini" },
  })
  titlebar.add({
    type = "sprite-button",
    sprite = "utility/expand",
    style = "frame_action_button",
    tooltip = { "factorio-ai-assistant.resize-tooltip" },
    tags = { action = "resize" },
  })
  titlebar.add({
    type = "sprite-button",
    sprite = "utility/close",
    style = "frame_action_button",
    tooltip = { "factorio-ai-assistant.close" },
    tags = { action = "close" },
  })

  frame.add({
    type = "flow",
    name = CONTENT_NAME,
    direction = "vertical",
  })
  apply_frame_size(frame, player_state)
  if player_state.location ~= nil then
    frame.location = player_state.location
  else
    local dimensions = SIZE_DIMENSIONS[player_state.size]
      or SIZE_DIMENSIONS.compact
    frame.location = {
      x = math.max(0, player.display_resolution.width - dimensions.width - 24),
      y = 72,
    }
  end
  -- Registering the panel as the opened GUI is what makes ESC close it and
  -- raise on_gui_closed, which is the only close path the Mod cannot trigger
  -- itself.
  player.opened = frame
  ui.render(player, state, player_state)
end

function ui.close(player)
  local frame = player.gui.screen[ui.PANEL_NAME]
  if frame == nil then
    return
  end
  if player.opened == frame then
    -- Clearing `opened` raises on_gui_closed, which re-enters this function, so
    -- look the frame up again instead of destroying a stale handle.
    player.opened = nil
    frame = player.gui.screen[ui.PANEL_NAME]
  end
  if frame ~= nil then
    frame.destroy()
  end
end

function ui.render(player, state, player_state)
  local frame = player.gui.screen[ui.PANEL_NAME]
  if frame == nil then
    return
  end
  apply_frame_size(frame, player_state)
  refresh_header_status(frame, state)

  local content = frame[CONTENT_NAME]

  -- Mini mode and the tabbed panel build different children into the same
  -- container, so a switch either way has to clear it. Leaving that to each
  -- renderer let both layouts end up stacked in one window.
  local wantsMini = ui_state.is_mini(player_state)
  local tags = content.tags or {}
  local wasMini = tags.view == "mini"
  if wantsMini ~= wasMini then
    content.clear()
    content.tags = {}
  end

  if wantsMini then
    render_mini(content, state, player_state)
    return
  end

  ensure_shell(content, player_state)
  local body = content[BODY_NAME]

  if player_state.active_tab == "chat" then
    render_chat(body, state, player_state)
    return
  end

  body.clear()
  body.tags = { view = player_state.active_tab }
  if player_state.active_tab == "alerts" then
    render_alerts(body, state, player_state, player.force.name)
  else
    render_status(body, state, player)
  end
end

function ui.refresh_status(player, state)
  local frame = player.gui.screen[ui.PANEL_NAME]
  if frame == nil then
    return
  end
  refresh_header_status(frame, state)
  local player_state = state.ui_players and state.ui_players[player.index]
  if player_state ~= nil and player_state.active_tab == "status" then
    ui.render(player, state, player_state)
  end
end

function ui.read_chat_input(player)
  local element = find_element(player.gui.screen[ui.PANEL_NAME], ui.CHAT_INPUT_NAME)
  return element and element.text or ""
end

function ui.focus_chat_input(player)
  local element = find_element(player.gui.screen[ui.PANEL_NAME], ui.CHAT_INPUT_NAME)
  if element ~= nil then
    element.focus()
  end
end

function ui.show_toast(player, state, alert)
  local existing = player.gui.screen[TOAST_NAME]
  if existing ~= nil then
    existing.destroy()
  end

  local toast = player.gui.screen.add({
    type = "frame",
    name = TOAST_NAME,
    direction = "vertical",
    caption = { "factorio-ai-assistant.toast-title" },
  })
  toast.style.width = 420
  toast.location = {
    x = math.max(0, player.display_resolution.width - 444),
    y = 92,
  }
  local heading = toast.add({
    type = "label",
    caption = {
      "factorio-ai-assistant.alert-heading",
      localized_severity(alert.severity),
      localized_rule(alert.rule_id),
    },
  })
  heading.style.font_color = SEVERITY_COLORS[alert.severity]
  add_wrapped_label(
    toast,
    { "factorio-ai-assistant.evidence", alert.evidence },
    390
  )
  toast.add({
    type = "button",
    caption = { "factorio-ai-assistant.open-alerts" },
    tags = { action = "open-alerts" },
  })
  state.toast_expiry = state.toast_expiry or {}
  state.toast_expiry[player.index] = game.tick + 8 * 60
end

function ui.hide_toast(player, state)
  local toast = player.gui.screen[TOAST_NAME]
  if toast ~= nil then
    toast.destroy()
  end
  if state ~= nil and state.toast_expiry ~= nil then
    state.toast_expiry[player.index] = nil
  end
end

function ui.expire_toasts(state, tick)
  for player_index, expiry in pairs(state.toast_expiry or {}) do
    if tick >= expiry then
      local player = game.get_player(player_index)
      local toast = player and player.gui.screen[TOAST_NAME]
      if toast ~= nil then
        toast.destroy()
      end
      state.toast_expiry[player_index] = nil
    end
  end
end

function ui.refresh_alerts_hud(player, state, player_state)
  local frame_flow = mod_gui.get_frame_flow(player)
  local existing = frame_flow[ALERT_HUD_NAME]
  local alerts = hud_alerts(state, player_state, player.force.name)
  if #alerts == 0 then
    if existing ~= nil then
      existing.destroy()
    end
    return
  end

  local signature = hud_signature(alerts)
  if existing ~= nil then
    if (existing.tags or {}).signature == signature then
      return
    end
    existing.destroy()
  end

  local hud = frame_flow.add({
    type = "frame",
    name = ALERT_HUD_NAME,
    direction = "vertical",
    caption = { "factorio-ai-assistant.alert-hud-title", #alerts },
    tags = { signature = signature },
  })
  hud.style.maximal_width = 360
  hud.style.padding = 8
  hud.style.top_padding = 4

  local list = hud.add({ type = "flow", direction = "vertical" })
  list.style.horizontally_stretchable = true
  local shown = math.min(#alerts, HUD_MAX_ALERTS)
  for index = 1, shown do
    local alert = alerts[index]
    if index > 1 then
      list.add({ type = "line", direction = "horizontal" })
    end
    local row = list.add({ type = "flow", direction = "horizontal" })
    row.style.horizontally_stretchable = true
    row.style.vertical_align = "center"

    local text_flow = row.add({ type = "flow", direction = "vertical" })
    text_flow.style.horizontally_stretchable = true
    local heading = text_flow.add({
      type = "label",
      caption = {
        "factorio-ai-assistant.alert-heading",
        localized_severity(alert.severity),
        localized_rule(alert.rule_id),
      },
    })
    heading.style.font = "default-bold"
    heading.style.font_color = SEVERITY_COLORS[alert.severity]
    local evidence = add_wrapped_label(text_flow, alert.evidence, HUD_TEXT_WIDTH)
    evidence.style.font = "default-small"
    evidence.style.font_color = { r = 0.72, g = 0.75, b = 0.78 }

    local actions = row.add({ type = "flow", direction = "horizontal" })
    actions.style.vertical_align = "center"
    actions.add({
      type = "sprite-button",
      sprite = "utility/expand",
      style = "frame_action_button",
      tooltip = { "factorio-ai-assistant.open-alerts" },
      tags = { action = "open-alerts" },
    })
    actions.add({
      type = "sprite-button",
      sprite = "utility/close",
      style = "frame_action_button",
      tooltip = { "factorio-ai-assistant.dismiss-alert-tooltip" },
      tags = { action = "dismiss-alert", alert_id = alert.id },
    })
  end

  if #alerts > shown then
    hud.add({
      type = "button",
      caption = {
        "factorio-ai-assistant.alert-hud-more",
        #alerts - shown,
      },
      tags = { action = "open-alerts" },
    })
  end

  hud.add({
    type = "button",
    name = ui.HUD_CLEAR_ALERTS_NAME,
    caption = { "factorio-ai-assistant.clear-alerts" },
    tooltip = { "factorio-ai-assistant.clear-alerts-tooltip" },
    tags = { action = "clear-alerts" },
  })
end

function ui.clear_alerts_hud(player)
  local hud = mod_gui.get_frame_flow(player)[ALERT_HUD_NAME]
  if hud ~= nil then
    hud.destroy()
  end
end

function ui.save_location(player, player_state)
  local frame = player.gui.screen[ui.PANEL_NAME]
  if frame ~= nil then
    player_state.location = {
      x = math.max(0, math.floor(frame.location.x)),
      y = math.max(0, math.floor(frame.location.y)),
    }
  end
end

--- Keeps whatever is typed but unsent, so closing the panel does not discard it.
function ui.save_draft(player, player_state)
  local element = find_element(player.gui.screen[ui.PANEL_NAME], ui.CHAT_INPUT_NAME)
  if element ~= nil then
    ui_state.set_draft(player_state, element.text)
  end
end

local MINI_BODY_NAME = "factorio-ai-assistant-mini-body"
local MINI_ANSWER_NAME = "factorio-ai-assistant-mini-answer"

--- Mini mode: the last answer in a scrollable box plus an input row. Answers
--- are often long, so the box scrolls rather than clipping the text.
render_mini = function(content, state, player_state)
  local signature = tostring(player_state.chat_revision)
    .. ":"
    .. tostring(state.connected)
  local tags = content.tags or {}

  if tags.view ~= "mini" then
    content.clear()
    local scroll = content.add({
      type = "scroll-pane",
      name = MINI_BODY_NAME,
      direction = "vertical",
      vertical_scroll_policy = "auto",
    })
    scroll.style.horizontally_stretchable = true
    scroll.style.vertically_stretchable = true

    local row = content.add({
      type = "flow",
      direction = "horizontal",
    })
    local input = row.add({
      type = "textfield",
      name = ui.CHAT_INPUT_NAME,
      text = ui_state.draft(player_state),
    })
    input.style.horizontally_stretchable = true
    row.add({
      type = "button",
      caption = { "factorio-ai-assistant.send" },
      tags = { action = "send-chat" },
    })
    tags = { view = "mini", mini_signature = nil }
  end

  if tags.mini_signature ~= signature then
    local scroll = content[MINI_BODY_NAME]
    scroll.clear()

    local pending = player_state.chat_pending ~= nil
    local answer = ui_state.last_answer(player_state)
    local caption
    if pending then
      caption = { "factorio-ai-assistant.chat-thinking" }
    elseif answer ~= nil then
      caption = answer.text
    else
      caption = { "factorio-ai-assistant.mini-empty" }
    end

    local label = scroll.add({
      type = "label",
      name = MINI_ANSWER_NAME,
      caption = caption,
    })
    label.style.single_line = false
    label.style.maximal_width = SIZE_DIMENSIONS.mini.width - 60
    scroll.scroll_to_top()

    -- Match the main panel: a request already in flight must not be resubmitted.
    local input = find_element(content, ui.CHAT_INPUT_NAME)
    if input ~= nil then
      input.enabled = not pending
    end
    tags.mini_signature = signature
  end

  content.tags = tags
end

apply_frame_size = function(frame, player_state)
  local dimensions = SIZE_DIMENSIONS[player_state.size]
    or SIZE_DIMENSIONS.compact
  frame.style.width = dimensions.width
  frame.style.height = dimensions.height
  local content = frame[CONTENT_NAME]
  if content ~= nil then
    content.style.horizontally_stretchable = true
    content.style.vertically_stretchable = true
  end
end

ensure_shell = function(content, player_state)
  if content[NOTICE_NAME] == nil then
    add_notice(content)
  end
  local tabs = content[TABS_NAME]
  -- A panel left open across a Mod update can still hold the previous tab set
  -- (for example the removed calculator page), so rebuild it when it no longer
  -- matches TAB_ORDER.
  if tabs ~= nil and #tabs.children ~= #TAB_ORDER then
    tabs.destroy()
    tabs = nil
  end
  if tabs == nil then
    tabs = add_tabs(content)
  end
  update_tabs(tabs, player_state.active_tab)
  if content[BODY_NAME] == nil then
    local body = content.add({
      type = "flow",
      name = BODY_NAME,
      direction = "vertical",
    })
    body.style.horizontally_stretchable = true
    body.style.vertically_stretchable = true
  end
end

add_notice = function(parent)
  local notice = parent.add({
    type = "label",
    name = NOTICE_NAME,
    caption = { "factorio-ai-assistant.nonofficial-notice" },
  })
  notice.style.font_color = { r = 0.7, g = 0.72, b = 0.75 }
end

add_tabs = function(parent)
  local flow = parent.add({
    type = "flow",
    name = TABS_NAME,
    direction = "horizontal",
  })
  for _, tab in ipairs(TAB_ORDER) do
    flow.add({
      type = "button",
      caption = { "factorio-ai-assistant.tab-" .. tab },
      tags = {
        action = "tab",
        tab = tab,
      },
    })
  end
  return flow
end

update_tabs = function(flow, active_tab)
  for _, child in pairs(flow.children) do
    local tab = child.tags and child.tags.tab
    if tab ~= nil then
      local style = tab == active_tab and "confirm_button" or "button"
      if child.style.name ~= style then
        child.style = style
      end
    end
  end
end

render_chat = function(body, state, player_state)
  local signature = chat_signature(state, player_state)
  local tags = body.tags or {}
  if tags.view ~= "chat" or tags.chat_signature ~= signature then
    body.clear()
    build_chat(body, state, player_state)
    tags = {
      view = "chat",
      chat_signature = signature,
      chat_revision = nil,
    }
  end

  local history = body[CHAT_HISTORY_NAME]
  sync_chat_entries(history, player_state)
  update_chat_controls(body, player_state)

  if tags.chat_revision ~= player_state.chat_revision then
    history.scroll_to_bottom()
    tags.chat_revision = player_state.chat_revision
  end
  body.tags = tags
end

chat_signature = function(state, player_state)
  local mismatch = state.component_version_mismatch
  local banner = "online"
  if incompatibility_caption(state) ~= nil then
    banner = "incompatible"
  elseif not state.connected then
    banner = "offline"
  end
  return table.concat({
    banner,
    tostring(state.protocol_mismatch),
    mismatch ~= nil
      and tostring(mismatch.mod_version)
        .. ">"
        .. tostring(mismatch.companion_version)
      or "-",
    player_state.size,
  }, "|")
end

build_chat = function(parent, state, player_state)
  local incompatible = incompatibility_caption(state)
  if incompatible ~= nil then
    add_state_banner(parent, "warning", incompatible)
  elseif not state.connected then
    add_state_banner(parent, "offline", {
      "factorio-ai-assistant.chat-offline",
    })
  end

  local history = parent.add({
    type = "scroll-pane",
    name = CHAT_HISTORY_NAME,
    direction = "vertical",
  })
  history.style.horizontally_stretchable = true
  history.style.vertically_stretchable = true
  history.style.padding = 8

  local quick = parent.add({
    type = "flow",
    direction = "horizontal",
  })
  quick.style.vertical_align = "center"
  local prompts = quick.add({
    type = "table",
    column_count = QUICK_PROMPT_COLUMNS,
  })
  for index = 1, QUICK_PROMPT_COUNT do
    prompts.add({
      type = "button",
      caption = { "factorio-ai-assistant.quick-" .. index },
      tags = {
        action = "quick-question",
        question_key = "quick-" .. index .. "-question",
      },
    })
  end
  local spacer = quick.add({ type = "empty-widget" })
  spacer.style.horizontally_stretchable = true
  quick.add({
    type = "button",
    name = ui.HIGHLIGHT_CLEAR_NAME,
    caption = { "factorio-ai-assistant.clear-highlights" },
    tooltip = { "factorio-ai-assistant.clear-highlights-tooltip" },
    tags = { action = "clear-highlights" },
  })
  quick.add({
    type = "button",
    name = ui.CHAT_CLEAR_NAME,
    caption = { "factorio-ai-assistant.clear-chat" },
    tooltip = { "factorio-ai-assistant.clear-chat-tooltip" },
    tags = { action = "clear-chat" },
  })

  local input_flow = parent.add({
    type = "flow",
    direction = "horizontal",
  })
  local input = input_flow.add({
    type = "textfield",
    name = ui.CHAT_INPUT_NAME,
    tooltip = { "factorio-ai-assistant.chat-input-tooltip" },
    text = ui_state.draft(player_state),
  })
  input.style.horizontally_stretchable = true
  input_flow.add({
    type = "button",
    name = ui.CHAT_SEND_NAME,
    caption = { "factorio-ai-assistant.send" },
    style = "confirm_button",
    tags = { action = "send-chat" },
  })
  input_flow.add({
    type = "button",
    name = ui.CHAT_CANCEL_NAME,
    caption = { "factorio-ai-assistant.cancel" },
    tags = { action = "cancel-chat" },
  })
end

sync_chat_entries = function(history, player_state)
  local wanted = {}
  for _, entry in ipairs(player_state.chat_history) do
    wanted[CHAT_ENTRY_PREFIX .. entry.seq] = true
  end
  for _, child in pairs(history.children) do
    local name = child.name
    if name ~= nil
      and string.sub(name, 1, #CHAT_ENTRY_PREFIX) == CHAT_ENTRY_PREFIX
      and not wanted[name]
    then
      child.destroy()
    end
  end

  local empty = history[CHAT_EMPTY_NAME]
  if #player_state.chat_history == 0 then
    if empty == nil then
      local label = history.add({
        type = "label",
        name = CHAT_EMPTY_NAME,
        caption = { "factorio-ai-assistant.chat-empty" },
      })
      label.style.single_line = false
      label.style.maximal_width = panel_text_width(player_state)
    end
  elseif empty ~= nil then
    empty.destroy()
  end

  for _, entry in ipairs(player_state.chat_history) do
    local name = CHAT_ENTRY_PREFIX .. entry.seq
    if history[name] == nil then
      render_chat_entry(history, entry, player_state, name)
    end
  end

  local loading = history[CHAT_LOADING_NAME]
  if loading ~= nil then
    loading.destroy()
  end
  if player_state.chat_pending ~= nil then
    local pending = history.add({
      type = "label",
      name = CHAT_LOADING_NAME,
      caption = { "factorio-ai-assistant.chat-loading" },
    })
    pending.style.font_color = { r = 1, g = 0.72, b = 0.2 }
  end
end

update_chat_controls = function(body, player_state)
  local pending = player_state.chat_pending ~= nil
  local input = find_element(body, ui.CHAT_INPUT_NAME)
  local send = find_element(body, ui.CHAT_SEND_NAME)
  local cancel = find_element(body, ui.CHAT_CANCEL_NAME)
  local clear = find_element(body, ui.CHAT_CLEAR_NAME)
  if input ~= nil then
    input.enabled = not pending
    -- Sending consumes the draft, so an input still holding that text would
    -- offer the just-asked question up for an accidental resend.
    if player_state.draft == nil and player_state.draft_sent then
      input.text = ""
      player_state.draft_sent = nil
    end
  end
  if send ~= nil then
    send.enabled = not pending
  end
  if cancel ~= nil then
    cancel.enabled = pending
  end
  if clear ~= nil then
    clear.enabled = pending or #player_state.chat_history > 0
  end
end

render_chat_entry = function(parent, entry, player_state, name)
  local card = parent.add({
    type = "frame",
    name = name,
    direction = "vertical",
    style = "inside_shallow_frame",
  })
  card.style.horizontally_stretchable = true
  local header = card.add({
    type = "label",
    caption = { "factorio-ai-assistant.role-" .. entry.role },
  })
  if entry.role == "assistant" then
    header.style.font_color = { r = 0.35, g = 0.8, b = 1 }
  elseif entry.role == "user" then
    header.style.font_color = { r = 0.45, g = 0.9, b = 0.55 }
  else
    header.style.font_color = { r = 1, g = 0.72, b = 0.2 }
  end

  local caption
  if entry.locale ~= nil then
    if entry.locale == "chat-error" then
      caption = {
        "factorio-ai-assistant.chat-error",
        entry.error_code or "UNKNOWN",
      }
    else
      caption = { "factorio-ai-assistant." .. entry.locale }
    end
  else
    caption = entry.text or ""
  end
  add_wrapped_label(card, caption, panel_text_width(player_state))

  if entry.role == "assistant" and entry.text ~= nil then
    if entry.mode ~= nil then
      local mode = card.add({
        type = "label",
        caption = {
          "factorio-ai-assistant.answer-mode",
          {
            "factorio-ai-assistant.answer-mode-" .. entry.mode,
          },
        },
      })
      mode.style.font_color = { r = 0.65, g = 0.67, b = 0.7 }
    end
  end
end

compare_alerts = function(left, right)
  local left_rank = SEVERITY_RANK[left.severity] or 99
  local right_rank = SEVERITY_RANK[right.severity] or 99
  if left_rank ~= right_rank then
    return left_rank < right_rank
  end
  if left.first_seen ~= right.first_seen then
    return left.first_seen < right.first_seen
  end
  return left.id < right.id
end

collect_force_alerts = function(state, force_id)
  local alerts = {}
  for _, alert in pairs(state.advisor_alerts or {}) do
    if alert.force_id == force_id then
      table.insert(alerts, alert)
    end
  end
  table.sort(alerts, compare_alerts)
  return alerts
end

hud_alerts = function(state, player_state, force_id)
  local muted = muted_rule_set()
  local visible = {}
  for _, alert in ipairs(collect_force_alerts(state, force_id)) do
    if not muted[alert.rule_id]
      and not ui_state.is_alert_dismissed(player_state, alert)
    then
      table.insert(visible, alert)
    end
  end
  return visible
end

hud_signature = function(alerts)
  local parts = {}
  for _, alert in ipairs(alerts) do
    table.insert(
      parts,
      alert.id
        .. "|"
        .. alert.severity
        .. "|"
        .. tostring(alert.first_seen)
        .. "|"
        .. alert.evidence
    )
  end
  return table.concat(parts, "\n")
end

render_alerts = function(parent, state, player_state, force_id)
  local incompatible = incompatibility_caption(state)
  if incompatible ~= nil then
    add_state_banner(parent, "warning", incompatible)
  elseif not state.connected then
    add_state_banner(parent, "offline", {
      "factorio-ai-assistant.alerts-offline",
    })
  end

  local alerts = collect_force_alerts(state, force_id)

  local toolbar = parent.add({
    type = "flow",
    direction = "horizontal",
  })
  toolbar.style.horizontally_stretchable = true
  toolbar.style.vertical_align = "center"
  local toolbar_spacer = toolbar.add({ type = "empty-widget" })
  toolbar_spacer.style.horizontally_stretchable = true
  local clear_all = toolbar.add({
    type = "button",
    name = ui.CLEAR_ALERTS_NAME,
    caption = { "factorio-ai-assistant.clear-alerts" },
    tooltip = { "factorio-ai-assistant.clear-alerts-tooltip" },
    tags = { action = "clear-alerts" },
  })
  clear_all.enabled =
    #ui_state.pending_alerts(state, player_state, force_id) > 0

  local scroll = parent.add({
    type = "scroll-pane",
    direction = "vertical",
  })
  scroll.style.horizontally_stretchable = true
  scroll.style.vertically_stretchable = true
  if #alerts == 0 then
    add_wrapped_label(
      scroll,
      { "factorio-ai-assistant.alerts-empty" },
      500
    )
  end

  local muted = muted_rule_set()
  for _, alert in ipairs(alerts) do
    local dismissed = ui_state.is_alert_dismissed(player_state, alert)
    local card = scroll.add({
      type = "frame",
      direction = "vertical",
      style = "inside_shallow_frame",
    })
    card.style.horizontally_stretchable = true
    local heading_flow = card.add({
      type = "flow",
      direction = "horizontal",
    })
    heading_flow.style.horizontally_stretchable = true
    heading_flow.style.vertical_align = "center"
    local heading = heading_flow.add({
      type = "label",
      caption = {
        "factorio-ai-assistant.alert-heading",
        localized_severity(alert.severity),
        localized_rule(alert.rule_id),
      },
    })
    heading.style.font_color = dismissed
      and { r = 0.6, g = 0.62, b = 0.65 }
      or SEVERITY_COLORS[alert.severity]
    if dismissed or muted[alert.rule_id] then
      local spacer = heading_flow.add({ type = "empty-widget" })
      spacer.style.horizontally_stretchable = true
      local badge = heading_flow.add({
        type = "label",
        caption = {
          "factorio-ai-assistant."
            .. (dismissed and "alert-dismissed" or "alert-muted"),
        },
      })
      badge.style.font = "default-bold"
      badge.style.font_color = { r = 0.6, g = 0.62, b = 0.65 }
    end
    add_wrapped_label(
      card,
      { "factorio-ai-assistant.evidence", alert.evidence },
      650
    )
    add_wrapped_label(
      card,
      { "factorio-ai-assistant.recommendation", alert.recommendation },
      650
    )
    local actions = card.add({
      type = "flow",
      direction = "horizontal",
    })
    actions.add({
      type = "button",
      caption = {
        "factorio-ai-assistant." ..
          (dismissed and "restore-alert" or "dismiss-alert"),
      },
      tooltip = {
        "factorio-ai-assistant." ..
          (dismissed and "restore-alert-tooltip" or "dismiss-alert-tooltip"),
      },
      tags = {
        action = dismissed and "restore-alert" or "dismiss-alert",
        alert_id = alert.id,
      },
    })
    actions.add({
      type = "button",
      caption = {
        "factorio-ai-assistant." ..
          (muted[alert.rule_id] and "resume-rule" or "mute-rule"),
      },
      tags = {
        action = muted[alert.rule_id] and "unmute-rule" or "mute-rule",
        rule_id = alert.rule_id,
      },
    })
  end

  if next(muted) ~= nil then
    local muted_heading = scroll.add({
      type = "label",
      caption = { "factorio-ai-assistant.muted-rules" },
    })
    muted_heading.style.font = "default-bold"
    for rule_id in pairs(muted) do
      scroll.add({
        type = "button",
        caption = {
          "factorio-ai-assistant.resume-muted-rule",
          localized_rule(rule_id),
        },
        tags = {
          action = "unmute-rule",
          rule_id = rule_id,
        },
      })
    end
  end
end

render_status = function(parent, state, player)
  local incompatible = incompatibility_caption(state)
  if incompatible ~= nil then
    add_state_banner(parent, "warning", incompatible)
  elseif not state.connected then
    add_state_banner(parent, "offline", {
      "factorio-ai-assistant.status-offline-detail",
    })
  end

  local table_element = parent.add({
    type = "table",
    column_count = 2,
  })
  table_element.style.horizontally_stretchable = true
  add_status_row(
    table_element,
    "status-companion",
    state.connected and "connected" or "disconnected"
  )
  add_status_value(
    table_element,
    "status-mod-version",
    state.mod_version or "-"
  )
  add_status_value(
    table_element,
    "status-companion-version",
    state.companion_version or "-"
  )
  add_status_value(
    table_element,
    "status-protocol",
    tostring(state.protocol_version or 1)
      .. " / "
      .. tostring(state.schema_version or 2)
  )
  add_status_value(
    table_element,
    "status-last-response",
    format_last_response(state.last_response_tick)
  )
  add_status_value(
    table_element,
    "status-last-sync",
    format_last_response(state.last_sync_tick)
  )
  add_status_value(
    table_element,
    "status-static-revision",
    tostring(state.static_revision or 0)
  )
  add_status_value(
    table_element,
    "status-name-locale",
    localization_summary(state)
  )
  add_status_row(table_element, "status-auto-pause", auto_pause_caption(player))

  local assistant = state.assistant_status
  if assistant ~= nil then
    add_status_row(
      table_element,
      "status-model-mode",
      "assistant-mode-" .. assistant.mode
    )
    add_status_value(
      table_element,
      "status-provider",
      assistant.provider
    )
    add_status_value(
      table_element,
      "status-model",
      assistant.model or "-"
    )
    add_status_row(
      table_element,
      "status-privacy",
      "privacy-" .. assistant.privacy
    )
  else
    add_status_value(table_element, "status-model-mode", "-")
    add_status_value(table_element, "status-provider", "-")
    add_status_value(table_element, "status-model", "-")
    add_status_value(table_element, "status-privacy", "-")
  end

  parent.add({
    type = "button",
    caption = { "factorio-ai-assistant.reconnect" },
    tags = { action = "reconnect" },
  })
end

refresh_header_status = function(frame, state)
  local titlebar = frame[TITLEBAR_NAME]
  local status = titlebar and titlebar[HEADER_STATUS_NAME]
  if status == nil then
    return
  end
  if incompatibility_caption(state) ~= nil then
    status.caption = { "factorio-ai-assistant.header-incompatible" }
    status.style.font_color = { r = 1, g = 0.72, b = 0.2 }
  elseif not state.connected then
    status.caption = { "factorio-ai-assistant.header-offline" }
    status.style.font_color = { r = 1, g = 0.35, b = 0.32 }
  else
    status.caption = { "factorio-ai-assistant.header-online" }
    status.style.font_color = { r = 0.3, g = 0.88, b = 0.48 }
  end
end

incompatibility_caption = function(state)
  if state.protocol_mismatch ~= nil then
    return {
      "factorio-ai-assistant.protocol-version-incompatible",
      tostring(state.protocol_version or 1),
      tostring(state.protocol_mismatch),
    }
  end
  if state.component_version_mismatch ~= nil then
    return {
      "factorio-ai-assistant.component-version-incompatible",
      state.component_version_mismatch.mod_version,
      state.component_version_mismatch.companion_version,
    }
  end
  if state.connected and state.assistant_status == nil then
    return { "factorio-ai-assistant.protocol-incompatible" }
  end
  return nil
end

add_state_banner = function(parent, kind, caption)
  local frame = parent.add({
    type = "frame",
    direction = "horizontal",
    style = "inside_shallow_frame",
  })
  frame.style.horizontally_stretchable = true
  local label = frame.add({
    type = "label",
    caption = caption,
  })
  local colors = {
    offline = { r = 1, g = 0.45, b = 0.4 },
    warning = { r = 1, g = 0.72, b = 0.2 },
    error = { r = 1, g = 0.35, b = 0.32 },
    loading = { r = 0.35, g = 0.72, b = 1 },
  }
  label.style.font_color = colors[kind] or colors.warning
  label.style.single_line = false
end

add_wrapped_label = function(parent, caption, width)
  local label = parent.add({
    type = "label",
    caption = caption,
  })
  label.style.single_line = false
  label.style.maximal_width = width
  return label
end

add_status_row = function(parent, label_locale, value_locale)
  parent.add({
    type = "label",
    caption = { "factorio-ai-assistant." .. label_locale },
  })
  parent.add({
    type = "label",
    caption = { "factorio-ai-assistant." .. value_locale },
  })
end

add_status_value = function(parent, label_locale, value)
  parent.add({
    type = "label",
    caption = { "factorio-ai-assistant." .. label_locale },
  })
  parent.add({
    type = "label",
    caption = value,
  })
end

localized_rule = function(rule_id)
  return { "factorio-ai-assistant.rule-" .. rule_id }
end

localized_severity = function(severity)
  return { "factorio-ai-assistant.severity-" .. severity }
end

muted_rule_set = function()
  local result = {}
  local value = settings.global[ALERT_SETTING_NAME].value
  for rule_id in string.gmatch(value, "[^,%s]+") do
    result[rule_id] = true
  end
  return result
end

--- Auto-pause is deliberately unavailable in multiplayer, so the Status tab has
--- to say why instead of showing a switch that silently does nothing.
auto_pause_caption = function(player)
  if not pause.is_available() then
    return "auto-pause-multiplayer"
  end
  if pause.is_enabled(player) then
    return "auto-pause-on"
  end
  return "auto-pause-off"
end

--- Debug summary of the display-name sync: which locale the Companion is being
--- told about and how many prototype names have been translated so far.
localization_summary = function(state)
  local loc = state.localization
  if loc == nil or loc.locale == nil then
    return "-"
  end

  return loc.locale .. " / " .. tostring(loc.name_count or 0)
end

format_last_response = function(tick)
  if tick == nil then
    return { "factorio-ai-assistant.never" }
  end
  return {
    "factorio-ai-assistant.seconds-ago",
    math.floor(math.max(0, game.tick - tick) / 60),
  }
end

panel_text_width = function(player_state)
  local dimensions = SIZE_DIMENSIONS[player_state.size]
    or SIZE_DIMENSIONS.compact
  return dimensions.width - 80
end

find_element = function(root, name)
  if root == nil then
    return nil
  end
  if root.name == name then
    return root
  end
  for _, child in ipairs(root.children or {}) do
    local found = find_element(child, name)
    if found ~= nil then
      return found
    end
  end
  return nil
end

return ui
