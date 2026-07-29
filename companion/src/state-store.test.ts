import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  decodePacket,
  type AreaSnapshotPacket,
  type DynamicSnapshotPacket,
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

void test("publishes a chunked sample only once every chunk arrives", () => {
  const store = new CompanionStateStore();
  const chunks = chunkedSample(7, 2);
  const first = chunks[0]!;
  const second = chunks[1]!;

  store.acceptDynamicSnapshot(first);
  // A half-assembled sample would understate production, and there is no
  // retransmission to repair it, so nothing may be published yet.
  assert.ok(store.dynamicState === undefined);

  store.acceptDynamicSnapshot(second);
  assert.deepEqual(itemIdsOf(store), ["chunk-0-item", "chunk-1-item"]);
});

void test("reassembles chunks that arrive out of order", () => {
  const store = new CompanionStateStore();
  const chunks = chunkedSample(8, 2);
  const first = chunks[0]!;
  const second = chunks[1]!;

  store.acceptDynamicSnapshot(second);
  assert.ok(store.dynamicState === undefined);
  store.acceptDynamicSnapshot(first);

  assert.deepEqual(itemIdsOf(store), ["chunk-0-item", "chunk-1-item"]);
});

void test("drops an incomplete sample instead of mixing it with a newer one", () => {
  const store = new CompanionStateStore();
  const staleFirst = chunkedSample(9, 2)[0]!;
  const fresh = chunkedSample(10, 2);
  const freshFirst = fresh[0]!;
  const freshSecond = fresh[1]!;

  // A lost datagram must not leave flows from an older tick to be merged into
  // the next sample, which would report a state that never existed.
  store.acceptDynamicSnapshot(staleFirst);
  store.acceptDynamicSnapshot(freshFirst);
  store.acceptDynamicSnapshot(freshSecond);

  assert.equal(store.dynamicState?.payload.sample_sequence, 10);
  const items = itemIdsOf(store);
  assert.equal(items.length, 2);
});

void test("ignores a late chunk from a sample already superseded", () => {
  const store = new CompanionStateStore();
  const older = chunkedSample(11, 2);
  const oldFirst = older[0]!;
  const oldSecond = older[1]!;
  const newer = chunkedSample(12, 2);
  const newFirst = newer[0]!;
  const newSecond = newer[1]!;

  store.acceptDynamicSnapshot(newFirst);
  store.acceptDynamicSnapshot(newSecond);
  store.acceptDynamicSnapshot(oldFirst);
  store.acceptDynamicSnapshot(oldSecond);

  assert.equal(store.dynamicState?.payload.sample_sequence, 12);
});

void test("still accepts an unchunked sample from an older Mod", () => {
  const store = new CompanionStateStore();
  const packet = dynamicChunk(13, undefined, undefined, "solo-item");

  store.acceptDynamicSnapshot(packet);

  assert.equal(store.dynamicState?.payload.sample_sequence, 13);
  assert.equal(
    store.dynamicState?.payload.forces[0]?.items[0]?.id,
    "solo-item",
  );
});

void test("reassembles an area selection and keeps machine detail", () => {
  const store = new CompanionStateStore();
  const chunks = areaChunks(3, 2);

  store.acceptAreaSnapshot(chunks[0]!);
  // A partial selection would show fewer machines than the player framed.
  assert.equal(machineIdsOf(store).length, 0);

  store.acceptAreaSnapshot(chunks[1]!);
  assert.deepEqual(machineIdsOf(store), ["machine-0", "machine-1"]);
  assert.equal(
    store.areaSelection?.payload.entities[0]?.status,
    "no_ingredients",
  );
});

void test("ignores a late chunk from a superseded selection", () => {
  const store = new CompanionStateStore();
  const older = areaChunks(4, 2);
  const newer = areaChunks(5, 2);

  store.acceptAreaSnapshot(newer[0]!);
  store.acceptAreaSnapshot(newer[1]!);
  store.acceptAreaSnapshot(older[0]!);
  store.acceptAreaSnapshot(older[1]!);

  assert.equal(store.areaSelection?.payload.selection_id, 5);
});

function areaChunks(
  selectionId: number,
  count: number,
): AreaSnapshotPacket[] {
  return Array.from({ length: count }, (_, index) => ({
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: `factorio-area-${selectionId}-${index}`,
    type: "area_snapshot" as const,
    tick: 500,
    payload: {
      force_id: "player",
      selection_id: selectionId,
      area: { x1: 0, y1: 0, x2: 32, y2: 32 },
      entities: [
        {
          id: `machine-${index}`,
          x: index,
          y: 0,
          recipe: "iron-plate",
          status: "no_ingredients",
        },
      ],
      groups: index === 0 ? [{ id: "transport-belt", count: 40 }] : [],
      omitted_entities: 0,
      truncated: false,
      ...(count > 1 ? { chunk_index: index, chunk_count: count } : {}),
    },
  }));
}

function machineIdsOf(store: CompanionStateStore): string[] {
  return (store.areaSelection?.payload.entities ?? []).map(
    (entity) => entity.id,
  );
}

function itemIdsOf(store: CompanionStateStore): string[] {
  return (store.dynamicState?.payload.forces[0]?.items ?? []).map(
    (item) => item.id,
  );
}

function chunkedSample(
  sequence: number,
  count: number,
): DynamicSnapshotPacket[] {
  return Array.from({ length: count }, (_, index) =>
    dynamicChunk(sequence, index, count, `chunk-${index}-item`),
  );
}

function dynamicChunk(
  sequence: number,
  chunkIndex: number | undefined,
  chunkCount: number | undefined,
  itemId: string,
): DynamicSnapshotPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: `factorio-dynamic-${sequence}-${chunkIndex ?? 0}`,
    type: "dynamic_snapshot",
    tick: 100 + sequence,
    payload: {
      sample_interval_ticks: 300,
      sample_sequence: sequence,
      truncated: false,
      omitted_forces: 0,
      omitted_series: 0,
      ...(chunkIndex === undefined || chunkCount === undefined
        ? {}
        : { chunk_index: chunkIndex, chunk_count: chunkCount }),
      forces: [
        {
          id: "player",
          research: null,
          items: [
            {
              id: itemId,
              produced_per_minute_1m: 1,
              consumed_per_minute_1m: 0,
              produced_per_minute_10m: 1,
              consumed_per_minute_10m: 0,
            },
          ],
          fluids: [],
          power: {
            network_count: 1,
            generated_watts: 1,
            consumed_watts: 1,
            satisfaction_ratio: 1,
          },
        },
      ],
    },
  };
}

async function readStaticFixture(): Promise<StaticSnapshotPacket> {
  const encoded = await readFile(
    new URL("vanilla-2.0-static-v2.json", fixtureDirectory),
    "utf8",
  );
  const packet = decodePacket(encoded);
  assert.equal(packet.type, "static_snapshot");
  return packet;
}
