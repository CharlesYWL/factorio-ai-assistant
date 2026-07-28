import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  ADVISOR_RULE_IDS,
  DEFAULT_ADVISOR_CONFIG,
  MAX_PACKET_BYTES,
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  decodePacket,
} from "../packages/protocol/dist/index.js";
import { AdvisorEngine } from "../companion/dist/advisor.js";
import { CompanionStateStore } from "../companion/dist/state-store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(await readFile(path.join(root, "release.config.json"), "utf8"));
const staticState = {
  truncated: false,
  forces: [{ id: "player", researched_technologies: ["automation-2"] }],
};
const definitions = [
  {
    name: "idle",
    iterations: 3_000,
    maxAverageMs: 2,
    packet: dynamicPacket([], []),
  },
  {
    name: "normal-production",
    iterations: 1_500,
    maxAverageMs: 5,
    packet: dynamicPacket(makeFlows("item", 20), makeFlows("fluid", 8)),
  },
  {
    name: "large-factory-summary",
    iterations: 300,
    maxAverageMs: 20,
    packet: largePacket(),
  },
];

const scenarios = definitions.map(runScenario);
const alertStorm = runAlertStormSimulation();
const report = {
  format_version: 1,
  release_tag: release.release_tag,
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  scenarios,
  alert_storm_30_minutes: alertStorm,
};
const outputDirectory = path.join(root, "artifacts");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "performance-baseline.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(report, null, 2));

function runScenario(definition) {
  const store = new CompanionStateStore();
  const advisor = new AdvisorEngine();
  const durations = [];
  let eventCount = 0;
  const warmup = 50;
  const total = definition.iterations + warmup;

  for (let index = 0; index < total; index += 1) {
    definition.packet.tick = (index + 1) * 300;
    definition.packet.message_id = `benchmark-${definition.name}-${index + 1}`;
    definition.packet.payload.sample_sequence = index + 1;
    const encoded = JSON.stringify(definition.packet);
    const started = performance.now();
    const decoded = decodePacket(encoded);
    store.acceptDynamicSnapshot(decoded);
    eventCount += advisor.evaluate(decoded, staticState).length;
    const elapsed = performance.now() - started;
    if (index >= warmup) {
      durations.push(elapsed);
    }
  }

  durations.sort((left, right) => left - right);
  const averageMs = durations.reduce((totalMs, value) => totalMs + value, 0) / durations.length;
  const p95Ms = durations[Math.floor((durations.length - 1) * 0.95)];
  const packetBytes = Buffer.byteLength(JSON.stringify(definition.packet), "utf8");
  assert.ok(packetBytes <= MAX_PACKET_BYTES, `${definition.name} packet exceeds protocol limit`);
  assert.ok(
    averageMs <= definition.maxAverageMs,
    `${definition.name} average ${averageMs.toFixed(3)} ms exceeds ${definition.maxAverageMs} ms`,
  );

  return {
    name: definition.name,
    iterations: definition.iterations,
    packet_bytes: packetBytes,
    series_count:
      definition.packet.payload.forces[0].items.length +
      definition.packet.payload.forces[0].fluids.length,
    average_ms: round(averageMs),
    p95_ms: round(p95Ms),
    max_ms: round(durations.at(-1)),
    gate_average_ms: definition.maxAverageMs,
    emitted_events: eventCount,
  };
}

function runAlertStormSimulation() {
  const config = {
    ...DEFAULT_ADVISOR_CONFIG,
    muted_rules: ADVISOR_RULE_IDS.filter((id) => id !== "power-low"),
  };
  const advisor = new AdvisorEngine(config);
  const packet = dynamicPacket([], []);
  packet.payload.forces[0].power = {
    network_count: 1,
    generated_watts: 80_000_000,
    consumed_watts: 100_000_000,
    satisfaction_ratio: 0.8,
  };
  const proactiveTicks = [];
  let sequence = 0;

  for (let tick = 0; tick <= 30 * 60 * 60; tick += 300) {
    sequence += 1;
    packet.tick = tick;
    packet.message_id = `alert-storm-${sequence}`;
    packet.payload.sample_sequence = sequence;
    const events = advisor.evaluate(decodePacket(JSON.stringify(packet)), staticState);
    for (const event of events) {
      if (event.proactive) {
        proactiveTicks.push(tick);
      }
    }
  }

  assert.ok(proactiveTicks.length <= 7, "Thirty-minute simulation emitted an alert storm");
  for (let index = 1; index < proactiveTicks.length; index += 1) {
    assert.ok(
      proactiveTicks[index] - proactiveTicks[index - 1] >=
        DEFAULT_ADVISOR_CONFIG.notification_cooldown_ticks,
      "Proactive alerts violated the configured cooldown",
    );
  }
  return {
    samples: sequence,
    proactive_alerts: proactiveTicks.length,
    proactive_ticks: proactiveTicks,
    maximum_allowed: 7,
    cooldown_ticks: DEFAULT_ADVISOR_CONFIG.notification_cooldown_ticks,
  };
}

function dynamicPacket(items, fluids) {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "benchmark",
    type: "dynamic_snapshot",
    tick: 0,
    payload: {
      sample_interval_ticks: 300,
      sample_sequence: 0,
      truncated: false,
      omitted_forces: 0,
      omitted_series: 0,
      forces: [
        {
          id: "player",
          research: {
            technology_id: "automation-2",
            progress: 0.42,
          },
          items,
          fluids,
          power: {
            network_count: 1,
            generated_watts: 100_000_000,
            consumed_watts: 90_000_000,
            satisfaction_ratio: 1,
          },
        },
      ],
    },
  };
}

function largePacket() {
  const items = [];
  const fluids = [];
  const packet = dynamicPacket(items, fluids);
  let index = 0;

  while (index < 256) {
    const target = index % 4 === 0 ? fluids : items;
    target.push(flow(`${target === items ? "item" : "fluid"}-${String(index).padStart(3, "0")}`));
    if (Buffer.byteLength(JSON.stringify(packet), "utf8") > MAX_PACKET_BYTES - 1_024) {
      target.pop();
      break;
    }
    index += 1;
  }
  return packet;
}

function makeFlows(kind, count) {
  return Array.from({ length: count }, (_, index) =>
    flow(`${kind}-${String(index).padStart(3, "0")}`),
  );
}

function flow(id) {
  return {
    id,
    produced_per_minute_1m: 1_200,
    consumed_per_minute_1m: 1_000,
    produced_per_minute_10m: 1_100,
    consumed_per_minute_10m: 950,
  };
}

function round(value) {
  return Number(value.toFixed(4));
}
