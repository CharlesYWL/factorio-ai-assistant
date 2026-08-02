local collector = {}

local STATE_SCHEMA_VERSION = 2
local MAX_PACKET_BYTES = 16 * 1024
local PACKET_TARGET_BYTES = MAX_PACKET_BYTES - 512
local MAX_FORCE_FRAGMENT_IDS = 128
local MAX_DYNAMIC_FORCES = 16
local MAX_SERIES_PER_KIND = 128

local ONE_MINUTE = defines.flow_precision_index.one_minute
local TEN_MINUTES = defines.flow_precision_index.ten_minutes

local function ensure_collector_state(state)
  state.collector = state.collector or {}
  local collector_state = state.collector

  collector_state.static_revision = collector_state.static_revision or 0
  collector_state.static_dirty = collector_state.static_dirty ~= false
  collector_state.force_cache = collector_state.force_cache or {}
  collector_state.electric_poles = collector_state.electric_poles or {}
  collector_state.sample_sequence = collector_state.sample_sequence or 0
  collector_state.last_sample_log_signature =
    collector_state.last_sample_log_signature or ""
  -- Identifies this save for the whole of its life. Stored in `storage`, so it
  -- travels with the save and lets the Companion keep one timeline per save
  -- without ever seeing a file name or path.
  if collector_state.save_id == nil then
    collector_state.save_id = string.format(
      "%x-%x-%x",
      game.tick,
      math.random(0, 0x7FFFFFFF),
      math.random(0, 0x7FFFFFFF)
    )
  end

  return collector_state
end

local function next_message_id(state, kind)
  state.sequence = (state.sequence or 0) + 1
  return "factorio-" .. kind .. "-" .. game.tick .. "-" .. state.sequence
end

local function sorted_keys(values)
  local result = {}

  for key in pairs(values) do
    table.insert(result, key)
  end

  table.sort(result)
  return result
end

local function sorted_truthy_keys(values)
  local result = {}

  for key, enabled in pairs(values or {}) do
    if enabled then
      table.insert(result, key)
    end
  end

  table.sort(result)
  return result
end

local function rounded(value, decimal_places)
  local multiplier = 10 ^ decimal_places
  return math.floor(value * multiplier + 0.5) / multiplier
end

local function is_playable_force(force)
  return force.valid and #force.players > 0
end

local function playable_forces()
  local forces = {}

  for _, force in pairs(game.forces) do
    if is_playable_force(force) then
      table.insert(forces, force)
    end
  end

  table.sort(forces, function(left, right)
    return left.name < right.name
  end)
  return forces
end

local function collect_force_sets(force)
  local technologies = {}
  local recipes = {}
  local productivity_bonuses = {}

  for name, technology in pairs(force.technologies) do
    if technology.researched then
      technologies[name] = true
    end
  end

  for name, recipe in pairs(force.recipes) do
    if recipe.enabled and not recipe.hidden then
      recipes[name] = true
    end
    if recipe.productivity_bonus ~= 0 then
      productivity_bonuses[name] = rounded(recipe.productivity_bonus, 6)
    end
  end

  return {
    technologies = technologies,
    recipes = recipes,
    productivity_bonuses = productivity_bonuses,
  }
end

