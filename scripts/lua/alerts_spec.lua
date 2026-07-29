--- Batch alert dismissal ("clear all"), driven through the real GUI handlers.
return function(suite)
  local test = suite.test
  local equal = suite.equal
  local MUTED_SETTING = "factorio-ai-assistant-advisor-muted-rules"
  local QUIET_SETTING = "factorio-ai-assistant-advisor-quiet-mode"

  local function open_alerts(world, player)
    world.custom_input("factorio-ai-assistant-tab-2", player)
  end

  local function refresh(world, player)
    local state = world.state()
    local ui = world.module("ui")
    ui.refresh_alerts_hud(player, state, state.ui_players[player.index])
    ui.render(player, state, state.ui_players[player.index])
  end

  local function clear_button(world, player)
    return world.find_by_name(player, "factorio-ai-assistant-clear-alerts")
  end

  local function visible_hud_alerts(world, player)
    local hud = world.hud(player)
    if hud == nil then
      return 0
    end
    return #world.find_within(hud, function(element)
      return (element.tags or {}).action == "dismiss-alert"
    end)
  end

  test("with no alerts the clear button is disabled and no HUD is shown", function()
    local world = suite.world()
    local player = world.game.players[1]

    open_alerts(world, player)

    equal(world.hud(player), nil, "alert HUD")
    equal(clear_button(world, player).enabled, false, "clear button enabled")
  end)

  test("a single alert is dismissed by clear all", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    open_alerts(world, player)

    equal(clear_button(world, player).enabled, true, "clear button enabled")
    world.click(player, clear_button(world, player))

    local state = world.state()
    equal(
      state.ui_players[1].dismissed_alerts["power-low:player"],
      10,
      "dismissed_alerts entry"
    )
    equal(world.hud(player), nil, "alert HUD")
    equal(clear_button(world, player).enabled, false, "clear button enabled")
    equal(#player.printed, 1, "feedback messages")
  end)

  test("clear all dismisses every alert of the force at once", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning", 10))
    suite.publish_alert(
      world,
      suite.alert("material-deficit", "player", "critical", 20)
    )
    suite.publish_alert(world, suite.alert("research-idle", "player", "info", 30))
    open_alerts(world, player)

    equal(visible_hud_alerts(world, player), 3, "HUD rows before clearing")
    world.click(player, clear_button(world, player))

    local dismissed = world.state().ui_players[1].dismissed_alerts
    equal(suite.count(dismissed), 3, "dismissed alert count")
    equal(world.hud(player), nil, "alert HUD")
  end)

  test("clear all keeps the alerts themselves, quiet mode and muted rules", function()
    local world = suite.world()
    local player = world.game.players[1]
    world.settings.global[MUTED_SETTING] = { value = "research-idle" }
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    suite.publish_alert(world, suite.alert("research-idle", "player", "info", 30))
    open_alerts(world, player)

    world.click(player, clear_button(world, player))

    local state = world.state()
    equal(suite.count(state.advisor_alerts), 2, "advisor alerts kept")
    equal(state.advisor_alerts["power-low:player"].severity, "warning", "alert")
    equal(world.settings.global[QUIET_SETTING].value, false, "quiet mode")
    equal(world.settings.global[MUTED_SETTING].value, "research-idle", "muted rules")
  end)

  test("a muted alert is dismissed too and stays dismissed after unmuting", function()
    local world = suite.world()
    local player = world.game.players[1]
    world.settings.global[MUTED_SETTING] = { value = "research-idle" }
    suite.publish_alert(world, suite.alert("research-idle", "player", "info", 30))
    open_alerts(world, player)

    world.click(player, clear_button(world, player))
    world.settings.global[MUTED_SETTING] = { value = "" }
    refresh(world, player)

    equal(
      world.state().ui_players[1].dismissed_alerts["research-idle:player"],
      30,
      "dismissed_alerts entry"
    )
    equal(world.hud(player), nil, "alert HUD")
  end)

  test("clear all only touches the acting player's own force", function()
    local world = suite.world({
      multiplayer = true,
      players = { { index = 1, force = "player" }, { index = 2, force = "team-b" } },
    })
    local first = world.game.players[1]
    local second = world.game.players[2]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning", 10))
    suite.publish_alert(world, suite.alert("power-low", "team-b", "warning", 40))
    open_alerts(world, first)
    open_alerts(world, second)

    world.click(first, clear_button(world, first))

    local state = world.state()
    equal(suite.count(state.ui_players[1].dismissed_alerts), 1, "player 1 dismissals")
    equal(suite.count(state.ui_players[2].dismissed_alerts), 0, "player 2 dismissals")
    equal(world.hud(first), nil, "player 1 HUD")
    suite.truthy(world.hud(second), "player 2 HUD")
    equal(clear_button(world, second).enabled, true, "player 2 clear button")
  end)

  test("clear all only touches the acting player, not others on the same force", function()
    local world = suite.world({
      multiplayer = true,
      players = { { index = 1, force = "player" }, { index = 2, force = "player" } },
    })
    local first = world.game.players[1]
    local second = world.game.players[2]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning", 10))
    open_alerts(world, first)
    open_alerts(world, second)

    world.click(first, clear_button(world, first))

    equal(world.hud(first), nil, "player 1 HUD")
    suite.truthy(world.hud(second), "player 2 HUD")
  end)

  test("a cleared alert comes back when it closes and triggers again", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning", 10))
    open_alerts(world, player)
    world.click(player, clear_button(world, player))
    equal(world.hud(player), nil, "alert HUD after clearing")

    -- The rule closed, then reopened with a fresh lifecycle.
    local state = world.state()
    local ui_state = world.module("ui_state")
    state.advisor_alerts["power-low:player"] = nil
    ui_state.forget_alert(state, "power-low:player")
    suite.publish_alert(world, suite.alert("power-low", "player", "warning", 900))
    refresh(world, player)

    suite.truthy(world.hud(player), "alert HUD after retriggering")
    equal(clear_button(world, player).enabled, true, "clear button enabled")
  end)

  test("a cleared alert stays hidden while its lifecycle continues", function()
    local world = suite.world()
    local player = world.game.players[1]
    local alert = suite.alert("power-low", "player", "warning", 10)
    suite.publish_alert(world, alert)
    open_alerts(world, player)
    world.click(player, clear_button(world, player))

    -- Same lifecycle, only refreshed by a later reminder.
    alert.last_seen = alert.last_seen + 600
    refresh(world, player)

    equal(world.hud(player), nil, "alert HUD")
  end)

  test("restoring one alert after clear all brings just that one back", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning", 10))
    suite.publish_alert(
      world,
      suite.alert("material-deficit", "player", "critical", 20)
    )
    open_alerts(world, player)
    world.click(player, clear_button(world, player))

    world.click(player, world.find_by_action(player, "restore-alert"))

    local dismissed = world.state().ui_players[1].dismissed_alerts
    equal(suite.count(dismissed), 1, "remaining dismissals")
    equal(visible_hud_alerts(world, player), 1, "HUD rows")
    equal(clear_button(world, player).enabled, true, "clear button enabled")
  end)

  test("clearing again after everything is dismissed is a no-op", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))
    open_alerts(world, player)
    world.click(player, clear_button(world, player))
    equal(#player.printed, 1, "feedback messages")

    world.click(player, clear_button(world, player))
    equal(#player.printed, 1, "feedback messages after the second click")
  end)

  test("the persistent card offers clear all and hides itself afterwards", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.publish_alert(world, suite.alert("power-low", "player", "warning"))

    local hud_button = world.find_by_name(
      player,
      "factorio-ai-assistant-hud-clear-alerts"
    )
    suite.truthy(hud_button, "HUD clear button")
    world.click(player, hud_button)

    equal(world.hud(player), nil, "alert HUD")
    equal(suite.count(world.state().advisor_alerts), 1, "advisor alerts kept")
  end)
end
