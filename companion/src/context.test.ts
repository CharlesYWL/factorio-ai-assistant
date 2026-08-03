import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type AreaSnapshotPacket,
  type DynamicForceSummary,
  type HighlightMarker,
  type ResourceSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import { buildCompactContext } from "./context.js";
import { LocalizedNameStore } from "./localization.js";
import { executeRecipeTool } from "./recipe-tools.js";
import type { StaticState } from "./state-store.js";

void test("lists a named product and its chain in the catalog", () => {
  const context = buildCompactContext(
    "每分钟 10 个 utility-science-pack 要多少机器",
    { staticState: staticState(), dynamicForce: dynamicForce() },
    12_000,
  );

  const catalog = context.recipe_catalog as { recipes: Array<{ id: string }> };
  const ids = catalog.recipes.map((entry) => entry.id);
  // The model needs to see that these exist before it can look them up; the
  // ingredients themselves arrive through get_recipe.
  assert.ok(ids.includes("utility-science-pack"));
  assert.ok(ids.includes("processing-unit"));
  assert.ok(ids.includes("copper-cable"));
  assert.ok(ids.includes("copper-plate"));
});

void test("the catalog omits ingredients, which is where the saving comes from", () => {
  const context = buildCompactContext(
    "utility-science-pack 需要什么",
    { staticState: staticState() },
    12_000,
  );

  const encoded = JSON.stringify(context.recipe_catalog);
  // Ingredients made the old block ~87% of the whole budget.
  assert.ok(!encoded.includes('"i"'), "ingredients must not travel up front");
  assert.ok(!encoded.includes('"o"'), "products must not travel up front");
});

void test("get_recipe carries this save's recipe even when it differs from vanilla", async () => {
  // The player's mods can redefine a recipe, so the model must be given the
  // save's own ingredients rather than relying on what it remembers.
  const modded = staticState();
  const target = modded.recipes.find(
    ({ id }) => id === "utility-science-pack",
  );
  assert.ok(target !== undefined);
  target.ingredients = [{ kind: "item", id: "copper-cable", amount: 7 }];

  const result = await executeRecipeTool(
    "get_recipe",
    JSON.stringify({ ids: ["utility-science-pack"] }),
    { staticState: modded, names: new LocalizedNameStore() },
  ) as { recipes: Array<{ i: Array<[string, number]> }> };

  assert.deepEqual(result.recipes[0]?.i, [["copper-cable", 7]]);
});

void test("the catalog carries display names so nicknames can be mapped", () => {
  const names = new LocalizedNameStore();
  names.apply({
    protocol_version: 1,
    schema_version: 2,
    message_id: "locale-1",
    type: "localization_update",
    tick: 1,
    payload: {
      locale: "zh-CN",
      reset: true,
      names: [{ kind: "recipe", id: "utility-science-pack", name: "银金分析包" }],
    },
  });

  const context = buildCompactContext(
    "每分钟 10 个黄瓶要多少机器",
    { staticState: staticState(), names },
    48_000,
  );

  const catalog = context.recipe_catalog as {
    recipes: Array<{ id: string; name?: string }>;
  };
  const entry = catalog.recipes.find(
    ({ id }) => id === "utility-science-pack",
  );
  // The model maps 黄瓶 onto this save's wording itself, which is only possible
  // while the in-game name travels with the identifier.
  assert.equal(entry?.name, "银金分析包");
});

void test("search_recipes finds a recipe by its in-game name", async () => {
  const names = new LocalizedNameStore();
  names.apply({
    protocol_version: 1,
    schema_version: 2,
    message_id: "locale-2",
    type: "localization_update",
    tick: 1,
    payload: {
      locale: "zh-CN",
      reset: true,
      names: [{ kind: "recipe", id: "utility-science-pack", name: "银金分析包" }],
    },
  });

  const result = await executeRecipeTool(
    "search_recipes",
    JSON.stringify({ query: "分析包" }),
    { staticState: staticState(), names },
  ) as { matches: Array<{ id: string }> };

  assert.ok(result.matches.some(({ id }) => id === "utility-science-pack"));
});

