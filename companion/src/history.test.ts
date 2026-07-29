import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type DynamicSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import { ProductionHistory, summarizeTrend } from "./history.js";

const TICKS_PER_MINUTE = 3_600;

void test("keeps one point per game minute, not one per sample", async () => {
  await withHistory(async (history) => {
    // Samples arrive every 5 seconds; storing them all would cost roughly
    // 1.4 GB per 100 hours and tells us nothing extra about trends.
    assert.equal(await history.record(sample({ tick: 0, iron: 100 })), true);
    assert.equal(await history.record(sample({ tick: 300, iron: 100 })), false);
    assert.equal(await history.record(sample({ tick: 1_800, iron: 100 })), false);
    assert.equal(
      await history.record(sample({ tick: TICKS_PER_MINUTE, iron: 100 })),
      true,
    );

    assert.deepEqual(
      history.points.map((point) => point.t),
      [0, TICKS_PER_MINUTE],
    );
  });
});

void test("discards history after the tick a reload rewound to", async () => {
  await withHistory(async (history) => {
    for (let minute = 0; minute <= 5; minute += 1) {
      await history.record(
        sample({ tick: minute * TICKS_PER_MINUTE, iron: 100 }),
      );
    }
    assert.equal(history.points.length, 6);

    // Loading an earlier save makes the clock go backwards. Everything after
    // that tick describes a future that no longer happened.
    await history.record(
      sample({ tick: 2 * TICKS_PER_MINUTE + 60, iron: 50 }),
    );

    const ticks = history.points.map((point) => point.t);
    assert.deepEqual(ticks.slice(0, 3), [0, TICKS_PER_MINUTE, 2 * TICKS_PER_MINUTE]);
    assert.ok(ticks.every((tick) => tick <= 2 * TICKS_PER_MINUTE + 60));
  });
});

void test("keeps each save on its own timeline", async () => {
  await withHistory(async (history, directory) => {
    await history.record(sample({ tick: 0, iron: 100, saveId: "save-a" }));
    await history.record(
      sample({ tick: TICKS_PER_MINUTE, iron: 100, saveId: "save-a" }),
    );
    assert.equal(history.points.length, 2);

    // Switching saves must not append onto the previous save's history.
    await history.record(sample({ tick: 0, iron: 7, saveId: "save-b" }));
    assert.equal(history.points.length, 1);
    assert.equal(history.saveId, "save-b");

    // Returning to the first save restores its points from disk.
    const reopened = new ProductionHistory({ directory });
    await reopened.record(
      sample({ tick: 10 * TICKS_PER_MINUTE, iron: 100, saveId: "save-a" }),
    );
    assert.equal(reopened.points.length, 3);
  });
});

void test("survives a restart by reloading what was written", async () => {
  await withHistory(async (history, directory) => {
    for (let minute = 0; minute < 3; minute += 1) {
      await history.record(
        sample({ tick: minute * TICKS_PER_MINUTE, iron: 100 }),
      );
    }

    const restarted = new ProductionHistory({ directory });
    await restarted.record(sample({ tick: 3 * TICKS_PER_MINUTE, iron: 90 }));

    assert.equal(restarted.points.length, 4);
    assert.equal(restarted.points[0]?.f["iron-plate"]?.[0], 100);
  });
});

void test("drops the oldest points once the cap is reached", async () => {
  await withHistory(async (history) => {
    for (let minute = 0; minute < 8; minute += 1) {
      await history.record(
        sample({ tick: minute * TICKS_PER_MINUTE, iron: minute }),
      );
    }

    assert.equal(history.points.length, 5);
    assert.equal(history.points[0]?.t, 3 * TICKS_PER_MINUTE);
  }, 5);
});

void test("ignores samples from a Mod that cannot identify its save", async () => {
  await withHistory(async (history) => {
    // Without a save id two different saves would share one timeline, which is
    // worse than having no history at all.
    assert.equal(
      await history.record(sample({ tick: 0, iron: 100, saveId: null })),
      false,
    );
    assert.equal(history.points.length, 0);
  });
});

void test("reports what fell, rose, stopped and started", () => {
  const points = [
    point(0, { "iron-plate": [100, 90], "copper-plate": [50, 40], gone: [20, 10] }),
    point(10 * TICKS_PER_MINUTE, {
      "iron-plate": [40, 90],
      "copper-plate": [80, 40],
      "new-item": [30, 0],
    }),
  ];

  const trend = summarizeTrend(points, 10);
  assert.ok(trend !== undefined);
  assert.equal(trend.window_minutes, 10);
  assert.deepEqual(
    trend.declining.map((entry) => entry.id),
    ["iron-plate"],
  );
  assert.equal(trend.declining[0]?.change_percent, -60);
  assert.deepEqual(
    trend.rising.map((entry) => entry.id),
    ["copper-plate"],
  );
  assert.deepEqual(trend.stopped, ["gone"]);
  assert.deepEqual(trend.started, ["new-item"]);
});

void test("stays quiet about noise", () => {
  // A few percent of drift is normal in a running factory and reporting it
  // would bury the changes that matter.
  const trend = summarizeTrend(
    [
      point(0, { "iron-plate": [100, 90] }),
      point(10 * TICKS_PER_MINUTE, { "iron-plate": [95, 90] }),
    ],
    10,
  );

  assert.ok(trend !== undefined);
  assert.equal(trend.declining.length, 0);
  assert.equal(trend.rising.length, 0);
});

void test("has nothing to say from a single point", () => {
  assert.equal(summarizeTrend([point(0, { "iron-plate": [100, 90] })]), undefined);
  assert.equal(summarizeTrend([]), undefined);
});

async function withHistory(
  body: (history: ProductionHistory, directory: string) => Promise<void>,
  maxPoints?: number,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "factorio-history-"));
  try {
    await body(
      new ProductionHistory({
        directory,
        ...(maxPoints === undefined ? {} : { maxPoints }),
      }),
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function point(
  tick: number,
  flows: Record<string, [number, number]>,
): { t: number; f: Record<string, [number, number]>; p: number } {
  return { t: tick, f: flows, p: 1 };
}

function sample(options: {
  tick: number;
  iron: number;
  saveId?: string | null;
}): DynamicSnapshotPacket {
  const saveId =
    options.saveId === undefined ? "save-default" : options.saveId;
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: `factorio-dynamic-${options.tick}`,
    type: "dynamic_snapshot",
    tick: options.tick,
    payload: {
      sample_interval_ticks: 300,
      sample_sequence: options.tick,
      ...(saveId === null ? {} : { save_id: saveId }),
      truncated: false,
      omitted_forces: 0,
      omitted_series: 0,
      forces: [
        {
          id: "player",
          research: null,
          items: [
            {
              id: "iron-plate",
              produced_per_minute_1m: options.iron,
              consumed_per_minute_1m: options.iron,
              produced_per_minute_10m: options.iron,
              consumed_per_minute_10m: options.iron,
            },
          ],
          fluids: [],
          power: {
            network_count: 1,
            generated_watts: 100,
            consumed_watts: 100,
            satisfaction_ratio: 1,
          },
        },
      ],
    },
  };
}
