data:extend({
  {
    type = "custom-input",
    name = "factorio-ai-assistant-toggle-input",
    key_sequence = "CONTROL + SHIFT + A",
    consuming = "game-only",
  },
  {
    type = "custom-input",
    name = "factorio-ai-assistant-tab-1",
    key_sequence = "CONTROL + SHIFT + 1",
    consuming = "game-only",
  },
  {
    type = "custom-input",
    name = "factorio-ai-assistant-tab-2",
    key_sequence = "CONTROL + SHIFT + 2",
    consuming = "game-only",
  },
  {
    type = "custom-input",
    name = "factorio-ai-assistant-tab-3",
    key_sequence = "CONTROL + SHIFT + 3",
    consuming = "game-only",
  },
  {
    -- Read-only inspection tool: dragging it collects what is inside the box so
    -- a question can be asked about that specific part of the factory. It never
    -- modifies anything, so it needs no build or destroy permissions.
    type = "selection-tool",
    name = "factorio-ai-assistant-inspector",
    subgroup = "tool",
    order = "z[factorio-ai-assistant]",
    icon = "__base__/graphics/icons/blueprint.png",
    icon_size = 64,
    flags = { "only-in-cursor", "spawnable", "not-stackable" },
    stack_size = 1,
    hidden = true,
    select = {
      border_color = { r = 0.2, g = 0.8, b = 1, a = 1 },
      mode = { "any-entity", "same-force" },
      cursor_box_type = "entity",
    },
    alt_select = {
      border_color = { r = 0.2, g = 0.8, b = 1, a = 1 },
      mode = { "any-entity", "same-force" },
      cursor_box_type = "entity",
    },
  },
  {
    type = "shortcut",
    name = "factorio-ai-assistant-inspect",
    action = "spawn-item",
    item_to_spawn = "factorio-ai-assistant-inspector",
    order = "m[factorio-ai-assistant]",
    icon = "__base__/graphics/icons/blueprint.png",
    icon_size = 64,
    small_icon = "__base__/graphics/icons/blueprint.png",
    small_icon_size = 64,
  },
})