void test("sends the whole craftable catalog regardless of wording", () => {
  // A player saying "黄瓶" in a save that calls it "银金分析包" matched no
  // product and used to get no recipes at all, leaving the model to guess from
  // vanilla. The catalog now travels regardless so the model can map the term.
  const context = buildCompactContext(
    "每分钟 10 个黄瓶要多少机器",
    { staticState: staticState(), dynamicForce: dynamicForce() },
    48_000,
  );

  const catalog = context.recipe_catalog as { recipes: Array<{ id: string }> };
  assert.ok(
    catalog.recipes.some((entry) => entry.id === "utility-science-pack"),
    "the catalog must travel even without a name match",
  );
});

void test("stays inside the byte budget by trimming, not by failing", () => {
  const context = buildCompactContext(
    "每分钟 10 个 utility-science-pack 要多少机器",
    {
      staticState: staticState(),
      dynamicForce: dynamicForce(),
      history: Array.from({ length: 4 }, (_, index) => ({
        question: `问题${index} ${"填充".repeat(50)}`,
        answer: `回答${index} ${"填充".repeat(50)}`,
      })),
    },
    1_500,
  );

  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 1_500);
  // The catalog is the one thing the model cannot supply itself, so it is the
  // last thing to be dropped.
  assert.ok("recipe_catalog" in context);
});

void test("keeps the newest turn when history must be trimmed", () => {
  const history = Array.from({ length: 4 }, (_, index) => ({
    question: `问题${index + 1} ${"填充".repeat(40)}`,
    answer: `回答${index + 1} ${"填充".repeat(40)}`,
  }));

  const roomy = buildCompactContext("那铜板呢", { history }, 12_000);
  assert.deepEqual(roomy.recent_turns, history);

  const tight = buildCompactContext("那铜板呢", { history }, 900);
  const kept = tight.recent_turns as typeof history | undefined;
  assert.ok(kept === undefined || kept.at(-1)?.question === history.at(-1)?.question);
  assert.ok(Buffer.byteLength(JSON.stringify(tight), "utf8") <= 900);
});

void test("omits turns entirely when the player has not opted in", () => {
  const context = buildCompactContext(
    "那铜板呢",
    { dynamicForce: dynamicForce() },
    12_000,
  );
  assert.equal("recent_turns" in context, false);
});

void test("reports whether the synchronized data was complete", () => {
  const truncated = { ...staticState(), truncated: true };
  const context = buildCompactContext("utility-science-pack", {
    staticState: truncated,
  }, 12_000);

  const quality = context.data_quality as Record<string, boolean>;
  assert.equal(quality.recipes_available, true);
  assert.equal(quality.recipes_truncated, true);
  assert.equal(quality.live_state_available, false);
});

void test("puts the selected area ahead of global flow data", () => {
  // A player who framed 48 furnaces is asking about those furnaces, so their
  // status must survive the budget even when live flows do not.
  const context = buildCompactContext(
    "为什么这些炉子带不动？",
    {
      staticState: staticState(),
      dynamicForce: dynamicForce(),
      areaSelection: areaSelection(),
    },
    48_000,
  );

  const selection = context.selected_area as {
    machines: Array<{ id: string; status?: string }>;
    other: Array<{ id: string; count: number }>;
    entity_count: number;
  };
  assert.equal(selection.entity_count, 2);
  assert.equal(selection.machines[0]?.status, "no_ingredients");
  assert.deepEqual(selection.other, [{ id: "transport-belt", count: 40 }]);
});

void test("sheds machine detail before dropping machines", () => {
  const context = buildCompactContext(
    "为什么这些炉子带不动？",
    { staticState: staticState(), areaSelection: areaSelection() },
    900,
  );

  const selection = context.selected_area as
    | { machines: Array<Record<string, unknown>> }
    | undefined;
  if (selection !== undefined) {
    // Losing inventory detail is acceptable; losing the machine itself hides
    // the thing the question is about.
    assert.ok(selection.machines.length > 0);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 900);
});

