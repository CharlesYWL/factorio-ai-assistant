--- RC4 integration: auto-pause and batch alert dismissal were built separately
--- and both touch `control.lua`, `ui.lua` and `ui_state.lua`. These cases only
--- assert the seams between them; each feature keeps its own spec file. The
--- last cases pin the rc.4 -> rc.5 save migration after the todo feature was
--- withdrawn.
return function(suite)
  local test = suite.test
  local equal = suite.equal
  local truthy = suite.truthy

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

  local function auto_pause(world, player)
    return world.state().ui_players[player.index].auto_pause
  end

  local function chat_history(world, player)
    return world.state().ui_players[player.index].chat_history
  end

  test("clearing the alerts from the card never resumes a paused game", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    open_with_button(world, player)

    equal(hud_alert_rows(world, player), 1, "HUD alert rows before clearing")
    equal(world.game.tick_paused, true, "tick_paused before clearing")

    world.click(player, hud_clear_alerts(world, player))

    equal(world.game.tick_paused, true, "tick_paused after clearing")
    equal(auto_pause(world, player).paused_by_mod, true, "paused_by_mod")
    equal(world.hud(player), nil, "HUD with nothing left to show")

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
    equal(auto_pause(world, player), nil, "auto_pause tracking")
  end)

  test("clearing the alerts from the panel never resumes a paused game", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    suite.publish_alert(
      world,
      suite.alert("material-deficit", "player", "critical", 20)
    )

    world.custom_input("factorio-ai-assistant-tab-2", player)
    world.click(player, panel_clear_alerts(world, player))

    equal(world.game.tick_paused, true, "tick_paused after clearing")
    equal(auto_pause(world, player).paused_by_mod, true, "paused_by_mod")
    equal(
      suite.count(world.state().ui_players[1].dismissed_alerts),
      2,
      "dismissed alerts"
    )
    equal(suite.count(world.state().advisor_alerts), 2, "advisor alerts kept")
  end)

  test("a Companion answer arrives without disturbing the pause claim", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    open_with_button(world, player)
    suite.ask(world, player)

    equal(world.game.tick_paused, true, "tick_paused while waiting")
    suite.answer(world, player, { text = "build more boilers" })

    local history = chat_history(world, player)
    equal(history[#history].text, "build more boilers", "answer text")
    equal(world.state().ui_players[1].chat_pending, nil, "pending request")
    equal(world.game.tick_paused, true, "tick_paused after answering")
    equal(auto_pause(world, player).paused_by_mod, true, "paused_by_mod")

    world.press_escape(player)
    equal(world.game.tick_paused, false, "tick_paused after ESC")
    equal(#chat_history(world, player), #history, "chat history after ESC")
  end)

  test("the alerts-one mock preloads an alert and claims the pause once", function()
    local world = suite.world()
    local player = world.game.players[1]

    world.run_command("factorio-ai-assistant-mock", 1, "alerts-one")

    truthy(world.panel(player), "panel")
    equal(world.game.tick_paused, true, "tick_paused")
    equal(auto_pause(world, player).paused_by_mod, true, "paused_by_mod")
    equal(hud_alert_rows(world, player), 1, "HUD alert rows")

    world.click(player, hud_clear_alerts(world, player))
    equal(world.game.tick_paused, true, "tick_paused after clearing")

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
  end)

  test("a save from before both features migrates and still pauses", function()
    local world = suite.world()
    local player = world.game.players[1]
    -- A pre-RC4 save: a player entry with no pause claim and no alert history.
    world.state().ui_players[player.index] = {
      active_tab = "chat",
      size = "compact",
      chat_history = {},
      dismissed_alerts = {},
    }

    open_with_button(world, player)

    equal(world.game.tick_paused, true, "tick_paused")

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
  end)

  test("an rc.4 save drops its todo list without losing chat or alerts", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    -- Exactly the shape v0.1.0-rc.4 wrote: a todo list, its sequence counter and
    -- the structured suggestions each todo was adopted from.
    world.state().ui_players[player.index] = {
      active_tab = "chat",
      size = "compact",
      chat_history = {
        {
          role = "assistant",
          text = "answer text",
          tick = 5,
          suggested_actions = {
            { action_id = "guide-0000000a", text = "Automate red science", source = "guide" },
          },
        },
      },
      dismissed_alerts = { ["research-idle:player"] = 30 },
      todos = {
        {
          id = "guide-0000000a",
          text = "Automate red science",
          source = "guide",
          created_tick = 5,
          order = 1,
          completed = false,
        },
      },
      todo_sequence = 1,
    }

    open_with_button(world, player)

    local player_state = world.state().ui_players[player.index]
    equal(player_state.todos, nil, "migrated todo list")
    equal(player_state.todo_sequence, nil, "migrated todo sequence")
    equal(#player_state.chat_history, 1, "chat history")
    equal(player_state.chat_history[1].text, "answer text", "chat entry text")
    equal(
      player_state.chat_history[1].suggested_actions,
      nil,
      "chat entry suggestions"
    )
    equal(
      player_state.dismissed_alerts["research-idle:player"],
      30,
      "dismissed alert entry"
    )
    equal(hud_alert_rows(world, player), 1, "HUD alert rows")
    equal(world.game.tick_paused, true, "tick_paused")

    world.click(player, hud_clear_alerts(world, player))
    equal(world.game.tick_paused, true, "tick_paused after clearing")

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
  end)
end
