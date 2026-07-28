local mod_gui = require("__core__.lualib.mod-gui")

local ui = {}

ui.BUTTON_NAME = "factorio-ai-assistant-toggle"
ui.PANEL_NAME = "factorio-ai-assistant-panel"
ui.CHAT_INPUT_NAME = "factorio-ai-assistant-chat-input"
ui.CALCULATOR_KIND_NAME = "factorio-ai-assistant-calculator-kind"
ui.CALCULATOR_TARGET_NAME = "factorio-ai-assistant-calculator-target"
ui.CALCULATOR_RATE_NAME = "factorio-ai-assistant-calculator-rate"
ui.CALCULATOR_MACHINE_NAME = "factorio-ai-assistant-calculator-machine"
ui.CALCULATOR_MODULES_NAME = "factorio-ai-assistant-calculator-modules"

local TITLEBAR_NAME = "factorio-ai-assistant-titlebar"
local HEADER_STATUS_NAME = "factorio-ai-assistant-header-status"
local CONTENT_NAME = "factorio-ai-assistant-content"
local TOAST_NAME = "factorio-ai-assistant-toast"
local ALERT_SETTING_NAME = "factorio-ai-assistant-advisor-muted-rules"

local SIZE_DIMENSIONS = {
  compact = { width = 540, height = 620 },
  normal = { width = 700, height = 720 },
  large = { width = 860, height = 820 },
}
local TAB_ORDER = { "chat", "calculator", "alerts", "status" }
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
local CALCULATION_ERROR_LOCALES = {
  COMPANION_OFFLINE = "calc-error-offline",
  PROTOCOL_INCOMPATIBLE = "calc-error-protocol-incompatible",
  STATE_UNAVAILABLE = "calc-error-state-unavailable",
  STATE_TRUNCATED = "calc-error-state-truncated",
  FORCE_NOT_FOUND = "calc-error-force-not-found",
  INVALID_INPUT = "calc-error-invalid-input",
  TARGET_UNREACHABLE = "calc-error-target-unreachable",
  AMBIGUOUS_RECIPE = "calc-error-ambiguous-recipe",
  UNAVAILABLE_RECIPE = "calc-error-unavailable-recipe",
  NO_COMPATIBLE_MACHINE = "calc-error-no-compatible-machine",
  INVALID_MODULE = "calc-error-invalid-module",
  MODULE_LIMIT_EXCEEDED = "calc-error-module-limit",
  MODULE_NOT_ALLOWED = "calc-error-module-not-allowed",
  CYCLIC_RECIPE_GRAPH = "calc-error-cycle",
  UNSATISFIABLE_FLOW = "calc-error-unsatisfiable",
  UNHANDLED_BYPRODUCT = "calc-error-byproduct",
  TIMEOUT = "calc-error-timeout",
}
local apply_frame_size
local add_notice
local add_tabs
local render_chat
local render_chat_entry
local render_calculator
local render_calculation_result
local render_resource_rates
local add_calculation_error
local render_alerts
local render_status
local refresh_header_status
local add_state_banner
local add_wrapped_label
local add_field_label
local add_text_field
local add_status_row
local add_status_value
local localized_rule
local localized_severity
local muted_rule_set
local format_last_response
local panel_text_width
local format_number
local extract_highlights
local find_element

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
  ui.render(player, state, player_state)
end

function ui.close(player)
  local frame = player.gui.screen[ui.PANEL_NAME]
  if frame ~= nil then
    frame.destroy()
  end
end

function ui.toggle(player, state, player_state)
  if ui.is_open(player) then
    ui.close(player)
  else
    ui.open(player, state, player_state)
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
  content.clear()
  add_notice(content)
  add_tabs(content, player_state.active_tab)

  if player_state.active_tab == "chat" then
    render_chat(content, state, player_state)
  elseif player_state.active_tab == "calculator" then
    render_calculator(content, state, player_state)
  elseif player_state.active_tab == "alerts" then
    render_alerts(content, state, player.force.name)
  else
    render_status(content, state)
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