void test("marks only entities that exist in the selection", async () => {
  const markers: HighlightMarker[] = [];
  const result = await executeRecipeTool(
    "highlight_entities",
    JSON.stringify({
      markers: [
        { unit: 101, text: "缺铁矿", severity: "problem" },
        // A unit the model invented must not silently produce a marker
        // pointing at nothing.
        { unit: 999, text: "不存在", severity: "info" },
      ],
    }),
    {
      staticState: staticState(),
      names: new LocalizedNameStore(),
      areaSelection: areaSelection(),
      markers,
    },
  ) as { marked: number; skipped_units?: number[] };

  assert.equal(result.marked, 1);
  assert.deepEqual(result.skipped_units, [999]);
  assert.equal(markers.length, 1);
  // The recorded position lets the Mod draw even if the entity is gone by then.
  assert.deepEqual(
    { unit: markers[0]?.unit, x: markers[0]?.x, y: markers[0]?.y },
    { unit: 101, x: 4, y: 8 },
  );
});

void test("rejects a unit that is not in the selection", async () => {
  const markers: HighlightMarker[] = [];
  const result = await executeRecipeTool(
    "highlight_entities",
    JSON.stringify({
      markers: [{ unit: 101, text: "缺铁矿", severity: "problem" }],
    }),
    { staticState: staticState(), names: new LocalizedNameStore(), markers },
  ) as { error?: string };

  // Nothing is selected, so no unit can be verified; inventing one must not
  // produce a marker pointing at nothing.
  assert.ok(result.error !== undefined);
  assert.equal(markers.length, 0);
});

void test("marks a bare map position without any selection", async () => {
  const markers: HighlightMarker[] = [];
  const result = await executeRecipeTool(
    "highlight_entities",
    JSON.stringify({
      markers: [
        { x: -412.5, y: 88, text: "建议在此开矿", severity: "info" },
      ],
    }),
    { staticState: staticState(), names: new LocalizedNameStore(), markers },
  ) as { marked?: number };

  // "Build an outpost here" has no entity to reference, so a position-only
  // marker is the only way to express it.
  assert.equal(result.marked, 1);
  assert.deepEqual(markers[0], {
    x: -412.5,
    y: 88,
    text: "建议在此开矿",
    severity: "info",
  });
});

void test("a later highlight call replaces the earlier set", async () => {
  const markers: HighlightMarker[] = [];
  const context = {
    staticState: staticState(),
    names: new LocalizedNameStore(),
    areaSelection: areaSelection(),
    markers,
  };

  await executeRecipeTool(
    "highlight_entities",
    JSON.stringify({
      markers: [{ unit: 101, text: "第一次", severity: "info" }],
    }),
    context,
  );
  await executeRecipeTool(
    "highlight_entities",
    JSON.stringify({
      markers: [{ unit: 102, text: "改正后", severity: "problem" }],
    }),
    context,
  );

  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.text, "改正后");
});

void test("carries the handles needed to mark and trace machines", () => {
  const context = buildCompactContext(
    "为什么这些炉子不进料？",
    { staticState: staticState(), areaSelection: areaSelection() },
    48_000,
  );

  const selection = context.selected_area as {
    machines: Array<Record<string, unknown>>;
  };
  // Without `unit` the model cannot reference a specific machine, so
  // highlight_entities becomes unusable even though the tool is offered.
  assert.equal(selection.machines[0]?.unit, 101);
  assert.equal(selection.machines[1]?.unit, 102);
});

void test("carries inserter links so a starved machine has a traceable cause", () => {
  const selection = areaSelection();
  selection.payload.entities.push({
    id: "inserter",
    unit: 103,
    x: 5,
    y: 8,
    facing: "north",
    status: "waiting_for_source_items",
    link: { from: 101, from_id: "transport-belt", to: 102, to_id: "electric-furnace" },
  });

  const context = buildCompactContext(
    "为什么这些炉子不进料？",
    { staticState: staticState(), areaSelection: selection },
    48_000,
  );

  const compact = context.selected_area as {
    machines: Array<Record<string, unknown>>;
  };
  const inserter = compact.machines.find((machine) => machine.unit === 103);
  assert.deepEqual(inserter?.link, {
    from: 101,
    from_id: "transport-belt",
    to: 102,
    to_id: "electric-furnace",
  });
  assert.equal(inserter?.facing, "north");
});

