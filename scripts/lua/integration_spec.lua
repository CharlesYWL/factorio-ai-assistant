--- RC4 integration: auto-pause, batch alert dismissal and the suggestion/todo
--- loop were built separately and all touch `control.lua`, `ui.lua` and
--- `ui_state.lua`. These cases only assert the seams between them; each feature
--- keeps its own spec file.
return function(suite)
  local test = suite.test
  local equal = suite.equal
  local truthy = suite.truthy
  local falsy = suite.falsy

  local function open_with_button(world, player)
    world.click(player, world.find_by_name(player, "factorio-ai-assistant-toggle"))
  end

  local function panel_clear_alerts(world, player)
    return world.find_by_name(player, "factorio-ai-assistant-clear-alerts")
  end

  local function hud_clear_alerts(world, player)
    return world.find_by_name(player, "factorio-ai-assistant-hud-clear-alerts")
  end

  local function hud_alert_rows(world, player)
    local hud = world.hud(player)
    if hud == nil then
      return 0
    end
    return #world.find_within(hud, function(element)
      return (element.tags or {}).action == "dismiss-alert"
    end)
  end

  local function hud_todo_row(world, player)
    local hud = world.hud(player)
    if hud == nil then
      return nil
    end
    for _, element in ipairs(world.find_within(hud, function(candidate)
      return type(candidate.caption) == "table"
        and candidate.caption[1] == "factorio-ai-assistant.todo-hud-open"
    end)) do
      return element
    end
    return nil
  end

  local function auto_pause(world, player)
    return world.state().ui_players[player.index].auto_pause
  end

  local function open_todo_count(world, player)
    return world.module("ui_state").open_todo_count(
      world.state().ui_players[player.index]
    )
  end

  --- Opens the panel through the toggle button, asks a question and answers it
  --- with structured suggestions over the real UDP path.
  local function answer_with_suggestions(world, player, actions)
    suite.online(world)
    open_with_button(world, player)
    suite.ask(world, player)
    suite.answer(world, player, { suggested_actions = actions })
  end

  local function default_suggestions()
    return {
      suite.suggestion("guide-0000000a", "Automate red science", "guide"),
      suite.suggestion("alert-0000000b", "Add more boilers", "alert"),
    }
  end

  test("clear all alerts keeps the persistent card alive for open todos", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    answer_with_suggestions(world, player, default_suggestions())
    world.click(player, suite.todo_buttons(world, player)[1])

    equal(hud_alert_rows(world, player), 1, "HUD alert rows before clearing")
    truthy(hud_todo_row(world, player), "HUD todo row before clearing")

    world.click(player, hud_clear_alerts(world, player))

    truthy(world.hud(player), "HUD after clearing the alerts")
    equal(hud_alert_rows(world, player), 0, "HUD alert rows after clearing")
    local todo_row = hud_todo_row(world, player)
    truthy(todo_row, "HUD todo row after clearing")
    equal(todo_row.caption[2], 1, "open todo count on the card")
    equal(hud_clear_alerts(world, player), nil, "HUD clear button without alerts")
  end)

  test("clear all alerts never touches the todo list", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    answer_with_suggestions(world, player, default_suggestions())
    for _, button in ipairs(suite.todo_buttons(world, player)) do
      world.click(player, button)
    end
    equal(#suite.todos(world, player), 2, "todos before clearing")

    world.custom_input("factorio-ai-assistant-tab-2", player)
    world.click(player, panel_clear_alerts(world, player))

    equal(#suite.todos(world, player), 2, "todos after clearing")
    equal(open_todo_count(world, player), 2, "open todos after clearing")
    equal(
      suite.count(world.state().ui_players[1].dismissed_alerts),
      1,
      "dismissed alerts"
    )
  end)

  test("clearing the todo list never restores a dismissed alert", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    answer_with_suggestions(world, player, default_suggestions())
    world.click(player, suite.todo_buttons(world, player)[1])
    world.custom_input("factorio-ai-assistant-tab-2", player)
    world.click(player, panel_clear_alerts(world, player))

    world.click(player, world.find_by_action(player, "clear-todos"))

    equal(#suite.todos(world, player), 0, "todos after clearing")
    equal(
      world.state().ui_players[1].dismissed_alerts["power-low:player"],
      10,
      "dismissed alert entry"
    )
    equal(suite.count(world.state().advisor_alerts), 1, "advisor alerts kept")
    equal(world.hud(player), nil, "HUD with nothing left to show")
  end)

  test("adopting a suggestion leaves the auto-pause claim untouched", function()
    local world = suite.world()
    local player = world.game.players[1]
    answer_with_suggestions(world, player, default_suggestions())

    equal(world.game.tick_paused, true, "tick_paused while answering")
    world.click(player, suite.todo_buttons(world, player)[1])

    equal(world.game.tick_paused, true, "tick_paused after adopting")
    equal(auto_pause(world, player).paused_by_mod, true, "paused_by_mod")

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
    equal(auto_pause(world, player), nil, "auto_pause tracking")
    equal(#suite.todos(world, player), 1, "todos survive the close")
  end)

  test("clearing alerts and todos never resumes a paused game", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    answer_with_suggestions(world, player, default_suggestions())
    world.click(player, suite.todo_buttons(world, player)[1])
    world.custom_input("factorio-ai-assistant-tab-2", player)

    world.click(player, panel_clear_alerts(world, player))
    equal(world.game.tick_paused, true, "tick_paused after clearing alerts")

    world.click(player, world.find_by_action(player, "clear-todos"))
    equal(world.game.tick_paused, true, "tick_paused after clearing todos")
    equal(auto_pause(world, player).paused_by_mod, true, "paused_by_mod")
  end)

  test("the todo HUD row survives the panel close and the pause release", function()
    local world = suite.world()
    local player = world.game.players[1]
    answer_with_suggestions(world, player, default_suggestions())
    world.click(player, suite.todo_buttons(world, player)[1])

    world.press_escape(player)

    equal(world.panel(player), nil, "panel after ESC")
    equal(world.game.tick_paused, false, "tick_paused after ESC")
    truthy(hud_todo_row(world, player), "HUD todo row after ESC")

    open_with_button(world, player)
    equal(world.game.tick_paused, true, "tick_paused after reopening")
    equal(#suite.todos(world, player), 1, "todos after reopening")
  end)

  test("the todos mock preloads alerts, todos and a single pause claim", function()
    local world = suite.world()
    local player = world.game.players[1]

    world.run_command("factorio-ai-assistant-mock", 1, "todos")

    truthy(world.panel(player), "panel")
    equal(world.game.tick_paused, true, "tick_paused")
    equal(auto_pause(world, player).paused_by_mod, true, "paused_by_mod")
    equal(#suite.todos(world, player), 3, "preloaded todos")
    equal(open_todo_count(world, player), 2, "preloaded open todos")
    equal(hud_alert_rows(world, player), 1, "HUD alert rows")
    truthy(hud_todo_row(world, player), "HUD todo row")

    world.click(player, hud_clear_alerts(world, player))
    equal(world.game.tick_paused, true, "tick_paused after clearing")
    equal(open_todo_count(world, player), 2, "open todos after clearing")

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
  end)

  test("a save from before both features migrates and still pauses", function()
    local world = suite.world()
    local player = world.game.players[1]
    local ui_state = world.module("ui_state")
    -- A pre-RC4 save: a player entry with neither a todo list nor a pause claim.
    world.state().ui_players[player.index] = {
      active_tab = "chat",
      size = "compact",
      chat_history = {},
      dismissed_alerts = {},
    }

    open_with_button(world, player)

    local player_state = world.state().ui_players[player.index]
    equal(#(player_state.todos or {}), 0, "migrated todo list")
    equal(player_state.todo_sequence, 0, "migrated todo sequence")
    equal(world.game.tick_paused, true, "tick_paused")
    falsy(ui_state.has_todo(player_state, "guide-0000000a"), "unknown todo")

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
  end)
end