function ui.read_calculator_inputs(player)
  local frame = player.gui.screen[ui.PANEL_NAME]
  local kind = find_element(frame, ui.CALCULATOR_KIND_NAME)
  local target = find_element(frame, ui.CALCULATOR_TARGET_NAME)
  local rate = find_element(frame, ui.CALCULATOR_RATE_NAME)
  local machine = find_element(frame, ui.CALCULATOR_MACHINE_NAME)
  local modules = find_element(frame, ui.CALCULATOR_MODULES_NAME)
  return {
    target_kind =
      kind ~= nil and kind.selected_index == 2 and "fluid" or "item",
    target_id = target and target.text or "",
    rate_per_minute = rate and rate.text or "",
    machine_id = machine and machine.text or "",
    module_ids = modules and modules.text or "",
  }
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

function ui.save_location(player, player_state)
  local frame = player.gui.screen[ui.PANEL_NAME]
  if frame ~= nil then
    player_state.location = {
      x = math.max(0, math.floor(frame.location.x)),
      y = math.max(0, math.floor(frame.location.y)),
    }
  end
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

add_notice = function(parent)
  local notice = parent.add({
    type = "label",
    caption = { "factorio-ai-assistant.nonofficial-notice" },
  })
  notice.style.font_color = { r = 0.7, g = 0.72, b = 0.75 }
end

add_tabs = function(parent, active_tab)
  local flow = parent.add({
    type = "flow",
    direction = "horizontal",
  })
  for _, tab in ipairs(TAB_ORDER) do
    flow.add({
      type = "button",
      caption = { "factorio-ai-assistant.tab-" .. tab },
      style = tab == active_tab and "confirm_button" or "button",
      tags = {
        action = "tab",
        tab = tab,
      },
    })
  end
end

render_chat = function(parent, state, player_state)
  if not state.connected then
    add_state_banner(parent, "offline", {
      "factorio-ai-assistant.chat-offline",
    })
  elseif state.assistant_status == nil then
    add_state_banner(parent, "warning", {
      "factorio-ai-assistant.protocol-incompatible",
    })
  end

  local history = parent.add({
    type = "scroll-pane",
    direction = "vertical",
  })
  history.style.horizontally_stretchable = true
  history.style.vertically_stretchable = true
  history.style.padding = 8
  if #player_state.chat_history == 0 then
    add_wrapped_label(
      history,
      { "factorio-ai-assistant.chat-empty" },
      panel_text_width(player_state)
    )
  else
    for _, entry in ipairs(player_state.chat_history) do
      render_chat_entry(history, entry, player_state)
    end
  end
  if player_state.chat_pending ~= nil then
    local loading = history.add({
      type = "label",
      caption = { "factorio-ai-assistant.chat-loading" },
    })
    loading.style.font_color = { r = 1, g = 0.72, b = 0.2 }
  end

  local quick = parent.add({
    type = "flow",
    direction = "horizontal",
  })
  for index = 1, 3 do
    quick.add({
      type = "button",
      caption = { "factorio-ai-assistant.quick-" .. index },
      tags = {
        action = "quick-question",
        question_key = "quick-" .. index .. "-question",
      },
    })
  end

  local input_flow = parent.add({
    type = "flow",
    direction = "horizontal",
  })
  local input = input_flow.add({
    type = "textfield",
    name = ui.CHAT_INPUT_NAME,
    tooltip = { "factorio-ai-assistant.chat-input-tooltip" },
  })
  input.style.horizontally_stretchable = true
  input.enabled = player_state.chat_pending == nil
  local send = input_flow.add({
    type = "button",
    caption = { "factorio-ai-assistant.send" },
    style = "confirm_button",
    tags = { action = "send-chat" },
  })
  send.enabled = player_state.chat_pending == nil
  local cancel = input_flow.add({
    type = "button",
    caption = { "factorio-ai-assistant.cancel" },
    tags = { action = "cancel-chat" },
  })
  cancel.enabled = player_state.chat_pending ~= nil
end

