import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import type { RecipeDescriptor } from "@factorio-ai-assistant/protocol";

import {
  ProductionError,
  calculateProduction,
  parseProductionCatalog,
  type ProductionCatalog,
  type ProductionResult,
} from "./index.js";

const execFileAsync = promisify(execFile);
const fixtureDirectory = new URL("../fixtures/", import.meta.url);

void test("matches the vanilla 2.0 science assembler ratio exactly", async () => {
  const catalog = await readVanillaCatalog();
  const cases = [
    ["automation-science-pack", 5, []],
    ["logistic-science-pack", 6, []],
    ["chemical-science-pack", 12, ["fluid:petroleum-gas", "fluid:water"]],
    ["production-science-pack", 7, ["fluid:petroleum-gas"]],
    [
      "utility-science-pack",
      7,
      ["fluid:heavy-oil", "fluid:petroleum-gas", "fluid:water"],
    ],
  ] as const;

  for (const [targetId, expectedMachines, sourceResources] of cases) {
    const result = calculateProduction(catalog, {
      targets: [{ kind: "item", id: targetId, rate: 75, unit: "minute" }],
      source_resources: [...sourceResources],
    });
    const targetStep = requireRecipe(result, targetId);
    assert.equal(targetStep.machines.exact, expectedMachines, targetId);
    assert.equal(targetStep.machine_id, "assembling-machine-3");
    assert.deepEqual(targetStep.module_ids, []);
    assert.equal(targetStep.technology_productivity_bonus, 0);
  }
});

void test("expands red science to exact raw rates and belt requirements", async () => {
  const result = calculateProduction(await readVanillaCatalog(), {
    targets: [
      { kind: "item", id: "automation-science-pack", rate: 75, unit: "minute" },
    ],
  });

  assert.equal(requireInput(result, "copper-ore").per_minute, 75);
  assert.equal(requireInput(result, "iron-ore").per_minute, 150);
  assert.equal(requireRecipe(result, "automation-science-pack").machines.exact, 5);
  assert.equal(
    result.item_bandwidth.find((flow) => flow.id === "iron-ore")?.belts.find(
      (belt) => belt.belt_id === "transport-belt",
    )?.exact,
    1 / 6,
  );
  assert.equal(
    result.item_bandwidth.find((flow) => flow.id === "iron-ore")?.belts.find(
      (belt) => belt.belt_id === "transport-belt",
    )?.rounded_up,
    1,
  );
});

void test("reports exact processing-unit, structure, and rocket-fuel layers", async () => {
  const catalog = await readVanillaCatalog();
  const processing = calculateProduction(catalog, {
    targets: [{ kind: "item", id: "processing-unit", rate: 60, unit: "minute" }],
    source_resources: [
      "item:electronic-circuit",
      "item:advanced-circuit",
      "fluid:sulfuric-acid",
    ],
  });
  const processingStep = requireRecipe(processing, "processing-unit");
  assert.equal(processingStep.machines.exact, 8);
  assert.equal(requireRate(processingStep.ingredients, "electronic-circuit"), 1_200);
  assert.equal(requireRate(processingStep.ingredients, "advanced-circuit"), 120);
  assert.equal(requireRate(processingStep.ingredients, "sulfuric-acid"), 300);

  const structures = calculateProduction(catalog, {
    targets: [
      { kind: "item", id: "low-density-structure", rate: 60, unit: "minute" },
    ],
    source_resources: [
      "item:steel-plate",
      "item:copper-plate",
      "item:plastic-bar",
    ],
  });
  const structureStep = requireRecipe(structures, "low-density-structure");
  assert.equal(structureStep.machines.exact, 12);
  assert.equal(requireRate(structureStep.ingredients, "steel-plate"), 120);
  assert.equal(requireRate(structureStep.ingredients, "copper-plate"), 1_200);
  assert.equal(requireRate(structureStep.ingredients, "plastic-bar"), 300);

  const rocketFuel = calculateProduction(catalog, {
    targets: [{ kind: "item", id: "rocket-fuel", rate: 60, unit: "minute" }],
    source_resources: ["fluid:light-oil"],
  });
  const rocketFuelStep = requireRecipe(rocketFuel, "rocket-fuel");
  assert.equal(rocketFuelStep.machines.exact, 12);
  assert.equal(requireRate(rocketFuelStep.ingredients, "solid-fuel"), 600);
  assert.equal(requireRate(rocketFuelStep.ingredients, "light-oil"), 600);
  assert.equal(
    rocketFuel.external_inputs.find((input) => input.id === "light-oil")
      ?.per_minute,
    6_600,
  );
});

