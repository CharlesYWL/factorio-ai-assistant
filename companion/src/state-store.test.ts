import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  decodePacket,
  type StaticDeltaPacket,
  type StaticSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import { CompanionStateStore, StateSyncError } from "./state-store.js";

const fixtureDirectory = new URL(
  "../../packages/protocol/fixtures/",
  import.meta.url,
);

void test("assembles out-of-order static chunks atomically", async () => {
  const fixture = await readStaticFixture();
  const [firstRecipe, ...remainingRecipes] = fixture.payload.recipes;
  assert.ok(firstRecipe !== undefined);

  const firstChunk: StaticSnapshotPacket = {
    ...fixture,
    message_id: "factorio-static-chunk-0",
    payload: {
      ...fixture.payload,
      chunk_index: 0,
      chunk_count: 2,
      recipes: [firstRecipe],
      machines: [],
      modules: [],
    },
  };
  const secondChunk: StaticSnapshotPacket = {
    ...fixture,
    message_id: "factorio-static-chunk-1",
    payload: {
      snapshot_id: fixture.payload.snapshot_id,
      revision: fixture.payload.revision,
      chunk_index: 1,
      chunk_count: 2,
      truncated: false,
      omitted_records: 0,
      forces: [],
      recipes: remainingRecipes,
      machines: fixture.payload.machines,
      modules: fixture.payload.modules,
    },
  };
  const store = new CompanionStateStore();

  assert.equal(store.acceptStaticSnapshotChunk(secondChunk), false);
  assert.equal(store.staticRevision, 0);
  assert.equal(store.acceptStaticSnapshotChunk(firstChunk), true);
  assert.equal(store.staticRevision, 1);
  assert.equal(store.staticState?.game.version, "2.0.72");
  assert.deepEqual(
    store.staticState?.recipes.map((recipe) => recipe.id),
    ["copper-cable", "iron-gear-wheel", "iron-plate"],
  );
  assert.deepEqual(
    store.staticState?.machines.map((machine) => machine.id),
    ["assembling-machine-1", "stone-furnace"],
  );
  assert.deepEqual(
    store.staticState?.modules.map((module) => module.id),
    ["productivity-module"],
  );
});

void test("applies static deltas idempotently and detects revision gaps", async () => {
  const store = new CompanionStateStore();
  const snapshot = await readStaticFixture();
  assert.equal(store.acceptStaticSnapshotChunk(snapshot), true);

  const delta: StaticDeltaPacket = {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-delta-1",
    type: "static_delta",
    tick: 4_200,
    payload: {
      base_revision: 1,
      revision: 2,
      force: {
        id: "player",
        researched_technologies_added: ["automation-2"],
        researched_technologies_removed: [],
        available_recipes_added: ["assembling-machine-2"],
        available_recipes_removed: ["iron-plate"],
        recipe_productivity_bonuses: [
          {
            recipe_id: "copper-cable",
            bonus: 0.2,
          },
        ],
      },
    },
  };

  store.acceptStaticDelta(delta);
  store.acceptStaticDelta(delta);
  assert.equal(store.staticRevision, 2);
  assert.deepEqual(store.staticState?.forces[0]?.researched_technologies, [
    "automation",
    "automation-2",
    "logistics",
  ]);
  assert.deepEqual(store.staticState?.forces[0]?.available_recipes, [
    "assembling-machine-2",
    "copper-cable",
    "iron-gear-wheel",
  ]);
  assert.deepEqual(store.staticState?.forces[0]?.recipe_productivity_bonuses, [
    {
      recipe_id: "copper-cable",
      bonus: 0.2,
    },
  ]);

  const skippedRevision: StaticDeltaPacket = {
    ...delta,
    message_id: "factorio-delta-3",
    payload: {
      ...delta.payload,
      base_revision: 3,
      revision: 4,
    },
  };

  assert.throws(
    () => store.acceptStaticDelta(skippedRevision),
    (error: unknown) => {
      assert.ok(error instanceof StateSyncError);
      assert.equal(error.code, "REVISION_MISMATCH");
      assert.equal(error.expectedRevision, 2);
      return true;
    },
  );
});

void test("retains the latest validated dynamic snapshot", async () => {
  const encoded = await readFile(
    new URL("vanilla-2.0-dynamic-v2.json", fixtureDirectory),
    "utf8",
  );
  const packet = decodePacket(encoded);
  assert.equal(packet.type, "dynamic_snapshot");

  const store = new CompanionStateStore();
  store.acceptDynamicSnapshot(packet);

  assert.equal(store.dynamicState?.tick, 3_900);
  assert.equal(store.dynamicState?.payload.forces[0]?.items[0]?.id, "iron-plate");
});

async function readStaticFixture(): Promise<StaticSnapshotPacket> {
  const encoded = await readFile(
    new URL("vanilla-2.0-static-v2.json", fixtureDirectory),
    "utf8",
  );
  const packet = decodePacket(encoded);
  assert.equal(packet.type, "static_snapshot");
  return packet;
}