void test("puts charted ore fields in reach of a map question", () => {
  const context = buildCompactContext(
    "我该去哪开矿",
    { staticState: staticState(), resources: resourceSnapshot() },
    48_000,
  );

  const patches = context.ore_patches as Array<Record<string, unknown>>;
  // Without these the model has no map at all and can only answer in
  // generalities about direction.
  assert.deepEqual(patches[0], {
    id: "iron-ore",
    at: [-416, 96],
    amount: 2_400_000,
    tiles: 850,
  });
});

void test("marks a proposed outpost at an ore field's position", async () => {
  const markers: HighlightMarker[] = [];
  const result = await executeRecipeTool(
    "highlight_entities",
    JSON.stringify({
      markers: [
        { x: -416, y: 96, text: "建议在此开铁矿", severity: "info" },
      ],
    }),
    { staticState: staticState(), names: new LocalizedNameStore(), markers },
  ) as { marked?: number };

  assert.equal(result.marked, 1);
  assert.equal(markers[0]?.x, -416);
});

void test("finds a production line by recipe anywhere on the map", async () => {
  // The Companion only knows what the Mod pushed, and that never includes
  // where a machine sits, so this has to leave the process.
  let asked: unknown;
  const result = (await executeRecipeTool(
    "find_machines",
    JSON.stringify({ recipe: "artillery-shell" }),
    {
      staticState: staticState(),
      names: new LocalizedNameStore(),
      forceId: "player",
      search: (forceId, filter) => {
        asked = { forceId, filter };
        return Promise.resolve({
          protocol_version: PROTOCOL_VERSION,
          schema_version: STATE_SCHEMA_VERSION,
          message_id: "factorio-search-1",
          type: "search_response" as const,
          timestamp: 1,
          payload: {
            reply_to: "req",
            clusters: [
              {
                x: 120,
                y: -64,
                count: 6,
                ids: ["assembling-machine-3"],
                statuses: ["working"],
                unit: 4242,
              },
            ],
            total_matches: 6,
            truncated: false,
          },
        });
      },
    },
  )) as { matches: number; lines: Array<Record<string, unknown>> };

  assert.deepEqual(asked, {
    forceId: "player",
    filter: { recipe: "artillery-shell" },
  });
  assert.equal(result.matches, 6);
  assert.deepEqual(result.lines[0]?.at, [120, -64]);
  // The unit travels so the answer can mark the line it just found.
  assert.equal(result.lines[0]?.unit, 4242);
});

void test("refuses an unfiltered scan", async () => {
  let called = false;
  const result = (await executeRecipeTool("find_machines", "{}", {
    staticState: staticState(),
    names: new LocalizedNameStore(),
    search: () => {
      called = true;
      return Promise.resolve(undefined);
    },
  })) as { error?: string };

  // An empty filter matches the whole factory, which is neither useful nor
  // cheap to scan.
  assert.match(result.error ?? "", /at least one filter/u);
  assert.equal(called, false);
});

void test("says so when the map scan cannot be answered", async () => {
  const result = (await executeRecipeTool(
    "find_machines",
    JSON.stringify({ recipe: "iron-plate" }),
    {
      staticState: staticState(),
      names: new LocalizedNameStore(),
      search: () => Promise.resolve(undefined),
    },
  )) as { error?: string };

  assert.match(result.error ?? "", /did not come back/u);
});