void test("balances advanced oil and both cracking recipes without surplus", async () => {
  const result = calculateProduction(await readVanillaCatalog(), {
    targets: [
      { kind: "fluid", id: "petroleum-gas", rate: 19.5, unit: "second" },
    ],
    recipe_choices: {
      "fluid:petroleum-gas": "advanced-oil-processing",
    },
    byproduct_handlers: {
      "fluid:heavy-oil": "heavy-oil-cracking",
      "fluid:light-oil": "light-oil-cracking",
    },
    byproduct_policy: "balanced",
  });

  assert.equal(requireRecipe(result, "advanced-oil-processing").machines.exact, 1);
  assert.equal(requireRecipe(result, "heavy-oil-cracking").machines.exact, 0.25);
  assert.equal(requireRecipe(result, "light-oil-cracking").machines.exact, 0.85);
  assert.equal(
    result.external_inputs.find((input) => input.id === "crude-oil")?.per_second,
    20,
  );
  assert.equal(
    result.external_inputs.find((input) => input.id === "water")?.per_second,
    26.5,
  );
  assert.deepEqual(result.byproducts, []);
});

void test("applies module speed, module productivity, and technology bonuses", async () => {
  const catalog = await readVanillaCatalog();
  const productivity = calculateProduction(catalog, {
    targets: [{ kind: "item", id: "processing-unit", rate: 1 }],
    source_resources: [
      "item:electronic-circuit",
      "item:advanced-circuit",
      "fluid:sulfuric-acid",
    ],
    module_loadouts: {
      "processing-unit": [
        "productivity-module-3",
        "productivity-module-3",
        "productivity-module-3",
        "productivity-module-3",
      ],
    },
    technology_productivity_bonuses: {
      "processing-unit": 0.2,
    },
  });
  const productivityStep = requireRecipe(productivity, "processing-unit");
  assert.equal(productivityStep.module_speed_bonus, -0.6);
  assert.equal(productivityStep.module_productivity_bonus, 0.4);
  assert.equal(productivityStep.technology_productivity_bonus, 0.2);
  assert.equal(productivityStep.effective_productivity_bonus, 0.6);
  assert.equal(productivityStep.machines.exact, 12.5);
  assert.equal(productivityStep.machines.exact_fraction, "25/2");

  const speed = calculateProduction(catalog, {
    targets: [{ kind: "item", id: "processing-unit", rate: 1 }],
    source_resources: [
      "item:electronic-circuit",
      "item:advanced-circuit",
      "fluid:sulfuric-acid",
    ],
    module_loadouts: {
      "processing-unit": [
        "speed-module-3",
        "speed-module-3",
        "speed-module-3",
        "speed-module-3",
      ],
    },
  });
  assert.equal(requireRecipe(speed, "processing-unit").machines.exact_fraction, "8/3");
});

void test("does not apply productivity to catalyst quantities marked ignored", () => {
  const catalog = syntheticCatalog([
    recipe(
      "catalytic-output",
      [{ kind: "item", id: "catalyst", amount: 10 }],
      [
        {
          kind: "item",
          id: "catalyst",
          amount: 10,
          ignored_by_productivity: 10,
        },
        { kind: "item", id: "output", amount: 1 },
      ],
    ),
  ]);
  const result = calculateProduction(catalog, {
    targets: [{ kind: "item", id: "output", rate: 2 }],
    technology_productivity_bonuses: { "catalytic-output": 1 },
  });

  assert.equal(requireRecipe(result, "catalytic-output").crafts.per_second, 1);
  assert.equal(
    result.flows.find((flow) => flow.id === "catalyst")?.net_per_second,
    0,
  );
});

void test("requires explicit alternatives and honors the selected recipe", async () => {
  const base = await readVanillaCatalog();
  const ironPlate = base.recipes.find((entry) => entry.id === "iron-plate");
  assert.ok(ironPlate !== undefined);
  const catalog: ProductionCatalog = {
    ...base,
    recipes: [...base.recipes, { ...ironPlate, id: "iron-plate-alternative" }],
  };

  expectProductionError(
    () =>
      calculateProduction(catalog, {
        targets: [{ kind: "item", id: "iron-plate", rate: 1 }],
      }),
    "AMBIGUOUS_RECIPE",
  );

  const result = calculateProduction(catalog, {
    targets: [{ kind: "item", id: "iron-plate", rate: 1 }],
    recipe_choices: { "item:iron-plate": "iron-plate-alternative" },
  });
  assert.ok(result.recipes.some((entry) => entry.recipe_id === "iron-plate-alternative"));
});

void test("ignores zero-probability producers and clamps negative force bonuses", () => {
  const catalog = syntheticCatalog([
    recipe(
      "zero-output",
      [],
      [{ kind: "item", id: "output", amount: 0 }],
    ),
    recipe(
      "real-output",
      [],
      [{ kind: "item", id: "output", amount: 1 }],
    ),
  ]);
  const result = calculateProduction(catalog, {
    targets: [{ kind: "item", id: "output", rate: 1 }],
    technology_productivity_bonuses: { "real-output": -0.5 },
  });

  assert.deepEqual(
    result.recipes.map((entry) => entry.recipe_id),
    ["real-output"],
  );
  assert.equal(requireRecipe(result, "real-output").crafts.per_second, 1);
  assert.equal(
    requireRecipe(result, "real-output").effective_productivity_bonus,
    0,
  );
});

