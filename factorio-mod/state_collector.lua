local collector = {}

local STATE_SCHEMA_VERSION = 1
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

  for name, technology in pairs(force.technologies) do
    if technology.researched then
      technologies[name] = true
    end
  end

  for name, recipe in pairs(force.recipes) do
    if recipe.enabled and not recipe.hidden then
      recipes[name] = true
    end
  end

  return {
    technologies = technologies,
    recipes = recipes,
  }
end

local function array_slice(values, first, last)
  local result = {}

  for index = first, math.min(last, #values) do
    table.insert(result, values[index])
  end

  return result
end

local function force_fragments(force, force_cache)
  local sets = collect_force_sets(force)
  force_cache[force.name] = sets

  local technologies = sorted_keys(sets.technologies)
  local recipes = sorted_keys(sets.recipes)
  local fragment_count = math.max(
    1,
    math.ceil(#technologies / MAX_FORCE_FRAGMENT_IDS),
    math.ceil(#recipes / MAX_FORCE_FRAGMENT_IDS)
  )
  local fragments = {}

  for fragment_index = 1, fragment_count do
    local first = (fragment_index - 1) * MAX_FORCE_FRAGMENT_IDS + 1
    local last = fragment_index * MAX_FORCE_FRAGMENT_IDS

    table.insert(fragments, {
      id = force.name,
      researched_technologies = array_slice(technologies, first, last),
      available_recipes = array_slice(recipes, first, last),
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
  }
end

local function chunk_has_records(chunk)
  return chunk.game ~= nil
    or #chunk.forces > 0
    or #chunk.recipes > 0
    or #chunk.machines > 0
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

local function dynamic_packet(state, sample_interval_ticks, forces)
  local collector_state = ensure_collector_state(state)
  collector_state.sample_sequence = collector_state.sample_sequence + 1

  return {
    protocol_version = 1,
    schema_version = STATE_SCHEMA_VERSION,
    message_id = next_message_id(state, "dynamic"),
    type = "dynamic_snapshot",
    tick = game.tick,
    payload = {
      sample_interval_ticks = sample_interval_ticks,
      sample_sequence = collector_state.sample_sequence,
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

  local packet = dynamic_packet(state, sample_interval_ticks, force_summaries)
  local accepted = {}

  for _, candidate in ipairs(candidates) do
    table.insert(candidate.target, candidate.metric)

    if #helpers.table_to_json(packet) > PACKET_TARGET_BYTES then
      table.remove(candidate.target)
      omitted_series = omitted_series + 1
    else
      table.insert(accepted, candidate)
    end
  end

  packet.payload.omitted_forces = omitted_forces
  packet.payload.omitted_series = omitted_series
  packet.payload.truncated = omitted_forces > 0 or omitted_series > 0

  local encoded = helpers.table_to_json(packet)

  while #encoded > MAX_PACKET_BYTES and #accepted > 0 do
    local candidate = table.remove(accepted)
    table.remove(candidate.target)
    omitted_series = omitted_series + 1
    packet.payload.omitted_series = omitted_series
    packet.payload.truncated = true
    encoded = helpers.table_to_json(packet)
  end

  if #encoded > MAX_PACKET_BYTES then
    log(
      "[factorio-ai-assistant] Dynamic packet base exceeds hard limit; "
        .. "sample was not sent"
    )
    return nil
  end

  return {
    encoded = encoded,
    packet = packet,
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
