import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type AreaSnapshotPacket,
  type DynamicForceSummary,
} from "@factorio-ai-assistant/protocol";

import { buildCompactContext } from "./context.js";
import { LocalizedNameStore } from "./localization.js";
import type { StaticState } from "./state-store.js";

void test("supplies the recipe chain for a product the question names", () => {
  const context = buildCompactContext(
    "每分钟 10 个 utility-science-pack 要多少机器",
    { staticState: staticState(), dynamicForce: dynamicForce() },
    12_000,
  );

  const recipes = context.recipes as { recipes: Array<{ r: [string, number, string] }> };
  const ids = recipes.recipes.map((entry) => entry.r[0]);
  // The named product plus everything upstream of it: without the chain the
  // model cannot work out the inputs a rate implies.
  assert.ok(ids.includes("utility-science-pack"));
  assert.ok(ids.includes("processing-unit"));
  assert.ok(ids.includes("copper-cable"));
  assert.ok(ids.includes("copper-plate"));
});

void test("carries this save's recipe even when it differs from vanilla", () => {
  // The player's mods can redefine a recipe, so the model must be given the
  // save's own ingredients rather than relying on what it remembers.
  const modded = staticState();
  const target = modded.recipes.find(
    ({ id }) => id === "utility-science-pack",
  );
  assert.ok(target !== undefined);
  target.ingredients = [{ kind: "item", id: "copper-cable", amount: 7 }];

  const context = buildCompactContext(
    "utility-science-pack 需要什么",
    { staticState: modded },
    12_000,
  );

  const recipes = context.recipes as {
    recipes: Array<{ r: [string, number, string]; i: Array<[string, number]> }>;
  };
  const carried = recipes.recipes.find(
    (entry) => entry.r[0] === "utility-science-pack",
  );
  assert.deepEqual(carried?.i, [["copper-cable", 7]]);
});

void test("ranks the named product's chain first", () => {
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
      names: [{ kind: "item", id: "utility-science-pack", name: "黄瓶" }],
    },
  });

  const context = buildCompactContext(
    "每分钟 10 个黄瓶要多少机器",
    { staticState: staticState(), names },
    48_000,
  );

  const recipes = context.recipes as { recipes: Array<{ r: [string, number, string] }> };
  const ids = recipes.recipes.map((entry) => entry.r[0]);
  // Relevance only decides ordering; if the budget ever bites, the chain the
  // question is about is what survives.
  assert.equal(ids[0], "utility-science-pack");
  assert.ok(ids.indexOf("processing-unit") < ids.indexOf("unrelated-item"));
});

void test("sends the catalog even when the wording matches nothing", () => {
  // A player saying "黄瓶" in a save that calls it "银金分析包" matched no
  // product and used to get no recipes at all, leaving the model to guess from
  // vanilla. The catalog now travels regardless so the model can map the term.
  const context = buildCompactContext(
    "每分钟 10 个黄瓶要多少机器",
    { staticState: staticState(), dynamicForce: dynamicForce() },
    48_000,
  );

  const recipes = context.recipes as { recipes: Array<{ r: [string, number, string] }> };
  assert.ok(
    recipes.recipes.some((entry) => entry.r[0] === "utility-science-pack"),
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
  // Recipes are the one thing the model cannot supply itself, so they are the
  // last thing to be dropped.
  assert.ok("recipes" in context);
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
          x: 4,
          y: 8,
          recipe: "iron-plate",
          status: "no_ingredients",
          contents: [["iron-ore", 3]],
        },
        {
          id: "electric-furnace",
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