void test("reports cycles, unreachable targets, machines, modules, and byproducts", async () => {
  const cycleCatalog = syntheticCatalog([
    recipe(
      "make-a",
      [{ kind: "item", id: "b", amount: 1 }],
      [{ kind: "item", id: "a", amount: 1 }],
    ),
    recipe(
      "make-b",
      [{ kind: "item", id: "a", amount: 1 }],
      [{ kind: "item", id: "b", amount: 1 }],
    ),
  ]);
  expectProductionError(
    () =>
      calculateProduction(cycleCatalog, {
        targets: [{ kind: "item", id: "a", rate: 1 }],
      }),
    "CYCLIC_RECIPE_GRAPH",
  );
  expectProductionError(
    () =>
      calculateProduction(cycleCatalog, {
        targets: [{ kind: "item", id: "missing", rate: 1 }],
      }),
    "TARGET_UNREACHABLE",
  );

  const vanilla = await readVanillaCatalog();
  expectProductionError(
    () =>
      calculateProduction(vanilla, {
        targets: [{ kind: "item", id: "sulfur", rate: 1 }],
        allowed_machine_ids: ["assembling-machine-3"],
        source_resources: ["fluid:petroleum-gas", "fluid:water"],
      }),
    "NO_COMPATIBLE_MACHINE",
  );
  expectProductionError(
    () =>
      calculateProduction(vanilla, {
        targets: [{ kind: "item", id: "transport-belt", rate: 1 }],
        module_loadouts: {
          "transport-belt": ["productivity-module-3"],
        },
      }),
    "MODULE_NOT_ALLOWED",
  );
  expectProductionError(
    () =>
      calculateProduction(vanilla, {
        targets: [{ kind: "fluid", id: "petroleum-gas", rate: 11 }],
        recipe_choices: {
          "fluid:petroleum-gas": "advanced-oil-processing",
        },
        byproduct_policy: "balanced",
      }),
    "UNHANDLED_BYPRODUCT",
  );
  expectProductionError(
    () =>
      calculateProduction(vanilla, {
        targets: [{ kind: "fluid", id: "petroleum-gas", rate: 11 }],
        recipe_choices: {
          "fluid:petroleum-gas": "advanced-oil-processing",
        },
        byproduct_handlers: {
          "fluid:petroleum-gas": "light-oil-cracking",
        },
      }),
    "INVALID_INPUT",
  );
});

void test("runs through the JSON CLI without model dependencies", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    new URL("./cli.js", import.meta.url).pathname,
    "--catalog",
    new URL("vanilla-2.0.72-base.json", fixtureDirectory).pathname,
    "--request",
    new URL("chemical-science-120-per-minute.json", fixtureDirectory).pathname,
  ]);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as { recipes?: Array<{ recipe_id?: string }> };
  assert.ok(
    parsed.recipes?.some((entry) => entry.recipe_id === "chemical-science-pack"),
  );
});

async function readVanillaCatalog(): Promise<ProductionCatalog> {
  const encoded = await readFile(
    new URL("vanilla-2.0.72-base.json", fixtureDirectory),
    "utf8",
  );
  return parseProductionCatalog(JSON.parse(encoded) as unknown);
}

function requireRecipe(result: ProductionResult, recipeId: string) {
  const entry = result.recipes.find((recipeEntry) => recipeEntry.recipe_id === recipeId);
  assert.ok(entry !== undefined, `Missing recipe ${recipeId}`);
  return entry;
}

function requireInput(result: ProductionResult, id: string) {
  const entry = result.external_inputs.find((input) => input.id === id);
  assert.ok(entry !== undefined, `Missing external input ${id}`);
  return entry;
}

function requireRate(
  rates: Array<{ id: string; per_minute: number }>,
  id: string,
): number {
  const entry = rates.find((rate) => rate.id === id);
  assert.ok(entry !== undefined, `Missing rate ${id}`);
  return entry.per_minute;
}

function expectProductionError(
  action: () => unknown,
  code: ProductionError["code"],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProductionError);
    assert.equal(error.code, code);
    return true;
  });
}

function syntheticCatalog(recipes: RecipeDescriptor[]): ProductionCatalog {
  return {
    recipes,
    machines: [
      {
        id: "test-machine",
        kind: "assembling-machine",
        crafting_speed: 1,
        crafting_categories: ["crafting"],
        module_slots: 0,
        allowed_effects: [],
        allowed_module_categories: [],
      },
    ],
    modules: [],
  };
}

function recipe(
  id: string,
  ingredients: RecipeDescriptor["ingredients"],
  products: RecipeDescriptor["products"],
): RecipeDescriptor {
  return {
    id,
    category: "crafting",
    energy_seconds: 1,
    ingredients,
    products,
    allowed_effects: [],
    allowed_module_categories: [],
    maximum_productivity: 3,
  };
}
