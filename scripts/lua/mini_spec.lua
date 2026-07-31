--- Mini mode swaps the whole panel body for a single answer and an input box.
--- Switching in and out has to leave exactly one of each control behind: a
--- leftover input or send button is both visibly broken and ambiguous, since
--- the click handlers resolve controls by name.
return function(suite)
  local test = suite.test
  local equal = suite.equal
  local truthy = suite.truthy

  local function count_by_name(world, player, name)
    return #world.find_all(player, function(element)
      return element.name == name
    end)
  end

  local function count_by_action(world, player, action)
    return #world.find_all(player, function(element)
      return (element.tags or {}).action == action
    end)
  end

  local function toggle_mini(world, player)
    world.click(player, world.find_by_action(player, "toggle-mini"))
  end

  local function player_state(world, player)
    return world.state().ui_players[player.index]
  end

  test("mini mode shows exactly one input and one send button", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    toggle_mini(world, player)

    equal(player_state(world, player).size, "mini", "size")
    equal(
      count_by_name(world, player, "factorio-ai-assistant-chat-input"),
      1,
      "chat inputs"
    )
    equal(count_by_action(world, player, "send-chat"), 1, "send buttons")
  end)

  test("mini mode hides the tab bar and quick questions", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    toggle_mini(world, player)

    equal(count_by_action(world, player, "tab"), 0, "tab buttons")
    equal(
      count_by_action(world, player, "quick-question"),
      0,
      "quick question buttons"
    )
  end)

  test("leaving mini mode removes its answer box and input", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    toggle_mini(world, player)
    toggle_mini(world, player)

    -- Returning to the full panel must not leave the mini body behind: the
    -- screenshot that prompted this test showed both stacked in one window.
    equal(
      count_by_name(world, player, "factorio-ai-assistant-mini-body"),
      0,
      "mini bodies"
    )
    equal(
      count_by_name(world, player, "factorio-ai-assistant-chat-input"),
      1,
      "chat inputs"
    )
    equal(count_by_action(world, player, "send-chat"), 1, "send buttons")
    truthy(count_by_action(world, player, "tab") > 0, "tabs restored")
  end)

  test("repeated toggling never accumulates controls", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    for _ = 1, 4 do
      toggle_mini(world, player)
      toggle_mini(world, player)
    end

    equal(
      count_by_name(world, player, "factorio-ai-assistant-chat-input"),
      1,
      "chat inputs"
    )
    equal(
      count_by_name(world, player, "factorio-ai-assistant-mini-body"),
      0,
      "mini bodies"
    )
  end)

  test("a tab shortcut while in mini mode leaves the panel consistent", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)
    toggle_mini(world, player)

    -- The screenshot that prompted these tests showed the mini body above a
    -- full panel, which means something re-rendered the full layout while mini
    -- was active rather than mini leaking on the way out.
    world.custom_input("factorio-ai-assistant-tab-2", player)

    -- Alerts has no chat input of its own, so the check is that the mini body
    -- did not survive alongside the tabbed layout.
    equal(
      count_by_name(world, player, "factorio-ai-assistant-mini-body"),
      0,
      "mini bodies"
    )
    truthy(count_by_action(world, player, "tab") > 0, "tabs rendered")
  end)

  test("an answer arriving in mini mode does not rebuild the full panel", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)
    toggle_mini(world, player)

    suite.ask(world, player, "问题")
    suite.answer(world, player, { text = "答案" })

    equal(
      count_by_name(world, player, "factorio-ai-assistant-mini-body"),
      1,
      "mini bodies"
    )
    equal(count_by_action(world, player, "tab"), 0, "tab buttons")
    equal(
      count_by_name(world, player, "factorio-ai-assistant-chat-input"),
      1,
      "chat inputs"
    )
  end)

  test("leaving mini mode restores the previous size", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    world.click(player, world.find_by_action(player, "resize"))
    local before = player_state(world, player).size

    toggle_mini(world, player)
    toggle_mini(world, player)

    equal(player_state(world, player).size, before, "restored size")
  end)

  test("asking in mini mode still reaches the Companion", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)
    toggle_mini(world, player)

    suite.ask(world, player, "为什么这些炉子停了")
    suite.answer(world, player, { text = "缺矿。" })

    local history = player_state(world, player).chat_history
    equal(history[#history].text, "缺矿。", "answer recorded")
  end)
end
