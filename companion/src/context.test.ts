import assert from "node:assert/strict";
import test from "node:test";

import type { ProductionResult } from "@factorio-ai-assistant/calculator";
import type { DynamicForceSummary } from "@factorio-ai-assistant/protocol";

import type { AssistantToolModelContext } from "./assistant-tools.js";
import { buildCompactContext } from "./context.js";
import type { StaticState } from "./state-store.js";

void test("keeps technology context inside the configured UTF-8 byte budget", () => {
  const staticState: StaticState = {
    snapshotId: "static-test",
    revision: 1,
    truncated: false,
    omittedRecords: 0,
    game: { version: "2.0.72", mods: [{ id: "base", version: "2.0.72" }] },
    forces: [
      {
        id: "player",
        researched_technologies: Array.from(
          { length: 200 },
          (_, index) => `technology-${String(index).padStart(3, "0")}`,
        ),
        available_recipes: Array.from(
          { length: 200 },
          (_, index) => `recipe-${index}`,
        ),
        recipe_productivity_bonuses: [],
      },
    ],
    recipes: [],
    machines: [],
    modules: [],
  };
  const context = buildCompactContext(
    "What technology should I research next?",
    { staticState, dynamicForce: dynamicForce() },
    1_024,
  );

  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 1_024);
  assert.equal(context.researched_technology_count, 200);
  assert.ok(Array.isArray(context.researched_technologies));
  assert.equal("available_recipes" in context, false);
  assert.equal("recipes" in context, false);
  assert.equal("machines" in context, false);
});

void test("prioritizes relevant deficits without sending the full dynamic state", () => {
  const force = dynamicForce();
  force.items.push(
    {
      id: "iron-plate",
      produced_per_minute_1m: 50,
      consumed_per_minute_1m: 100,
      produced_per_minute_10m: 60,
      consumed_per_minute_10m: 120,
    },
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `item-${index}`,
      produced_per_minute_1m: index,
      consumed_per_minute_1m: index,
      produced_per_minute_10m: index,
      consumed_per_minute_10m: index,
    })),
  );

  const context = buildCompactContext(
    "Why is iron-plate production short?",
    { dynamicForce: force },
    2_048,
  );
  const production = context.production as Array<Record<string, unknown>>;

  assert.equal(production[0]?.id, "iron-plate");
  assert.ok(production.length < force.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 2_048);
});

void test("marks deterministic calculation fields as authoritative compact context", () => {
  const context = buildCompactContext(
    "How many machines?",
    { calculation: productionResult() },
    4_096,
  );
  const calculation = context.deterministic_calculation as Record<
    string,
    unknown
  >;
  const recipes = calculation.recipes as Array<Record<string, unknown>>;

  assert.deepEqual(calculation.targets, [
    { kind: "item", id: "chemical-science-pack", per_minute: 45 },
  ]);
  assert.equal(recipes[0]?.machine_count_exact, 3.5);
  assert.equal(recipes[0]?.machine_count_rounded_up, 4);
  assert.equal("flows" in calculation, false);
});

void test("keeps deterministic tool results inside the minimum context budget", () => {
  const toolContext: AssistantToolModelContext = {
    contract_version: 1,
    policy: "read-only",
    intent: "bottlenecks",
    calls: [
      {
        id: "tool-1",
        name: "read_advisor_alerts",
        status: "ok",
        arguments: { force_id: "player", limit: 3 },
        output: {
          alerts: Array.from({ length: 3 }, (_, index) => ({
            evidence_id: `A${index + 1}`,
            evidence: "long deterministic evidence ".repeat(20),
          })),
        },
      },
    ],
    evidence: Array.from({ length: 3 }, (_, index) => ({
      id: `A${index + 1}`,
      category: "fact",
      text: "long deterministic evidence ".repeat(20),
    })),
    assumptions: ["bounded deterministic rules"],
    missing_data: [],
  };
  const context = buildCompactContext(
    "What are the top 3 bottlenecks?",
    { dynamicForce: dynamicForce(), toolContext },
    1_024,
  );

  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 1_024);
  assert.ok("deterministic_tools" in context);
});

function dynamicForce(): DynamicForceSummary {
  return {
    id: "player",
    research: {
      technology_id: "advanced-oil-processing",
      progress: 0.5,
    },
    items: [],
    fluids: [],
    power: {
      network_count: 1,
      generated_watts: 42,
      consumed_watts: 100,
      satisfaction_ratio: 0.42,
    },
  };
}

function productionResult(): ProductionResult {
  return {
    targets: [
      {
        kind: "item",
        id: "chemical-science-pack",
        per_second: 0.75,
        per_minute: 45,
        per_second_fraction: "3/4",
      },
    ],
    recipes: [
      {
        recipe_id: "chemical-science-pack",
        category: "crafting",
        machine_id: "assembling-machine-2",
        machine_crafting_speed: 0.75,
        effective_crafting_speed: 0.75,
        module_ids: [],
        module_speed_bonus: 0,
        module_productivity_bonus: 0,
        technology_productivity_bonus: 0,
        effective_productivity_bonus: 0,
        crafts: {
          per_second: 0.5,
          per_minute: 30,
          per_second_fraction: "1/2",
        },
        machines: {
          exact: 3.5,
          exact_fraction: "7/2",
          rounded_up: 4,
        },
        ingredients: [],
        products: [],
      },
    ],
    external_inputs: [],
    byproducts: [],
    fluid_rates: [],
    item_bandwidth: [],
    flows: [],
    assumptions: {
      byproduct_policy: "surplus",
      rounding: "Exact counts are shown with a rounded-up build count.",
      source_resources: [],
      belt_speeds: {},
      recipe_selections: {},
      machine_selections: {},
      module_loadouts: {},
      technology_productivity_bonuses: {},
    },
  };
}
