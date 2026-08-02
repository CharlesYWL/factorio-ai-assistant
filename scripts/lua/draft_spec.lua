--- A half-written question lives in a GUI textfield, which the engine destroys
--- along with the panel. Closing the window, switching tabs or toggling mini
--- all rebuild that field, so the draft has to be carried in player state or it
--- silently disappears -- which is indistinguishable from the Mod losing input.
return function(suite)
  local test = suite.test
  local equal = suite.equal

  local INPUT = "factorio-ai-assistant-chat-input"

  local function input(world, player)
    return world.find_by_name(player, INPUT)
  end

  local function type_into(world, player, text)
    local element = input(world, player)
    assert(element ~= nil, "the chat input must be rendered")
    element.text = text
  end

  local function close_panel(world, player)
    world.custom_input("factorio-ai-assistant-toggle-input", player)
  end

  local function player_state(world, player)
    return world.state().ui_players[player.index]
  end

  test("closing and reopening keeps an unsent question", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    type_into(world, player, "为什么这些炉子停了")
    close_panel(world, player)
    suite.open_panel(world, player)

    equal(input(world, player).text, "为什么这些炉子停了", "restored draft")
  end)

  test("toggling mini mode keeps an unsent question", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    type_into(world, player, "铜板缺口多少")
    world.click(player, world.find_by_action(player, "toggle-mini"))

    equal(input(world, player).text, "铜板缺口多少", "draft in mini mode")
  end)

  test("sending clears the draft so it is not restored later", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    suite.ask(world, player, "现在电力够吗")
    suite.answer(world, player, { text = "够。" })
    close_panel(world, player)
    suite.open_panel(world, player)

    equal(input(world, player).text, "", "input after sending")
    equal(player_state(world, player).draft, nil, "stored draft")
  end)

  test("an empty input does not store a draft", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    type_into(world, player, "")
    close_panel(world, player)

    equal(player_state(world, player).draft, nil, "stored draft")
  end)
end
