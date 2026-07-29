--- Auto-pause behaviour, driven through the real Mod event handlers.
return function(suite)
  local test = suite.test
  local equal = suite.equal
  local PAUSE_SETTING = "factorio-ai-assistant-auto-pause-on-open"

  local function open_with_button(world, player)
    world.click(player, world.find_by_name(player, "factorio-ai-assistant-toggle"))
  end

  test("the toggle button pauses a single-player game while the panel is open", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)

    suite.truthy(world.panel(player), "panel")
    equal(world.game.tick_paused, true, "tick_paused")
  end)

  test("the close button resumes the game and drops the claim", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)
    world.click_action(player, "close")

    equal(world.panel(player), nil, "panel")
    equal(world.game.tick_paused, false, "tick_paused")
    equal(
      world.state().ui_players[1].auto_pause,
      nil,
      "auto_pause tracking"
    )
  end)

  test("toggling the panel shut with the button resumes the game", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)
    open_with_button(world, player)

    equal(world.panel(player), nil, "panel")
    equal(world.game.tick_paused, false, "tick_paused")
  end)

  test("the toggle shortcut pauses on open and resumes on close", function()
    local world = suite.world()
    local player = world.game.players[1]

    world.custom_input("factorio-ai-assistant-toggle-input", player)
    equal(world.game.tick_paused, true, "tick_paused after opening")

    world.custom_input("factorio-ai-assistant-toggle-input", player)
    equal(world.panel(player), nil, "panel")
    equal(world.game.tick_paused, false, "tick_paused after closing")
  end)

  test("the tab shortcuts open through the same path and pause", function()
    local world = suite.world()
    local player = world.game.players[1]

    world.custom_input("factorio-ai-assistant-tab-2", player)

    suite.truthy(world.panel(player), "panel")
    equal(world.state().ui_players[1].active_tab, "alerts", "active tab")
    equal(world.game.tick_paused, true, "tick_paused")
  end)

  test("ESC closes the panel and resumes the game", function()
    local world = suite.world()
    local player = world.game.players[1]

    world.custom_input("factorio-ai-assistant-toggle-input", player)
    equal(player.opened, world.panel(player), "opened GUI")

    world.press_escape(player)

    equal(world.panel(player), nil, "panel")
    equal(player.opened, nil, "opened GUI after ESC")
    equal(world.game.tick_paused, false, "tick_paused")
  end)

  test("jumping in from an alert card pauses as well", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))

    world.click_action(player, "open-alerts")

    suite.truthy(world.panel(player), "panel")
    equal(world.state().ui_players[1].active_tab, "alerts", "active tab")
    equal(world.game.tick_paused, true, "tick_paused")
  end)

  test("the mock harness opens through the shared path", function()
    local world = suite.world()
    local player = world.game.players[1]

    world.run_command("factorio-ai-assistant-mock", 1, "alerts-many")

    suite.truthy(world.panel(player), "panel")
    equal(world.game.tick_paused, true, "tick_paused")
  end)

  test("a game paused before opening stays paused after closing", function()
    local world = suite.world({ tick_paused = true })
    local player = world.game.players[1]

    open_with_button(world, player)
    equal(world.game.tick_paused, true, "tick_paused while open")
    equal(
      world.state().ui_players[1].auto_pause.paused_by_mod,
      false,
      "paused_by_mod"
    )

    world.click_action(player, "close")
    equal(world.game.tick_paused, true, "tick_paused after closing")
  end)

  test("a disabled per-player setting never pauses", function()
    local world = suite.world()
    local player = world.game.players[1]
    world.set_player_setting(1, PAUSE_SETTING, false)

    open_with_button(world, player)

    suite.truthy(world.panel(player), "panel")
    equal(world.game.tick_paused, false, "tick_paused")
    equal(world.state().ui_players[1].auto_pause, nil, "auto_pause tracking")
  end)

  test("the setting defaults to on", function()
    local world = suite.world()
    equal(
      world.settings.get_player_settings(1)[PAUSE_SETTING].value,
      true,
      "default value"
    )
  end)

  test("multiplayer never touches the global pause state", function()
    local world = suite.world({
      multiplayer = true,
      players = { { index = 1 }, { index = 2 } },
    })
    local player = world.game.players[1]

    open_with_button(world, player)
    suite.truthy(world.panel(player), "panel")
    equal(world.game.tick_paused, false, "tick_paused while open")
    equal(world.state().ui_players[1].auto_pause, nil, "auto_pause tracking")

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
  end)

  test("a multiplayer close never resumes a pause somebody else set", function()
    local world = suite.world({
      multiplayer = true,
      players = { { index = 1 }, { index = 2 } },
    })
    local player = world.game.players[1]

    open_with_button(world, player)
    world.game.tick_paused = true
    world.click_action(player, "close")

    equal(world.game.tick_paused, true, "tick_paused")
  end)

  test("a pause the player lifted manually is not resumed again on close", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)
    equal(world.game.tick_paused, true, "tick_paused after opening")

    -- The player resumed the game by hand; ticks running again is what tells
    -- the Mod its claim is stale.
    world.game.tick_paused = false
    world.run_nth_tick(60)
    equal(
      world.state().ui_players[1].auto_pause.paused_by_mod,
      false,
      "paused_by_mod after reconciling"
    )

    -- ...and then paused it again by hand before closing the panel.
    world.game.tick_paused = true
    world.click_action(player, "close")

    equal(world.game.tick_paused, true, "tick_paused")
  end)

  test("reconciling leaves an active Mod pause alone", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)
    world.run_nth_tick(60)

    equal(
      world.state().ui_players[1].auto_pause.paused_by_mod,
      true,
      "paused_by_mod"
    )
    equal(world.game.tick_paused, true, "tick_paused")
  end)

  test("re-rendering an open panel does not re-claim the pause", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)
    world.game.tick_paused = false
    world.run_nth_tick(60)

    -- Opening the alerts tab on an already open panel must not pause again.
    world.custom_input("factorio-ai-assistant-tab-2", player)
    equal(world.game.tick_paused, false, "tick_paused")
  end)

  test("leaving the game releases a pause the Mod is holding", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)
    world.raise(world.defines.events.on_player_left_game, { player_index = 1 })

    equal(world.panel(player), nil, "panel")
    equal(world.game.tick_paused, false, "tick_paused")
    equal(world.state().ui_players[1].auto_pause, nil, "auto_pause tracking")
  end)

  test("removing a player drops both the pause claim and the UI state", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)
    world.raise(world.defines.events.on_player_removed, { player_index = 1 })

    equal(world.game.tick_paused, false, "tick_paused")
    equal(world.state().ui_players[1], nil, "ui player state")
  end)

  test("the mock reset closes the panel before dropping the player state", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_with_button(world, player)
    world.run_command("factorio-ai-assistant-mock", 1, "clear")

    -- The harness reopens the panel, so the pause is claimed exactly once.
    suite.truthy(world.panel(player), "panel")
    equal(world.game.tick_paused, true, "tick_paused")
    equal(
      world.state().ui_players[1].auto_pause.paused_by_mod,
      true,
      "paused_by_mod"
    )

    world.click_action(player, "close")
    equal(world.game.tick_paused, false, "tick_paused after closing")
  end)
end