local function array_slice(values, first, last)
  local result = {}

  for index = first, math.min(last, #values) do
    table.insert(result, values[index])
  end

  return result
end

local function productivity_bonus_descriptors(productivity_bonuses)
  local result = {}

  for _, recipe_id in ipairs(sorted_keys(productivity_bonuses)) do
    table.insert(result, {
      recipe_id = recipe_id,
      bonus = productivity_bonuses[recipe_id],
    })
  end

  return result
end

local function force_fragments(force, force_cache)
  local sets = collect_force_sets(force)
  force_cache[force.name] = sets

  local technologies = sorted_keys(sets.technologies)
  local recipes = sorted_keys(sets.recipes)
  local productivity_bonuses =
    productivity_bonus_descriptors(sets.productivity_bonuses)
  local fragment_count = math.max(
    1,
    math.ceil(#technologies / MAX_FORCE_FRAGMENT_IDS),
    math.ceil(#recipes / MAX_FORCE_FRAGMENT_IDS),
    math.ceil(#productivity_bonuses / MAX_FORCE_FRAGMENT_IDS)
  )
  local fragments = {}

  for fragment_index = 1, fragment_count do
    local first = (fragment_index - 1) * MAX_FORCE_FRAGMENT_IDS + 1
    local last = fragment_index * MAX_FORCE_FRAGMENT_IDS

    table.insert(fragments, {
      id = force.name,
      researched_technologies = array_slice(technologies, first, last),
      available_recipes = array_slice(recipes, first, last),
      recipe_productivity_bonuses =
        array_slice(productivity_bonuses, first, last),
    })
  end

  return fragments
end

local function collect_game_descriptor()
  local mods = {}

  for id, version in pairs(script.active_mods) do
    table.insert(mods, {
      id = id,
      version = version,
    })
  end

  table.sort(mods, function(left, right)
    return left.id < right.id
  end)

  return {
    version = script.active_mods.base or "unknown",
    mods = mods,
  }
end

local function recipe_component(component, is_product)
  local amount = component.amount

  if amount == nil then
    amount = ((component.amount_min or 0) + (component.amount_max or 0)) / 2
  end

  if is_product then
    amount = (amount + (component.extra_count_fraction or 0))
      * (component.probability or 1)
  end

  local result = {
    kind = component.type,
    id = component.name,
    amount = rounded(amount, 6),
  }

  if component.temperature ~= nil then
    result.temperature = component.temperature
  end
  if component.minimum_temperature ~= nil then
    result.minimum_temperature = component.minimum_temperature
  end
  if component.maximum_temperature ~= nil then
    result.maximum_temperature = component.maximum_temperature
  end
  if is_product and component.ignored_by_productivity ~= nil then
    result.ignored_by_productivity = rounded(
      component.ignored_by_productivity * (component.probability or 1),
      6
    )
  end

  return result
end

local function collect_components(components, is_product)
  local result = {}

  for _, component in ipairs(components) do
    table.insert(result, recipe_component(component, is_product))
  end

  table.sort(result, function(left, right)
    if left.id == right.id then
      return left.kind < right.kind
    end
    return left.id < right.id
  end)
  return result
end

local function collect_recipe_descriptors()
  local result = {}

  for name, recipe in pairs(prototypes.recipe) do
    if not recipe.parameter and not recipe.hidden then
      table.insert(result, {
        id = name,
        category = recipe.category,
        energy_seconds = recipe.energy,
        ingredients = collect_components(recipe.ingredients, false),
        products = collect_components(recipe.products, true),
        allowed_effects = sorted_truthy_keys(recipe.allowed_effects),
        allowed_module_categories =
          sorted_truthy_keys(recipe.allowed_module_categories),
        maximum_productivity = recipe.maximum_productivity,
      })
    end
  end

  table.sort(result, function(left, right)
    return left.id < right.id
  end)
  return result
end

local function collect_machine_descriptors()
  local result = {}

  for name, prototype in pairs(prototypes.entity) do
    if prototype.crafting_categories ~= nil
      and prototype.type ~= "character"
      and not prototype.hidden
    then
      table.insert(result, {
        id = name,
        kind = prototype.type,
        crafting_speed = prototype.get_crafting_speed(),
        crafting_categories = sorted_keys(prototype.crafting_categories),
        module_slots = prototype.module_inventory_size or 0,
        allowed_effects = sorted_truthy_keys(prototype.allowed_effects),
        allowed_module_categories =
          sorted_truthy_keys(prototype.allowed_module_categories),
      })
    end
  end

  table.sort(result, function(left, right)
    return left.id < right.id
  end)
  return result
end

local function collect_module_descriptors()
  local result = {}

  for name, prototype in pairs(prototypes.item) do
    if prototype.module_effects ~= nil
      and prototype.category ~= nil
      and not prototype.hidden
    then
      local effects = {}

      for _, effect in ipairs({
        "consumption",
        "speed",
        "productivity",
        "pollution",
        "quality",
      }) do
        if prototype.module_effects[effect] ~= nil then
          effects[effect] = prototype.module_effects[effect]
        end
      end

      table.insert(result, {
        id = name,
        category = prototype.category,
        effects = effects,
      })
    end
  end

  table.sort(result, function(left, right)
    return left.id < right.id
  end)
  return result
end

local function empty_chunk(game_descriptor)
  return {
    game = game_descriptor,
    forces = {},
    recipes = {},
    machines = {},
    modules = {},
  }
end

local function chunk_has_records(chunk)
  return chunk.game ~= nil
    or #chunk.forces > 0
    or #chunk.recipes > 0
    or #chunk.machines > 0
    or #chunk.modules > 0
end

local function add_record(chunk, record)
  table.insert(chunk[record.collection], record.value)
end

local function remove_last_record(chunk, record)
  table.remove(chunk[record.collection])
end

local function packet_for_chunk(
  chunk,
  snapshot_id,
  revision,
  message_id,
  chunk_index,
  chunk_count,
  truncated,
  omitted_records
)
  local payload = {
    snapshot_id = snapshot_id,
    revision = revision,
    chunk_index = chunk_index,
    chunk_count = chunk_count,
    truncated = truncated,
    omitted_records = omitted_records,
    forces = chunk.forces,
    recipes = chunk.recipes,
    machines = chunk.machines,
    modules = chunk.modules,
  }

  if chunk.game ~= nil then
    payload.game = chunk.game
  end

  return {
    protocol_version = 1,
    schema_version = STATE_SCHEMA_VERSION,
    message_id = message_id,
    type = "static_snapshot",
    tick = game.tick,
    payload = payload,
  }
end

local function estimated_chunk_bytes(chunk, snapshot_id, revision)
  local packet = packet_for_chunk(
    chunk,
    snapshot_id,
    revision,
    string.rep("x", 64),
    999999,
    999999,
    true,
    999999
  )
  return #helpers.table_to_json(packet)
end

function collector.build_static_snapshot(state)
  local collector_state = ensure_collector_state(state)
  local revision = collector_state.static_revision + 1
  local snapshot_id = "static-" .. game.tick .. "-" .. revision
  local game_descriptor = collect_game_descriptor()
  local force_cache = {}
  local records = {}
  local omitted_records = 0
  local first_chunk = empty_chunk(game_descriptor)

  while estimated_chunk_bytes(first_chunk, snapshot_id, revision)
      > PACKET_TARGET_BYTES
    and #game_descriptor.mods > 0
  do
    table.remove(game_descriptor.mods)
    omitted_records = omitted_records + 1
  end

  for _, force in ipairs(playable_forces()) do
    for _, fragment in ipairs(force_fragments(force, force_cache)) do
      table.insert(records, {
        collection = "forces",
        value = fragment,
      })
    end
  end

  for _, recipe in ipairs(collect_recipe_descriptors()) do
    table.insert(records, {
      collection = "recipes",
      value = recipe,
    })
  end

  for _, machine in ipairs(collect_machine_descriptors()) do
    table.insert(records, {
      collection = "machines",
      value = machine,
    })
  end

  for _, module in ipairs(collect_module_descriptors()) do
    table.insert(records, {
      collection = "modules",
      value = module,
    })
  end

  local chunks = {}
  local current_chunk = first_chunk

  for _, record in ipairs(records) do
    add_record(current_chunk, record)

    if estimated_chunk_bytes(current_chunk, snapshot_id, revision)
      > PACKET_TARGET_BYTES
    then
      remove_last_record(current_chunk, record)

      if chunk_has_records(current_chunk) then
        table.insert(chunks, current_chunk)
        current_chunk = empty_chunk(nil)
        add_record(current_chunk, record)
      end

      if estimated_chunk_bytes(current_chunk, snapshot_id, revision)
        > PACKET_TARGET_BYTES
      then
        remove_last_record(current_chunk, record)
        omitted_records = omitted_records + 1
      end
    end
  end

  if chunk_has_records(current_chunk) or #chunks == 0 then
    table.insert(chunks, current_chunk)
  end

  local pending_packets = {}
  local truncated = omitted_records > 0

  for index, chunk in ipairs(chunks) do
    local message_id = next_message_id(state, "static")
    local packet = packet_for_chunk(
      chunk,
      snapshot_id,
      revision,
      message_id,
      index - 1,
      #chunks,
      truncated,
      omitted_records
    )
    local encoded = helpers.table_to_json(packet)

    if #encoded > MAX_PACKET_BYTES then
      log(
        "[factorio-ai-assistant] Static snapshot packet budget exceeded; "
          .. "snapshot was not queued"
      )
      return nil
    end

    table.insert(pending_packets, {
      message_id = message_id,
      revision = revision,
      encoded = encoded,
    })
  end

  collector_state.static_revision = revision
  collector_state.static_dirty = false
  collector_state.force_cache = force_cache

  return pending_packets
end

local function set_difference(left, right)
  local result = {}

  for value in pairs(left) do
    if not right[value] then
      table.insert(result, value)
    end
  end

  table.sort(result)
  return result
end

local function productivity_bonuses_changed(left, right)
  for recipe_id, bonus in pairs(left or {}) do
    if right == nil or right[recipe_id] ~= bonus then
      return true
    end
  end
  for recipe_id in pairs(right or {}) do
    if left == nil or left[recipe_id] == nil then
      return true
    end
  end
  return false
end

function collector.build_static_delta(state, force)
  local collector_state = ensure_collector_state(state)
  local cached = collector_state.force_cache[force.name]

  if cached == nil or collector_state.static_revision == 0 then
    collector_state.static_dirty = true
    return nil, true
  end

  local current = collect_force_sets(force)
  local technologies_added = set_difference(
    current.technologies,
    cached.technologies
  )
  local technologies_removed = set_difference(
    cached.technologies,
    current.technologies
  )
  local recipes_added = set_difference(current.recipes, cached.recipes)
  local recipes_removed = set_difference(cached.recipes, current.recipes)

  if #technologies_added == 0
    and #technologies_removed == 0
    and #recipes_added == 0
    and #recipes_removed == 0
    and not productivity_bonuses_changed(
      cached.productivity_bonuses,
      current.productivity_bonuses
    )
  then
    return nil, false
  end

  local base_revision = collector_state.static_revision
  local revision = base_revision + 1
  local message_id = next_message_id(state, "delta")
  local packet = {
    protocol_version = 1,
    schema_version = STATE_SCHEMA_VERSION,
    message_id = message_id,
    type = "static_delta",
    tick = game.tick,
    payload = {
      base_revision = base_revision,
      revision = revision,
      force = {
        id = force.name,
        researched_technologies_added = technologies_added,
        researched_technologies_removed = technologies_removed,
        available_recipes_added = recipes_added,
        available_recipes_removed = recipes_removed,
        recipe_productivity_bonuses =
          productivity_bonus_descriptors(current.productivity_bonuses),
      },
    },
  }
  local encoded = helpers.table_to_json(packet)

  if #encoded > MAX_PACKET_BYTES then
    collector_state.static_dirty = true
    return nil, true
  end

  collector_state.static_revision = revision
  collector_state.force_cache[force.name] = current

  return {
    message_id = message_id,
    revision = revision,
    encoded = encoded,
  }, false
end

function collector.track_electric_pole(state, entity)
  if not entity.valid
    or entity.type ~= "electric-pole"
    or entity.unit_number == nil
  then
    return
  end

  local collector_state = ensure_collector_state(state)
  collector_state.electric_poles[entity.unit_number] = entity
end

function collector.untrack_electric_pole(state, entity)
  if entity.unit_number == nil then
    return
  end

  local collector_state = ensure_collector_state(state)
  collector_state.electric_poles[entity.unit_number] = nil
end

function collector.rebuild_power_cache(state)
  local collector_state = ensure_collector_state(state)
  collector_state.electric_poles = {}

  for _, surface in pairs(game.surfaces) do
    for _, entity in ipairs(surface.find_entities_filtered({
      type = "electric-pole",
    })) do
      collector.track_electric_pole(state, entity)
    end
  end
end

function collector.initialize(state)
  ensure_collector_state(state)
  collector.rebuild_power_cache(state)
end

function collector.invalidate_static(state)
  ensure_collector_state(state).static_dirty = true
end

function collector.static_revision(state)
  return ensure_collector_state(state).static_revision
end

function collector.static_is_dirty(state)
  return ensure_collector_state(state).static_dirty
end

function collector.prepare_resync(state, expected_revision)
  local collector_state = ensure_collector_state(state)
  collector_state.static_revision = math.max(
    collector_state.static_revision,
    expected_revision
  )
  collector_state.static_dirty = true
end

local function surfaces_sorted()
  local surfaces = {}

  for _, surface in pairs(game.surfaces) do
    table.insert(surfaces, surface)
  end

  table.sort(surfaces, function(left, right)
    return left.index < right.index
  end)
  return surfaces
end

local function collect_flow_metrics(force, statistics_getter)
  local statistics_by_surface = {}
  local names = {}

  for _, surface in ipairs(surfaces_sorted()) do
    local statistics = statistics_getter(force, surface)
    table.insert(statistics_by_surface, statistics)

    for name in pairs(statistics.input_counts) do
      names[name] = true
    end
    for name in pairs(statistics.output_counts) do
      names[name] = true
    end
  end

  local metrics = {}

  for _, name in ipairs(sorted_keys(names)) do
    local metric = {
      id = name,
      produced_per_minute_1m = 0,
      consumed_per_minute_1m = 0,
      produced_per_minute_10m = 0,
      consumed_per_minute_10m = 0,
    }

    for _, statistics in ipairs(statistics_by_surface) do
      metric.produced_per_minute_1m =
        metric.produced_per_minute_1m
        + statistics.get_flow_count({
          name = name,
          category = "input",
          precision_index = ONE_MINUTE,
        })
      metric.consumed_per_minute_1m =
        metric.consumed_per_minute_1m
        + statistics.get_flow_count({
          name = name,
          category = "output",
          precision_index = ONE_MINUTE,
        })
      metric.produced_per_minute_10m =
        metric.produced_per_minute_10m
        + statistics.get_flow_count({
          name = name,
          category = "input",
          precision_index = TEN_MINUTES,
        })
      metric.consumed_per_minute_10m =
        metric.consumed_per_minute_10m
        + statistics.get_flow_count({
          name = name,
          category = "output",
          precision_index = TEN_MINUTES,
        })
    end

    metric.produced_per_minute_1m =
      rounded(metric.produced_per_minute_1m, 3)
    metric.consumed_per_minute_1m =
      rounded(metric.consumed_per_minute_1m, 3)
    metric.produced_per_minute_10m =
      rounded(metric.produced_per_minute_10m, 3)
    metric.consumed_per_minute_10m =
      rounded(metric.consumed_per_minute_10m, 3)

    local score = metric.produced_per_minute_1m
      + metric.consumed_per_minute_1m
      + metric.produced_per_minute_10m
      + metric.consumed_per_minute_10m

    table.insert(metrics, {
      metric = metric,
      score = score,
    })
  end

  table.sort(metrics, function(left, right)
    if left.score == right.score then
      return left.metric.id < right.metric.id
    end
    return left.score > right.score
  end)

  local omitted = math.max(0, #metrics - MAX_SERIES_PER_KIND)
  while #metrics > MAX_SERIES_PER_KIND do
    table.remove(metrics)
  end

  return metrics, omitted
end

local function item_statistics(force, surface)
  return force.get_item_production_statistics(surface)
end

local function fluid_statistics(force, surface)
  return force.get_fluid_production_statistics(surface)
end

local function total_electric_flow(statistics, category)
  local counts = category == "input"
      and statistics.input_counts
    or statistics.output_counts
  local total = 0

  for _, name in ipairs(sorted_keys(counts)) do
    total = total + statistics.get_flow_count({
      name = name,
      category = category,
      precision_index = ONE_MINUTE,
    })
  end

  return total
end

local function collect_power_summary(state, force)
  local collector_state = ensure_collector_state(state)
  local networks = {}
  local generated_per_tick = 0
  local consumed_per_tick = 0
  local network_count = 0

  for _, unit_number in ipairs(sorted_keys(collector_state.electric_poles)) do
    local entity = collector_state.electric_poles[unit_number]

    if not entity.valid then
      collector_state.electric_poles[unit_number] = nil
    elseif entity.force.index == force.index then
      local network_id = entity.electric_network_id

      if network_id ~= nil then
        local key = entity.surface.index .. ":" .. network_id

        if not networks[key] then
          networks[key] = true
          network_count = network_count + 1

          local statistics = entity.electric_network_statistics
          consumed_per_tick = consumed_per_tick
            + total_electric_flow(statistics, "input")
          generated_per_tick = generated_per_tick
            + total_electric_flow(statistics, "output")
        end
      end
    end
  end

  local generated_watts = generated_per_tick * 60
  local consumed_watts = consumed_per_tick * 60
  local satisfaction_ratio = 1

  if consumed_watts > 0 then
    satisfaction_ratio = math.min(1, generated_watts / consumed_watts)
  end

  return {
    network_count = network_count,
    generated_watts = rounded(generated_watts, 3),
    consumed_watts = rounded(consumed_watts, 3),
    satisfaction_ratio = rounded(satisfaction_ratio, 6),
  }
end

local function research_summary(force)
  if force.current_research == nil then
    return nil
  end

  return {
    technology_id = force.current_research.name,
    progress = rounded(force.research_progress, 6),
  }
end

local function dynamic_packet(state, sample_interval_ticks, forces, sequence)
  local collector_state = ensure_collector_state(state)
  -- Every chunk of one sample must share its sequence number, or the Companion
  -- cannot tell which datagrams belong together.
  if sequence == nil then
    collector_state.sample_sequence = collector_state.sample_sequence + 1
    sequence = collector_state.sample_sequence
  end

  return {
    protocol_version = 1,
    schema_version = STATE_SCHEMA_VERSION,
    message_id = next_message_id(state, "dynamic"),
    type = "dynamic_snapshot",
    tick = game.tick,
    payload = {
      sample_interval_ticks = sample_interval_ticks,
      sample_sequence = sequence,
      save_id = collector_state.save_id,
      truncated = false,
      omitted_forces = 0,
      omitted_series = 0,
      forces = forces,
    },
  }
end

function collector.build_dynamic_snapshot(state, sample_interval_ticks)
  local forces = playable_forces()
  local omitted_forces = math.max(0, #forces - MAX_DYNAMIC_FORCES)

  while #forces > MAX_DYNAMIC_FORCES do
    table.remove(forces)
  end

  local force_summaries = {}
  local summary_by_force = {}
  local candidates = {}
  local omitted_series = 0

  for _, force in ipairs(forces) do
    local summary = {
      id = force.name,
      research = research_summary(force),
      items = {},
      fluids = {},
      power = collect_power_summary(state, force),
    }
    local item_metrics, omitted_items =
      collect_flow_metrics(force, item_statistics)
    local fluid_metrics, omitted_fluids =
      collect_flow_metrics(force, fluid_statistics)

    omitted_series = omitted_series + omitted_items + omitted_fluids
    table.insert(force_summaries, summary)
    summary_by_force[force.name] = summary

    for _, candidate in ipairs(item_metrics) do
      candidate.force_id = force.name
      candidate.kind = "item"
      candidate.target = summary.items
      table.insert(candidates, candidate)
    end
    for _, candidate in ipairs(fluid_metrics) do
      candidate.force_id = force.name
      candidate.kind = "fluid"
      candidate.target = summary.fluids
      table.insert(candidates, candidate)
    end
  end

  table.sort(candidates, function(left, right)
    if left.score ~= right.score then
      return left.score > right.score
    end
    if left.force_id ~= right.force_id then
      return left.force_id < right.force_id
    end
    if left.kind ~= right.kind then
      return left.kind < right.kind
    end
    return left.metric.id < right.metric.id
  end)

  -- Flows that do not fit one datagram continue in the next chunk rather than
  -- being dropped, so a large factory still reports its full production.
  local chunks = {}
  local sample_sequence = ensure_collector_state(state).sample_sequence + 1
  ensure_collector_state(state).sample_sequence = sample_sequence
  local chunk_packet = dynamic_packet(
    state,
    sample_interval_ticks,
    force_summaries,
    sample_sequence
  )
  local pending = 0

  local function reset_flow_lists()
    for _, summary in ipairs(force_summaries) do
      summary.items = {}
      summary.fluids = {}
    end
    for _, candidate in ipairs(candidates) do
      local summary = summary_by_force[candidate.force_id]
      candidate.target = candidate.kind == "item" and summary.items
        or summary.fluids
    end
  end

  local function take_snapshot_of_lists()
    local copy = {}
    for _, summary in ipairs(force_summaries) do
      table.insert(copy, {
        id = summary.id,
        research = summary.research,
        power = summary.power,
        items = summary.items,
        fluids = summary.fluids,
      })
    end
    return copy
  end

  for _, candidate in ipairs(candidates) do
    table.insert(candidate.target, candidate.metric)

    if #helpers.table_to_json(chunk_packet) > PACKET_TARGET_BYTES then
      table.remove(candidate.target)

      if pending == 0 then
        -- A single flow that cannot fit even alone is unrepresentable.
        omitted_series = omitted_series + 1
      else
        table.insert(chunks, take_snapshot_of_lists())
        reset_flow_lists()
        pending = 0
        local retry_target = candidate.kind == "item"
            and summary_by_force[candidate.force_id].items
          or summary_by_force[candidate.force_id].fluids
        table.insert(retry_target, candidate.metric)
        if #helpers.table_to_json(chunk_packet) > PACKET_TARGET_BYTES then
          table.remove(retry_target)
          omitted_series = omitted_series + 1
        else
          pending = pending + 1
        end
      end
    else
      pending = pending + 1
    end
  end

  table.insert(chunks, take_snapshot_of_lists())

  local packets = {}
  local chunk_count = #chunks

  for index, chunk_forces in ipairs(chunks) do
    local packet = dynamic_packet(
      state,
      sample_interval_ticks,
      chunk_forces,
      sample_sequence
    )
    packet.payload.omitted_forces = omitted_forces
    packet.payload.omitted_series = omitted_series
    packet.payload.truncated = omitted_forces > 0 or omitted_series > 0
    if chunk_count > 1 then
      packet.payload.chunk_index = index - 1
      packet.payload.chunk_count = chunk_count
    end

    local encoded = helpers.table_to_json(packet)
    if #encoded > MAX_PACKET_BYTES then
      log(
        "[factorio-ai-assistant] Dynamic chunk exceeds hard limit; "
          .. "sample was not sent"
      )
      return nil
    end

    table.insert(packets, { encoded = encoded, packet = packet })
  end

  local first = packets[1]
  if first == nil then
    return nil
  end

  return {
    encoded = first.encoded,
    packet = first.packet,
    packets = packets,
  }
end

-- Entity types reported one by one: these are what a "why is this stalled"
-- question is actually about. Everything else is counted by type, because a
-- selection easily contains hundreds of belts whose individual positions add
-- nothing but bytes.
local DETAILED_ENTITY_TYPES = {
  ["assembling-machine"] = true,
  ["furnace"] = true,
  ["rocket-silo"] = true,
  ["mining-drill"] = true,
  ["lab"] = true,
  ["boiler"] = true,
  ["generator"] = true,
  ["reactor"] = true,
  ["offshore-pump"] = true,
  ["pump"] = true,
  ["container"] = true,
  ["logistic-container"] = true,
  ["storage-tank"] = true,
  ["beacon"] = true,
  -- Inserters are where "why is this machine not fed" is usually answered:
  -- they carry the only cheap source of who-feeds-whom in the selection.
  ["inserter"] = true,
}

local MAX_DETAILED_ENTITIES = 240
local MAX_ENTITY_GROUPS = 64
local MAX_CONTENT_ENTRIES = 8

--- Names of `defines.direction` values, so the model reads north, not 0.
local function direction_name(entity)
  local direction = entity.direction
  if direction == nil then
    return nil
  end
  for name, value in pairs(defines.direction) do
    if value == direction then
      return name
    end
  end
  return nil
end

--- Names of `defines.entity_status` values, resolved once per call.
local function status_name(entity)
  local status = entity.status
  if status == nil then
    return nil
  end
  for name, value in pairs(defines.entity_status) do
    if value == status then
      return name
    end
  end
  return nil
end

--- Reads an inventory into sorted `{name, count}` pairs, capped for size.
local function contents_pairs(inventories)
  local counts = {}
  local order = {}

  for _, inventory in ipairs(inventories) do
    if inventory ~= nil and inventory.valid then
      for _, stack in pairs(inventory.get_contents()) do
        local name = stack.name or stack[1]
        local count = stack.count or stack[2]
        if name ~= nil and count ~= nil then
          if counts[name] == nil then
            table.insert(order, name)
          end
          counts[name] = (counts[name] or 0) + count
        end
      end
    end
  end

  if #order == 0 then
    return nil
  end

  table.sort(order)
  local result = {}
  for _, name in ipairs(order) do
    if #result >= MAX_CONTENT_ENTRIES then
      break
    end
    table.insert(result, { name, counts[name] })
  end
  return result
end

local function module_pairs(entity)
  return contents_pairs({ entity.get_module_inventory() })
end

local function inventory_pairs(entity)
  local inventories = {}
  for _, index in ipairs({
    defines.inventory.chest,
    defines.inventory.furnace_source,
    defines.inventory.furnace_result,
    defines.inventory.assembling_machine_input,
    defines.inventory.assembling_machine_output,
  }) do
    if index ~= nil then
      table.insert(inventories, entity.get_inventory(index))
    end
  end
  return contents_pairs(inventories)
end

local function fluid_pairs(entity)
  local count = entity.fluids_count
  if count == nil or count == 0 then
    return nil
  end

  local result = {}
  for index = 1, math.min(count, MAX_CONTENT_ENTRIES) do
    local fluid = entity.get_fluid(index)
    if fluid ~= nil and fluid.amount ~= nil and fluid.amount > 0 then
      table.insert(result, { fluid.name, rounded(fluid.amount, 1) })
    end
  end
  return #result > 0 and result or nil
end

--- Identifies what an inserter takes from and gives to, when both are known.
-- This is the only adjacency the snapshot carries: without it the model can see
-- that a machine is starved but never which upstream entity starved it.
local function inserter_link(entity)
  if entity.type ~= "inserter" then
    return nil
  end

  local link
  local pickup_ok, pickup = pcall(function()
    return entity.pickup_target
  end)
  if pickup_ok and pickup ~= nil and pickup.valid then
    link = { from = pickup.unit_number, from_id = pickup.name }
  end

  local drop_ok, drop = pcall(function()
    return entity.drop_target
  end)
  if drop_ok and drop ~= nil and drop.valid then
    link = link or {}
    link.to = drop.unit_number
    link.to_id = drop.name
  end

  return link
end

local function describe_area_entity(entity)
  local descriptor = {
    id = entity.name,
    x = rounded(entity.position.x, 1),
    y = rounded(entity.position.y, 1),
  }

  -- A stable handle, so the model can point at one specific machine and so
  -- links below can reference an entity rather than repeat its position.
  if entity.unit_number ~= nil then
    descriptor.unit = entity.unit_number
  end

  local direction = direction_name(entity)
  if direction ~= nil then
    descriptor.facing = direction
  end

  local recipe_ok, recipe = pcall(function()
    return entity.get_recipe()
  end)
  if recipe_ok and recipe ~= nil then
    descriptor.recipe = recipe.name
  end

  local status = status_name(entity)
  if status ~= nil then
    descriptor.status = status
  end

  local link_ok, link = pcall(inserter_link, entity)
  if link_ok and link ~= nil then
    descriptor.link = link
  end

  local modules_ok, modules = pcall(module_pairs, entity)
  if modules_ok and modules ~= nil then
    descriptor.modules = modules
  end

  local contents_ok, contents = pcall(inventory_pairs, entity)
  if contents_ok and contents ~= nil then
    descriptor.contents = contents
  end

  local fluids_ok, fluids = pcall(fluid_pairs, entity)
  if fluids_ok and fluids ~= nil then
    descriptor.fluids = fluids
  end

  return descriptor
end

local function area_packet(state, force_id, selection_id, area, entities, groups)
  return {
    protocol_version = 1,
    schema_version = STATE_SCHEMA_VERSION,
    message_id = next_message_id(state, "area"),
    type = "area_snapshot",
    tick = game.tick,
    payload = {
      force_id = force_id,
      selection_id = selection_id,
      area = area,
      entities = entities,
      groups = groups,
      omitted_entities = 0,
      truncated = false,
    },
  }
end

--- Collects what the player selected. This is a bounded, player-initiated scan
--- over `event.entities`, not a map-wide sweep, so it never runs on a timer.
function collector.build_area_snapshot(state, force_id, selection_id, area, entities)
  local collector_state = ensure_collector_state(state)
  local detailed = {}
  local group_counts = {}
  local group_order = {}
  local omitted = 0

  for _, entity in pairs(entities) do
    if entity.valid then
      if DETAILED_ENTITY_TYPES[entity.type] then
        if #detailed < MAX_DETAILED_ENTITIES then
          table.insert(detailed, describe_area_entity(entity))
        else
          omitted = omitted + 1
        end
      else
        if group_counts[entity.name] == nil then
          if #group_order < MAX_ENTITY_GROUPS then
            table.insert(group_order, entity.name)
            group_counts[entity.name] = 0
          else
            omitted = omitted + 1
          end
        end
        if group_counts[entity.name] ~= nil then
          group_counts[entity.name] = group_counts[entity.name] + 1
        end
      end
    end
  end

  table.sort(detailed, function(left, right)
    if left.id ~= right.id then
      return left.id < right.id
    end
    if left.x ~= right.x then
      return left.x < right.x
    end
    return left.y < right.y
  end)
  table.sort(group_order)

  local groups = {}
  for _, name in ipairs(group_order) do
    table.insert(groups, { id = name, count = group_counts[name] })
  end

  -- Split across datagrams the same way dynamic samples do: detailed entities
  -- move to the next chunk instead of being dropped.
  local chunks = {}
  local current = {}
  local probe = area_packet(
    state,
    force_id,
    selection_id,
    area,
    current,
    groups
  )

  for _, descriptor in ipairs(detailed) do
    table.insert(current, descriptor)
    if #helpers.table_to_json(probe) > PACKET_TARGET_BYTES then
      table.remove(current)
      if #current == 0 then
        omitted = omitted + 1
      else
        table.insert(chunks, current)
        current = { descriptor }
        probe.payload.entities = current
        if #helpers.table_to_json(probe) > PACKET_TARGET_BYTES then
          current = {}
          probe.payload.entities = current
          omitted = omitted + 1
        end
      end
    end
  end
  table.insert(chunks, current)

  local packets = {}
  local chunk_count = #chunks

  for index, chunk_entities in ipairs(chunks) do
    local packet = area_packet(
      state,
      force_id,
      selection_id,
      area,
      chunk_entities,
      index == 1 and groups or {}
    )
    packet.payload.omitted_entities = omitted
    packet.payload.truncated = omitted > 0
    if chunk_count > 1 then
      packet.payload.chunk_index = index - 1
      packet.payload.chunk_count = chunk_count
    end

    local encoded = helpers.table_to_json(packet)
    if #encoded > MAX_PACKET_BYTES then
      log(
        "[factorio-ai-assistant] Area chunk exceeds hard limit; "
          .. "selection was not sent"
      )
      return nil
    end
    table.insert(packets, { encoded = encoded, packet = packet })
  end

  collector_state.last_selection_id = selection_id
  return { packets = packets, detailed_count = #detailed, omitted = omitted }
end

--- Ore patches the force has charted, aggregated so the model can answer
-- "where should I mine next" without ever seeing individual ore tiles.
--
-- Cost matters here: this runs on the game thread, and a mid-game map holds
-- tens of thousands of ore entities. So it only visits charted chunks, asks for
-- one entity per chunk per resource to learn what is there, and derives the
-- amount from that chunk's total rather than reading every tile.
local MAX_RESOURCE_CHUNKS = 2048
local MAX_RESOURCE_PATCHES = 40

--- Groups charted chunks into patches of the same resource.
local function collect_resource_patches(surface, force)
  local by_chunk = {}
  local visited = 0

  for chunk in surface.get_chunks() do
    if visited >= MAX_RESOURCE_CHUNKS then
      break
    end
    if force.is_chunk_charted(surface, chunk) then
      visited = visited + 1
      local resources = surface.find_entities_filtered({
        area = chunk.area,
        type = "resource",
      })
      if #resources > 0 then
        local totals = {}
        for _, resource in pairs(resources) do
          if resource.valid then
            local name = resource.name
            local entry = totals[name]
            if entry == nil then
              totals[name] = { amount = resource.amount, tiles = 1 }
            else
              entry.amount = entry.amount + resource.amount
              entry.tiles = entry.tiles + 1
            end
          end
        end
        for name, entry in pairs(totals) do
          by_chunk[name] = by_chunk[name] or {}
          table.insert(by_chunk[name], {
            x = chunk.x,
            y = chunk.y,
            amount = entry.amount,
            tiles = entry.tiles,
          })
        end
      end
    end
  end

  return by_chunk
end

--- Merges chunks of one resource that touch into a single patch.
local function merge_chunks_into_patches(chunks)
  local index = {}
  for _, chunk in ipairs(chunks) do
    index[chunk.x .. ":" .. chunk.y] = chunk
  end

  local seen = {}
  local patches = {}
  for _, chunk in ipairs(chunks) do
    local key = chunk.x .. ":" .. chunk.y
    if not seen[key] then
      -- Flood fill across the four neighbours, so one ore field is reported
      -- once rather than as a scatter of 32x32 squares.
      local queue = { chunk }
      seen[key] = true
      local amount = 0
      local tiles = 0
      local min_x, max_x = chunk.x, chunk.x
      local min_y, max_y = chunk.y, chunk.y

      while #queue > 0 do
        local current = table.remove(queue)
        amount = amount + current.amount
        tiles = tiles + current.tiles
        min_x = math.min(min_x, current.x)
        max_x = math.max(max_x, current.x)
        min_y = math.min(min_y, current.y)
        max_y = math.max(max_y, current.y)

        for _, offset in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
          local neighbour_key = (current.x + offset[1])
            .. ":"
            .. (current.y + offset[2])
          if index[neighbour_key] ~= nil and not seen[neighbour_key] then
            seen[neighbour_key] = true
            table.insert(queue, index[neighbour_key])
          end
        end
      end

      table.insert(patches, {
        -- Chunk coordinates are 32 tiles wide; report the centre in tiles so
        -- the model can hand the position straight to a map marker.
        x = rounded((min_x + max_x + 1) * 16, 1),
        y = rounded((min_y + max_y + 1) * 16, 1),
        amount = math.floor(amount),
        tiles = tiles,
      })
    end
  end

  return patches
end

function collector.build_resource_snapshot(state, force_id)
  local force = game.forces[force_id]
  local surface = game.surfaces[1]
  if force == nil or not force.valid or surface == nil then
    return nil
  end

  local by_chunk = collect_resource_patches(surface, force)
  local patches = {}
  for name, chunks in pairs(by_chunk) do
    for _, patch in ipairs(merge_chunks_into_patches(chunks)) do
      patch.id = name
      table.insert(patches, patch)
    end
  end

  -- Biggest first: a depleted corner of a patch is far less useful to know
  -- about than the field worth building an outpost on.
  table.sort(patches, function(left, right)
    if left.amount ~= right.amount then
      return left.amount > right.amount
    end
    return left.id < right.id
  end)

  local omitted = math.max(#patches - MAX_RESOURCE_PATCHES, 0)
  while #patches > MAX_RESOURCE_PATCHES do
    table.remove(patches)
  end

  return {
    protocol_version = 1,
    schema_version = STATE_SCHEMA_VERSION,
    message_id = next_message_id(state, "resource"),
    type = "resource_snapshot",
    tick = game.tick,
    payload = {
      force_id = force_id,
      patches = patches,
      omitted_patches = omitted,
      truncated = omitted > 0,
    },
  }
end

function collector.should_log_sample(state, packet)
  local collector_state = ensure_collector_state(state)
  local signature = packet.payload.omitted_forces
    .. ":"
    .. packet.payload.omitted_series
  local changed = signature ~= collector_state.last_sample_log_signature
  local periodic = packet.payload.sample_sequence % 12 == 0

  if changed then
    collector_state.last_sample_log_signature = signature
  end

  return changed or periodic
end

return collector