void test("reports an empty result rather than an error", async () => {
  const result = (await executeRecipeTool(
    "find_machines",
    JSON.stringify({ recipe: "artillery-shell" }),
    {
      staticState: staticState(),
      names: new LocalizedNameStore(),
      search: () =>
        Promise.resolve({
          protocol_version: PROTOCOL_VERSION,
          schema_version: STATE_SCHEMA_VERSION,
          message_id: "factorio-search-2",
          type: "search_response" as const,
          timestamp: 1,
          payload: {
            reply_to: "req",
            clusters: [],
            total_matches: 0,
            truncated: false,
          },
        }),
    },
  )) as { matches: number; hint?: string };

  // Nothing built yet is a real answer, not a failure the model should retry.
  assert.equal(result.matches, 0);
  assert.ok(result.hint !== undefined);
});

function resourceSnapshot(): ResourceSnapshotPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-resource-1",
    type: "resource_snapshot",
    tick: 500,
    payload: {
      force_id: "player",
      patches: [
        { id: "iron-ore", x: -416, y: 96, amount: 2_400_000, tiles: 850 },
        { id: "copper-ore", x: 320, y: -128, amount: 1_100_000, tiles: 400 },
      ],
      omitted_patches: 0,
      truncated: false,
    },
  };
}

function areaSelection(): AreaSnapshotPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-area-1",
    type: "area_snapshot",
    tick: 500,
    payload: {
      force_id: "player",
      selection_id: 1,
      area: { x1: 0, y1: 0, x2: 32, y2: 32 },
      entities: [
        {
          id: "electric-furnace",
          unit: 101,
          x: 4,
          y: 8,
          recipe: "iron-plate",
          status: "no_ingredients",
          contents: [["iron-ore", 3]],
        },
        {
          id: "electric-furnace",
          unit: 102,
          x: 6,
          y: 8,
          recipe: "iron-plate",
          status: "working",
          contents: [["iron-ore", 48]],
        },
      ],
      groups: [{ id: "transport-belt", count: 40 }],
      omitted_entities: 0,
      truncated: false,
    },
  };
}

function staticState(): StaticState {
  const recipe = (
    id: string,
    ingredients: Array<[string, number]>,
    amount = 1,
  ) => ({
    id,
    category: "crafting",
    energy_seconds: 1,
    ingredients: ingredients.map(([ingredientId, value]) => ({
      kind: "item" as const,
      id: ingredientId,
      amount: value,
    })),
    products: [{ kind: "item" as const, id, amount }],
    allowed_effects: [],
    allowed_module_categories: [],
    maximum_productivity: 4,
  });

  const recipes = [
    recipe("utility-science-pack", [["processing-unit", 2]], 3),
    recipe("processing-unit", [["copper-cable", 20], ["electronic-circuit", 20]]),
    recipe("electronic-circuit", [["copper-cable", 3], ["iron-plate", 1]]),
    recipe("copper-cable", [["copper-plate", 1]], 2),
    recipe("copper-plate", [["copper-ore", 1]]),
    recipe("iron-plate", [["iron-ore", 1]]),
    recipe("unrelated-item", [["iron-plate", 5]]),
  ];

  return {
    snapshotId: "static-test",
    revision: 1,
    truncated: false,
    omittedRecords: 0,
    game: { version: "2.0.72", mods: [{ id: "base", version: "2.0.72" }] },
    forces: [
      {
        id: "player",
        researched_technologies: ["automation"],
        available_recipes: recipes.map(({ id }) => id),
        recipe_productivity_bonuses: [],
      },
    ],
    recipes,
    machines: [
      {
        id: "assembling-machine-3",
        kind: "assembling-machine",
        crafting_speed: 1.25,
        crafting_categories: ["crafting"],
        module_slots: 4,
        allowed_effects: [],
        allowed_module_categories: [],
      },
    ],
    modules: [],
  };
}

function dynamicForce(): DynamicForceSummary {
  return {
    id: "player",
    research: { technology_id: "automation", progress: 0.5 },
    items: [
      {
        id: "copper-plate",
        produced_per_minute_1m: 100,
        consumed_per_minute_1m: 180,
        produced_per_minute_10m: 100,
        consumed_per_minute_10m: 180,
      },
    ],
    fluids: [],
    power: {
      network_count: 1,
      generated_watts: 42,
      consumed_watts: 100,
      satisfaction_ratio: 0.42,
    },
  };
}