render_chat_entry = function(parent, entry, player_state)
  local card = parent.add({
    type = "frame",
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
    local highlights = extract_highlights(entry.text)
    if #highlights > 0 then
      local label = card.add({
        type = "label",
        caption = {
          "factorio-ai-assistant.numeric-highlights",
          table.concat(highlights, "  ·  "),
        },
      })
      label.style.font_color = { r = 1, g = 0.75, b = 0.25 }
    end
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

render_calculator = function(parent, state, player_state)
  if not state.connected then
    add_state_banner(parent, "offline", {
      "factorio-ai-assistant.calculator-offline",
    })
  elseif state.assistant_status == nil then
    add_state_banner(parent, "warning", {
      "factorio-ai-assistant.protocol-incompatible",
    })
  end

  local calculator = player_state.calculator
  local fields = parent.add({
    type = "table",
    column_count = 2,
  })
  fields.style.horizontally_stretchable = true
  add_field_label(fields, "calculator-kind")
  fields.add({
    type = "drop-down",
    name = ui.CALCULATOR_KIND_NAME,
    items = {
      { "factorio-ai-assistant.resource-item" },
      { "factorio-ai-assistant.resource-fluid" },
    },
    selected_index = calculator.target_kind == "fluid" and 2 or 1,
  })
  add_field_label(fields, "calculator-target")
  add_text_field(
    fields,
    ui.CALCULATOR_TARGET_NAME,
    calculator.target_id,
    "calculator-target-tooltip"
  )
  add_field_label(fields, "calculator-rate")
  add_text_field(
    fields,
    ui.CALCULATOR_RATE_NAME,
    calculator.rate_per_minute,
    "calculator-rate-tooltip"
  )
  add_field_label(fields, "calculator-machine")
  add_text_field(
    fields,
    ui.CALCULATOR_MACHINE_NAME,
    calculator.machine_id,
    "calculator-machine-tooltip"
  )
  add_field_label(fields, "calculator-modules")
  add_text_field(
    fields,
    ui.CALCULATOR_MODULES_NAME,
    calculator.module_ids,
    "calculator-modules-tooltip"
  )

  local action = parent.add({
    type = "flow",
    direction = "horizontal",
  })
  local calculate = action.add({
    type = "button",
    caption = { "factorio-ai-assistant.calculate" },
    style = "confirm_button",
    tags = { action = "calculate" },
  })
  calculate.enabled = calculator.pending == nil
  action.add({
    type = "label",
    caption = { "factorio-ai-assistant.calculator-assumption-scope" },
  })

  if calculator.pending ~= nil then
    add_state_banner(parent, "loading", {
      "factorio-ai-assistant.calculator-loading",
    })
  elseif calculator.error_code ~= nil then
    add_calculation_error(parent, calculator.error_code)
  elseif calculator.result ~= nil then
    render_calculation_result(parent, calculator.result, player_state)
  else
    add_wrapped_label(
      parent,
      { "factorio-ai-assistant.calculator-empty" },
      panel_text_width(player_state)
    )
  end
end

render_calculation_result = function(parent, result, player_state)
  local summary = parent.add({
    type = "label",
    caption = {
      "factorio-ai-assistant.calculator-result-title",
      result.target.id,
      format_number(result.target.per_minute),
    },
  })
  summary.style.font_color = { r = 1, g = 0.75, b = 0.25 }

  local scroll = parent.add({
    type = "scroll-pane",
    direction = "vertical",
  })
  scroll.style.horizontally_stretchable = true
  scroll.style.vertically_stretchable = true
  local table_element = scroll.add({
    type = "table",
    column_count = 5,
  })
  for _, heading in ipairs({
    "result-recipe",
    "result-machine",
    "result-exact",
    "result-build",
    "result-modules",
  }) do
    local label = table_element.add({
      type = "label",
      caption = { "factorio-ai-assistant." .. heading },
    })
    label.style.font = "default-bold"
  end
  for _, recipe in ipairs(result.recipes) do
    table_element.add({ type = "label", caption = recipe.recipe_id })
    table_element.add({ type = "label", caption = recipe.machine_id })
    local exact = table_element.add({
      type = "label",
      caption = format_number(recipe.machines_exact),
    })
    exact.style.font_color = { r = 1, g = 0.75, b = 0.25 }
    local rounded = table_element.add({
      type = "label",
      caption = tostring(recipe.machines_rounded_up),
    })
    rounded.style.font_color = { r = 0.4, g = 0.9, b = 0.5 }
    table_element.add({
      type = "label",
      caption = #recipe.module_ids == 0
        and { "factorio-ai-assistant.none" }
        or table.concat(recipe.module_ids, ", "),
    })
  end

  render_resource_rates(
    scroll,
    "external-inputs",
    result.external_inputs,
    player_state
  )
  render_resource_rates(
    scroll,
    "byproducts",
    result.byproducts,
    player_state
  )
  add_wrapped_label(
    scroll,
    {
      "factorio-ai-assistant.calculator-rounding",
      result.rounding,
    },
    panel_text_width(player_state)
  )
  if result.truncated then
    add_state_banner(scroll, "warning", {
      "factorio-ai-assistant.calculator-truncated",
    })
  end
end

render_resource_rates = function(parent, locale, resources, player_state)
  local lines = {}
  for _, resource in ipairs(resources) do
    table.insert(
      lines,
      resource.id .. "  " .. format_number(resource.per_minute) .. "/min"
    )
  end
  add_wrapped_label(
    parent,
    {
      "factorio-ai-assistant." .. locale,
      #lines == 0 and "-" or table.concat(lines, "\n"),
    },
    panel_text_width(player_state)
  )
end

add_calculation_error = function(parent, error_code)
  local locale =
    CALCULATION_ERROR_LOCALES[error_code] or "calc-error-unknown"
  add_state_banner(parent, "error", {
    "factorio-ai-assistant." .. locale,
    error_code,
  })
end

render_alerts = function(parent, state, force_id)
  if not state.connected then
    add_state_banner(parent, "offline", {
      "factorio-ai-assistant.alerts-offline",
    })
  end

  local alerts = {}
  for _, alert in pairs(state.advisor_alerts or {}) do
    if alert.force_id == force_id then
      table.insert(alerts, alert)
    end
  end
  table.sort(alerts, function(left, right)
    return (SEVERITY_RANK[left.severity] or 99)
        < (SEVERITY_RANK[right.severity] or 99)
      or (
        left.severity == right.severity
        and left.first_seen < right.first_seen
      )
  end)

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
    local card = scroll.add({
      type = "frame",
      direction = "vertical",
      style = "inside_shallow_frame",
    })
    card.style.horizontally_stretchable = true
    local heading = card.add({
      type = "label",
      caption = {
        "factorio-ai-assistant.alert-heading",
        localized_severity(alert.severity),
        localized_rule(alert.rule_id),
      },
    })
    heading.style.font_color = SEVERITY_COLORS[alert.severity]
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
    card.add({
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

render_status = function(parent, state)
  if not state.connected then
    add_state_banner(parent, "offline", {
      "factorio-ai-assistant.status-offline-detail",
    })
  elseif state.assistant_status == nil then
    add_state_banner(parent, "warning", {
      "factorio-ai-assistant.protocol-incompatible",
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
  if not state.connected then
    status.caption = { "factorio-ai-assistant.header-offline" }
    status.style.font_color = { r = 1, g = 0.35, b = 0.32 }
  elseif state.assistant_status == nil then
    status.caption = { "factorio-ai-assistant.header-incompatible" }
    status.style.font_color = { r = 1, g = 0.72, b = 0.2 }
  else
    status.caption = { "factorio-ai-assistant.header-online" }
    status.style.font_color = { r = 0.3, g = 0.88, b = 0.48 }
  end
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

add_field_label = function(parent, locale)
  parent.add({
    type = "label",
    caption = { "factorio-ai-assistant." .. locale },
  })
end

add_text_field = function(parent, name, text, tooltip)
  local field = parent.add({
    type = "textfield",
    name = name,
    text = text,
    tooltip = { "factorio-ai-assistant." .. tooltip },
  })
  field.style.horizontally_stretchable = true
  return field
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

format_number = function(value)
  if type(value) ~= "number" then
    return tostring(value)
  end
  local rounded = math.floor(value * 1000 + 0.5) / 1000
  return tostring(rounded)
end

extract_highlights = function(text)
  local result = {}
  local seen = {}
  for value in string.gmatch(text, "[-+]?%d[%d%.%%/]*") do
    if not seen[value] then
      table.insert(result, value)
      seen[value] = true
    end
    if #result >= 8 then
      break
    end
  end
  local assumption =
    string.match(text, "[假假][设設][：:][^\n]+")
    or string.match(text, "[Aa]ssumption[^\n]+")
  if assumption ~= nil then
    table.insert(result, assumption)
  end
  return result
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
