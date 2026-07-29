--- Adopting AI suggestions as in-game todos, driven through the real packet and
--- GUI handlers.
return function(suite)
  local test = suite.test
  local equal = suite.equal
  local truthy = suite.truthy
  local falsy = suite.falsy

  local function open_alerts(world, player)
    world.custom_input("factorio-ai-assistant-tab-2", player)
  end

  local function answer_with(world, player, actions, payload)
    suite.open_panel(world, player)
    suite.ask(world, player)
    local body = { suggested_actions = actions }
    for key, value in pairs(payload or {}) do
      body[key] = value
    end
    suite.answer(world, player, body)
  end

  local function todo_by_id(world, player, todo_id)
    for _, todo in ipairs(suite.todos(world, player)) do
      if todo.id == todo_id then
        return todo
      end
    end
    return nil
  end

  local function todo_action(world, player, action, todo_id)
    for _, element in ipairs(world.find_all(player, function(candidate)
      local tags = candidate.tags or {}
      return tags.action == action and tags.todo_id == todo_id
    end)) do
      return element
    end
    return nil
  end

  local function clear_button(world, player, action)
    return world.find_by_action(player, action)
  end

  local function online_world(options)
    local world = suite.world(options)
    suite.online(world)
    return world
  end

  local function open_todo_count(world, player)
    return world.module("ui_state").open_todo_count(
      world.state().ui_players[player.index]
    )
  end

  test("a guide suggestion becomes a todo only after the player confirms", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, {
      suite.suggestion("guide-0000000a", "Automate red science", "guide"),
    })

    equal(#suite.todos(world, player), 0, "todos before the click")
    local buttons = suite.todo_buttons(world, player)
    equal(#buttons, 1, "add-to-todo buttons")
    equal(buttons[1].enabled, true, "button enabled")

    world.click(player, buttons[1])

    local todos = suite.todos(world, player)
    equal(#todos, 1, "todos after the click")
    equal(todos[1].id, "guide-0000000a", "todo id")
    equal(todos[1].text, "Automate red science", "todo text")
    equal(todos[1].source, "guide", "todo source")
    equal(todos[1].completed, false, "todo completed")
    equal(todos[1].created_tick, world.game.tick, "todo created tick")
    equal(suite.todo_buttons(world, player)[1].enabled, false, "button after adding")
  end)

  test("alert, calculation and model suggestions all become todos", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, {
      suite.suggestion("alert-00000001", "Add more boilers", "alert"),
      suite.suggestion("calculation-00000002", "Plan for 8 assemblers", "calculation"),
      suite.suggestion("model-00000003", "Expand the smelter column", "model"),
    })

    local buttons = suite.todo_buttons(world, player)
    equal(#buttons, 3, "add-to-todo buttons")
    for _, button in ipairs(buttons) do
      world.click(player, button)
    end

    equal(#suite.todos(world, player), 3, "todo count")
    equal(todo_by_id(world, player, "alert-00000001").source, "alert", "alert source")
    equal(
      todo_by_id(world, player, "calculation-00000002").source,
      "calculation",
      "calculation source"
    )
    equal(todo_by_id(world, player, "model-00000003").source, "model", "model source")
  end)

  test("an answer without structured actions still renders its text", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, nil)

    local history = world.state().ui_players[1].chat_history
    local last = history[#history]
    equal(last.role, "assistant", "last chat role")
    equal(last.text, "answer text", "answer text")
    equal(last.suggested_actions, nil, "suggested actions")
    equal(#suite.todo_buttons(world, player), 0, "add-to-todo buttons")
  end)

  test("a malformed suggestion list is dropped without losing the answer", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, {
      { action_id = "bad id!", text = "unsafe id", source = "guide" },
      { action_id = "no-source-0001", text = "missing source" },
      { action_id = "bad-source-001", text = "unknown source", source = "provider" },
      { action_id = "empty-text-001", text = "", source = "guide" },
    })

    local history = world.state().ui_players[1].chat_history
    equal(history[#history].text, "answer text", "answer text")
    equal(history[#history].suggested_actions, nil, "suggested actions")
    equal(#suite.todo_buttons(world, player), 0, "add-to-todo buttons")
  end)

  test("only the first three suggestions of an answer are offered", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, {
      suite.suggestion("guide-00000001"),
      suite.suggestion("guide-00000002"),
      suite.suggestion("guide-00000003"),
      suite.suggestion("guide-00000004"),
    })

    equal(#suite.todo_buttons(world, player), 3, "add-to-todo buttons")
  end)

  test("a cancelled or failed answer may not carry suggestions", function()
    local world = online_world()
    local player = world.game.players[1]
    suite.open_panel(world, player)
    suite.ask(world, player)
    suite.answer(world, player, {
      status = "cancelled",
      mode = nil,
      text = nil,
      suggested_actions = { suite.suggestion("guide-00000001") },
    })

    -- The whole packet is rejected, so the request is still pending.
    truthy(world.state().ui_players[1].chat_pending, "chat still pending")
    equal(#suite.todos(world, player), 0, "todos")
  end)

  test("clicking the same suggestion twice adds only one todo", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, { suite.suggestion("guide-0000000a") })

    local button = suite.todo_buttons(world, player)[1]
    world.click(player, button)
    world.click(player, button)

    equal(#suite.todos(world, player), 1, "todo count")
  end)

  test("the same suggestion in a later answer is deduped by its stable id", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, { suite.suggestion("guide-0000000a", "Build boilers") })
    world.click(player, suite.todo_buttons(world, player)[1])

    answer_with(world, player, { suite.suggestion("guide-0000000a", "Build boilers") })
    local buttons = suite.todo_buttons(world, player)
    equal(#buttons, 2, "buttons across both answers")
    for _, button in ipairs(buttons) do
      equal(button.enabled, false, "already-added button")
      world.click(player, button)
    end

    equal(#suite.todos(world, player), 1, "todo count")
  end)

  test("a todo can be completed, reopened and deleted", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, { suite.suggestion("guide-0000000a") })
    world.click(player, suite.todo_buttons(world, player)[1])
    open_alerts(world, player)

    world.click(player, todo_action(world, player, "complete-todo", "guide-0000000a"))
    equal(
      todo_by_id(world, player, "guide-0000000a").completed,
      true,
      "completed flag"
    )
    equal(
      todo_by_id(world, player, "guide-0000000a").completed_tick,
      world.game.tick,
      "completed tick"
    )
    equal(open_todo_count(world, player), 0, "open todo count")

    world.click(player, todo_action(world, player, "restore-todo", "guide-0000000a"))
    equal(
      todo_by_id(world, player, "guide-0000000a").completed,
      false,
      "completed flag after reopening"
    )
    equal(
      todo_by_id(world, player, "guide-0000000a").completed_tick,
      nil,
      "completed tick after reopening"
    )
    equal(open_todo_count(world, player), 1, "open todo count after reopening")

    world.click(player, todo_action(world, player, "delete-todo", "guide-0000000a"))
    equal(#suite.todos(world, player), 0, "todo count")
  end)

  test("clear done removes only completed todos, clear all removes the rest", function()
    local world = online_world()
    local player = world.game.players[1]
    answer_with(world, player, {
      suite.suggestion("guide-00000001"),
      suite.suggestion("guide-00000002"),
      suite.suggestion("guide-00000003"),
    })
    for _, button in ipairs(suite.todo_buttons(world, player)) do
      world.click(player, button)
    end
    open_alerts(world, player)

    equal(clear_button(world, player, "clear-completed-todos").enabled, false, "clear done")
    equal(clear_button(world, player, "clear-todos").enabled, true, "clear all")

    world.click(player, todo_action(world, player, "complete-todo", "guide-00000001"))
    world.click(player, clear_button(world, player, "clear-completed-todos"))
    equal(#suite.todos(world, player), 2, "todos after clearing done")
    equal(todo_by_id(world, player, "guide-00000001"), nil, "completed todo removed")

    world.click(player, clear_button(world, player, "clear-todos"))
    equal(#suite.todos(world, player), 0, "todos after clearing all")
    equal(clear_button(world, player, "clear-todos").enabled, false, "clear all when empty")
    equal(#player.printed, 2, "feedback messages")
  end)

  test("clearing an empty todo list is a silent no-op", function()
    local world = online_world()
    local player = world.game.players[1]
    open_alerts(world, player)

    world.click(player, clear_button(world, player, "clear-todos"))
    world.click(player, clear_button(world, player, "clear-completed-todos"))

    equal(#player.printed, 0, "feedback messages")
  end)

  test("the todo list is capped and refuses to overwrite what the player kept", function()
    local world = online_world()
    local player = world.game.players[1]
    local ui_state = world.module("ui_state")
    local player_state = world.state().ui_players[1]

    for index = 1, 25 do
      equal(
        ui_state.add_todo(
          player_state,
          suite.suggestion(string.format("guide-%08d", index)),
          100
        ),
        "added",
        "add #" .. index
      )
    end
    equal(#suite.todos(world, player), 25, "todo count at the cap")

    answer_with(world, player, { suite.suggestion("guide-99999999") })
    world.click(player, suite.todo_buttons(world, player)[1])

    equal(#suite.todos(world, player), 25, "todo count after the refused add")
    equal(todo_by_id(world, player, "guide-99999999"), nil, "refused todo")
    equal(#player.printed, 1, "limit feedback")
  end)

  test("open todos appear in the persistent HUD without alerts or toasts", function()
    local world = online_world()
    local player = world.game.players[1]
    equal(world.hud(player), nil, "HUD before any todo")

    answer_with(world, player, { suite.suggestion("guide-0000000a") })
    world.click(player, suite.todo_buttons(world, player)[1])

    local hud = world.hud(player)
    truthy(hud, "HUD with an open todo")
    equal(
      #world.find_within(hud, function(element)
        return (element.tags or {}).action == "dismiss-alert"
      end),
      0,
      "alert rows"
    )
    equal(player.gui.screen["factorio-ai-assistant-toast"], nil, "toast")

    open_alerts(world, player)
    world.click(player, todo_action(world, player, "complete-todo", "guide-0000000a"))
    equal(world.hud(player), nil, "HUD after completing the only todo")
  end)

  test("todos stay isolated per player in multiplayer", function()
    local world = online_world({
      multiplayer = true,
      players = { { index = 1, force = "player" }, { index = 2, force = "player" } },
    })
    local first = world.game.players[1]
    local second = world.game.players[2]

    answer_with(world, first, { suite.suggestion("guide-0000000a") })
    world.click(first, suite.todo_buttons(world, first)[1])

    equal(#suite.todos(world, first), 1, "player 1 todos")
    equal(#suite.todos(world, second), 0, "player 2 todos")
    truthy(world.hud(first), "player 1 HUD")
    equal(world.hud(second), nil, "player 2 HUD")

    answer_with(world, second, { suite.suggestion("guide-0000000a") })
    equal(suite.todo_buttons(world, second)[1].enabled, true, "player 2 button")
  end)

  test("a save written before todos existed migrates without losing state", function()
    local world = online_world()
    local ui_state = world.module("ui_state")
    local state = world.state()

    -- A pre-todo player state: no todos list, no sequence counter.
    state.ui_players[1].todos = nil
    state.ui_players[1].todo_sequence = nil

    local player_state = ui_state.ensure_player(state, 1)
    equal(#player_state.todos, 0, "migrated todo list")
    equal(ui_state.open_todo_count(player_state), 0, "open todo count")
    falsy(ui_state.has_todo(player_state, "guide-0000000a"), "has_todo")
    equal(
      ui_state.add_todo(player_state, suite.suggestion("guide-0000000a"), 100),
      "added",
      "add after migration"
    )
    equal(#player_state.todos, 1, "todo count after migration")
  end)

  test("open todos sort before completed ones, oldest first", function()
    local world = online_world()
    local player = world.game.players[1]
    local ui_state = world.module("ui_state")
    local player_state = world.state().ui_players[1]

    ui_state.add_todo(player_state, suite.suggestion("guide-00000001"), 100)
    ui_state.add_todo(player_state, suite.suggestion("guide-00000002"), 100)
    ui_state.add_todo(player_state, suite.suggestion("guide-00000003"), 100)
    ui_state.set_todo_completed(player_state, "guide-00000001", true, 120)

    local sorted = ui_state.sorted_todos(player_state)
    equal(sorted[1].id, "guide-00000002", "first todo")
    equal(sorted[2].id, "guide-00000003", "second todo")
    equal(sorted[3].id, "guide-00000001", "completed todo last")
    equal(#suite.todos(world, player), 3, "stored todo count")
  end)
end
