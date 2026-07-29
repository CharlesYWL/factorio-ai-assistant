--- Single-player auto-pause for the advisor panel.
---
--- The Mod may only ever release a pause it created itself. If the player (or
--- another Mod) already had the game paused when the panel opened, or resumed
--- it manually while the panel stayed open, closing the panel has to leave the
--- pause exactly as it found it.
local pause = {}

pause.SETTING_NAME = "factorio-ai-assistant-auto-pause-on-open"

local function setting_enabled(player)
  local player_settings = settings.get_player_settings(player)
  local setting = player_settings ~= nil
    and player_settings[pause.SETTING_NAME]
    or nil
  return setting ~= nil and setting.value == true
end

--- Auto-pause is a single-player-only convenience: a multiplayer game shares
--- one tick counter, so pausing it for one player would freeze everybody else.
function pause.is_available()
  return not game.is_multiplayer()
end

function pause.is_enabled(player)
  return pause.is_available() and setting_enabled(player)
end

function pause.is_holding(player_state)
  local tracked = player_state.auto_pause
  return tracked ~= nil and tracked.paused_by_mod == true
end

--- Called after the advisor panel actually opened, never on a re-render of an
--- already open panel.
function pause.on_panel_opened(player, player_state)
  if player_state.auto_pause ~= nil then
    return false
  end
  if not pause.is_enabled(player) then
    return false
  end

  local paused_before = game.tick_paused == true
  player_state.auto_pause = {
    paused_before = paused_before,
    paused_by_mod = not paused_before,
  }
  if paused_before then
    return false
  end

  game.tick_paused = true
  return true
end

--- Called on every close path: the close button, toggling the panel shut,
--- ESC / on_gui_closed, and the player leaving or being removed.
function pause.on_panel_closed(player_state)
  local tracked = player_state.auto_pause
  player_state.auto_pause = nil
  if tracked == nil
    or not tracked.paused_by_mod
    or tracked.paused_before
    or not pause.is_available()
  then
    return false
  end
  if game.tick_paused ~= true then
    return false
  end

  game.tick_paused = false
  return true
end

--- Ticks only advance while the game runs, so reaching this from the periodic
--- handler proves the game is no longer paused: the player resumed it manually
--- and the Mod has to drop its claim instead of resuming a later pause that it
--- never created.
function pause.reconcile(state)
  if game.tick_paused == true then
    return
  end
  for _, player_state in pairs(state.ui_players or {}) do
    local tracked = player_state.auto_pause
    if tracked ~= nil and tracked.paused_by_mod then
      tracked.paused_by_mod = false
    end
  end
end

return pause
