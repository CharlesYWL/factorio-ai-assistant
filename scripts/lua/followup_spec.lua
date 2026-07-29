--- The opt-in follow-up feature sends the asking player's own recent questions
--- and answers to the model. The privacy-critical properties are that it is off
--- unless the player turned it on, and that it can never carry another player's
--- conversation, so those are pinned here against the real GUI and send path.
return function(suite)
  local test = suite.test
  local equal = suite.equal
  local truthy = suite.truthy
  local falsy = suite.falsy

  local SETTING = "factorio-ai-assistant-send-chat-history"

  --- Completes one full exchange so a later question has something to carry.
  local function exchange(world, player, question, answer)
    suite.ask(world, player, question)
    suite.answer(world, player, { text = answer })
  end

  local function history_of_last_request(world)
    local packet = world.last_sent("assistant_request")
    truthy(packet ~= nil, "an assistant_request must have been sent")
    return packet.payload.history
  end

  test("the follow-up setting is off unless the player enables it", function()
    local world = suite.world()
    local player = world.game.players[1]
    equal(
      world.settings.get_player_settings(player)[SETTING].value,
      false,
      "shipped default"
    )
  end)

  test("no conversation is sent while the setting stays off", function()
    local world = suite.world()
    local player = world.game.players[1]
    suite.online(world)
    suite.open_panel(world, player)

    exchange(world, player, "每分钟60个绿板要多少铜线", "需要 1 台。")
    suite.ask(world, player, "那铜板呢")

    equal(history_of_last_request(world), nil, "history must be absent")
  end)

  test("an opted-in player carries the previous exchange", function()
    local world = suite.world()
    local player = world.game.players[1]
    world.set_player_setting(player.index, SETTING, true)
    suite.online(world)
    suite.open_panel(world, player)

    exchange(world, player, "每分钟60个绿板要多少铜线", "需要 1 台。")
    suite.ask(world, player, "那铜板呢")

    local history = history_of_last_request(world)
    truthy(history ~= nil, "history must be present")
    equal(#history, 1, "turn count")
    equal(history[1].question, "每分钟60个绿板要多少铜线", "carried question")
    equal(history[1].answer, "需要 1 台。", "carried answer")
  end)

  test("the first question of a conversation carries nothing", function()
    local world = suite.world()
    local player = world.game.players[1]
    world.set_player_setting(player.index, SETTING, true)
    suite.online(world)
    suite.open_panel(world, player)

    suite.ask(world, player, "每分钟60个绿板要多少铜线")

    equal(history_of_last_request(world), nil, "nothing to carry yet")
  end)

  test("turns are ordered oldest first and capped at four", function()
    local world = suite.world()
    local player = world.game.players[1]
    world.set_player_setting(player.index, SETTING, true)
    suite.online(world)
    suite.open_panel(world, player)

    for index = 1, 6 do
      exchange(world, player, "问题" .. index, "回答" .. index)
    end
    suite.ask(world, player, "那它呢")

    local history = history_of_last_request(world)
    equal(#history, 4, "capped turn count")
    equal(history[1].question, "问题3", "oldest carried turn")
    equal(history[4].question, "问题6", "newest carried turn")
  end)

  test("one player's conversation never reaches another player", function()
    local world = suite.world({ players = { { index = 1 }, { index = 2 } } })
    local asker = world.game.players[1]
    local other = world.game.players[2]
    world.set_player_setting(asker.index, SETTING, true)
    world.set_player_setting(other.index, SETTING, true)
    suite.online(world)
    suite.open_panel(world, asker)
    suite.open_panel(world, other)

    exchange(world, other, "另一个玩家的秘密问题", "另一个玩家的答案")
    suite.ask(world, asker, "我的问题")

    -- The asker has no history of their own, and must not inherit the other
    -- player's, even though both are on the same force.
    equal(history_of_last_request(world), nil, "no cross-player history")
  end)

  test("an opted-out player is unaffected by an opted-in one", function()
    local world = suite.world({ players = { { index = 1 }, { index = 2 } } })
    local opted_in = world.game.players[1]
    local opted_out = world.game.players[2]
    world.set_player_setting(opted_in.index, SETTING, true)
    suite.online(world)
    suite.open_panel(world, opted_in)
    suite.open_panel(world, opted_out)

    exchange(world, opted_in, "问题一", "回答一")
    exchange(world, opted_out, "问题二", "回答二")
    suite.ask(world, opted_out, "那它呢")

    equal(history_of_last_request(world), nil, "opted-out sends nothing")
  end)

  test("clearing the chat also clears what would be sent", function()
    local world = suite.world()
    local player = world.game.players[1]
    world.set_player_setting(player.index, SETTING, true)
    suite.online(world)
    suite.open_panel(world, player)

    exchange(world, player, "问题一", "回答一")
    world.state().ui_players[player.index].chat_history = {}
    suite.ask(world, player, "那它呢")

    equal(history_of_last_request(world), nil, "cleared history sends nothing")
  end)

  test("a failed exchange is not carried as a turn", function()
    local world = suite.world()
    local player = world.game.players[1]
    world.set_player_setting(player.index, SETTING, true)
    suite.online(world)
    suite.open_panel(world, player)

    suite.ask(world, player, "会失败的问题")
    suite.answer(world, player, {
      status = "error",
      text = nil,
      error_code = "provider_unavailable",
    })
    suite.ask(world, player, "那它呢")

    local history = history_of_last_request(world)
    falsy(
      history ~= nil and #history > 0,
      "an errored exchange has no answer text to carry"
    )
  end)
end
