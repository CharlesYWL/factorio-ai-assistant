import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseProductionCatalog } from "@factorio-ai-assistant/calculator";
import {
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type StaticSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import {
  CalculationService,
  CalculationServiceError,
} from "./calculation-service.js";
import { CompanionStateStore } from "./state-store.js";

void test("calculates a structured summary from synchronized Factorio state", async () => {
  const store = await populatedStateStore();
  const service = new CalculationService(store);

  const result = service.calculate({
    force_id: "player",
    target_kind: "item",
    target_id: "automation-science-pack",
    rate_per_minute: 60,
    machine_id: "assembling-machine-2",
    module_ids: [],
  });

  assert.equal(result.target.id, "automation-science-pack");
  assert.equal(result.target.per_minute, 60);
  assert.ok(result.recipes.length > 0);
  const targetRecipe = result.recipes.find(
    ({ recipe_id }) => recipe_id === "automation-science-pack",
  );
  assert.equal(targetRecipe?.machine_id, "assembling-machine-2");
  assert.ok((targetRecipe?.machines_rounded_up ?? 0) > 0);
  assert.equal(result.truncated, false);
});

void test("reports unavailable state without returning a partial result", () => {
  const service = new CalculationService(new CompanionStateStore());

  assert.throws(
    () =>
      service.calculate({
        force_id: "player",
        target_kind: "item",
        target_id: "iron-plate",
        rate_per_minute: 60,
        module_ids: [],
      }),
    (error: unknown) =>
      error instanceof CalculationServiceError &&
      error.code === "STATE_UNAVAILABLE",
  );
});

async function populatedStateStore(): Promise<CompanionStateStore> {
  const encoded = await readFile(
    new URL(
      "../../packages/calculator/fixtures/vanilla-2.0.72-base.json",
      import.meta.url,
    ),
    "utf8",
  );
  const catalog = parseProductionCatalog(JSON.parse(encoded) as unknown);
  const packet: StaticSnapshotPacket = {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-calculator-state",
    type: "static_snapshot",
    tick: 60,
    payload: {
      snapshot_id: "calculator-state",
      revision: 1,
      chunk_index: 0,
      chunk_count: 1,
      truncated: false,
      omitted_records: 0,
      game: {
        version: "2.0.72",
        mods: [{ id: "base", version: "2.0.72" }],
      },
      forces: [
        {
          id: "player",
          researched_technologies: [],
          available_recipes: catalog.recipes.map(({ id }) => id),
          recipe_productivity_bonuses:
            catalog.recipe_productivity_bonuses ?? [],
        },
      ],
      recipes: catalog.recipes,
      machines: catalog.machines,
      modules: catalog.modules,
    },
  };
  const store = new CompanionStateStore();
  assert.equal(store.acceptStaticSnapshotChunk(packet), true);
  return store;
}
