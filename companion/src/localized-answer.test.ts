import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ADVISOR_RULE_IDS,
  DEFAULT_ADVISOR_CONFIG,
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  decodePacket,
  type AdvisorRuleId,
  type DynamicForceSummary,
  type DynamicSnapshotPacket,
  type FlowMetric,
  type LocalizationUpdatePacket,
} from "@factorio-ai-assistant/protocol";

import { AdvisorEngine, type AdvisorStaticState } from "./advisor.js";
import { buildCompactContext } from "./context.js";
import { LocalizedNameStore } from "./localization.js";

const START = 3_600;
const DURATION = 600;

const staticState: AdvisorStaticState = {
  truncated: false,
  forces: [
    {
      id: "player",
      researched_technologies: ["advanced-oil-processing"],
    },
  ],
};

void test("advisor evidence prefers game-language names over prototype IDs", async () => {
  const names = await chineseNames();

  const deficit = openAlert("material-deficit", names, {
    items: [flow("iron-plate", 50, 100, 50, 100)],
  });
  assert.match(deficit.evidence, /铁板/);
  assert.doesNotMatch(deficit.evidence, /iron-plate/);

  const decline = openAlert("production-decline", names, {
    fluids: [flow("crude-oil", 20, 0, 100, 0)],
  });
  assert.match(decline.evidence, /原油/);

  const oil = openAlert("oil-imbalance", names, {
    fluids: [
      flow("heavy-oil", 200, 0, 200, 0),
      flow("light-oil", 0, 0, 0, 0),
      flow("petroleum-gas", 0, 200, 0, 200),
    ],
  });
  assert.match(oil.evidence, /重油/);
  assert.match(oil.evidence, /石油气/);
  assert.match(oil.recommendation, /轻油/);

  const lubricant = openAlert("lubricant-zero", names, {
    fluids: [flow("lubricant", 0, 0, 0, 0)],
  });
  assert.match(lubricant.evidence, /润滑油/);
  assert.match(lubricant.evidence, /高级石油处理/);

  const robotics = openAlert("robotics-stalled", names, {
    items: [flow("chemical-science-pack", 20, 10, 20, 10)],
  });
  assert.match(robotics.evidence, /化学科技包/);
  assert.match(robotics.recommendation, /建设机器人技术/);
});

void test("advisor evidence falls back to identifiers without a translation", () => {
  const deficit = openAlert("material-deficit", undefined, {
    items: [flow("iron-plate", 50, 100, 50, 100)],
  });

  assert.match(deficit.evidence, /iron-plate/);
  assert.doesNotMatch(deficit.evidence, /铁板/);
});

void test("advisor renders English display names for an English game", async () => {
  const names = new LocalizedNameStore();
  names.apply(await readLocalization("vanilla-2.0-localization-en.json"));

  const deficit = openAlert(
    "material-deficit",
    names,
    { items: [flow("iron-plate", 50, 100, 50, 100)] },
    "en",
  );

  assert.match(deficit.evidence, /Iron plate/);
  assert.doesNotMatch(deficit.evidence, /iron-plate/);
});

void test("live production flows carry game-language names", async () => {
  const names = await chineseNames();
  const context = buildCompactContext(
    "为什么铁板不够？",
    {
      dynamicForce: force({
        items: [flow("iron-plate", 50, 100, 50, 100)],
        research: { technology_id: "robotics", progress: 0.25 },
      }),
      names,
    },
    4_096,
  );

  const flows = context.production_per_minute as Array<Record<string, unknown>>;
  const ironPlate = flows.find((entry) => entry.id === "iron-plate");
  assert.equal(ironPlate?.name, "铁板");

  const research = context.current_research as Record<string, unknown>;
  assert.equal(research.name, "机器人技术");
});

void test("identifiers travel unchanged without a synchronized locale", () => {
  const context = buildCompactContext(
    "为什么铁板不够？",
    {
      dynamicForce: force({
        items: [flow("iron-plate", 50, 100, 50, 100)],
      }),
    },
    4_096,
  );

  const flows = context.production_per_minute as Array<Record<string, unknown>>;
  const ironPlate = flows.find((entry) => entry.id === "iron-plate");
  assert.equal(ironPlate?.id, "iron-plate");
  // Without a locale there is no name to add, and the identifier must remain
  // usable on its own.
  assert.equal("name" in (ironPlate ?? {}), false);
});
async function chineseNames(): Promise<LocalizedNameStore> {
  const names = new LocalizedNameStore();
  names.apply(await readLocalization("vanilla-2.0-localization-zh-CN.json"));
  return names;
}

async function readLocalization(
  fileName: string,
): Promise<LocalizationUpdatePacket> {
  const packet = decodePacket(
    await readFile(
      new URL(
        `../../packages/protocol/fixtures/${fileName}`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(packet.type, "localization_update");
  return packet;
}

function openAlert(
  ruleId: AdvisorRuleId,
  names: LocalizedNameStore | undefined,
  flows: Partial<Pick<DynamicForceSummary, "items" | "fluids" | "research">>,
  language: "zh-CN" | "en" = "zh-CN",
): { evidence: string; recommendation: string } {
  const engine = new AdvisorEngine(
    {
      ...DEFAULT_ADVISOR_CONFIG,
      muted_rules: ADVISOR_RULE_IDS.filter((id) => id !== ruleId),
      recovery_ticks: DURATION,
      research_idle_ticks: DURATION,
      power_low_ticks: DURATION,
      lubricant_zero_ticks: DURATION,
      oil_imbalance_ticks: DURATION,
      science_stable_ticks: DURATION,
      material_deficit_ticks: DURATION,
      crude_decline_ticks: DURATION,
      production_stop_ticks: DURATION,
    },
    language,
  );
  if (names !== undefined) {
    engine.useLocalizedNames(names);
  }

  const summary = force(flows);
  engine.evaluate(snapshot(START, summary), staticState);
  const events = engine.evaluate(snapshot(START + DURATION, summary), staticState);
  const opened = events.find(
    (event) => event.type === "opened" && event.alert.rule_id === ruleId,
  );

  assert.ok(opened !== undefined, `Expected ${ruleId} to open`);
  return {
    evidence: opened.alert.evidence,
    recommendation: opened.alert.recommendation,
  };
}

function force(
  overrides: Partial<Pick<DynamicForceSummary, "items" | "fluids" | "research">>,
): DynamicForceSummary {
  return {
    id: "player",
    research: overrides.research ?? null,
    items: overrides.items ?? [],
    fluids: overrides.fluids ?? [],
    power: {
      network_count: 1,
      generated_watts: 1_000_000,
      consumed_watts: 900_000,
      satisfaction_ratio: 1,
    },
  };
}

function flow(
  id: string,
  produced1m: number,
  consumed1m: number,
  produced10m: number,
  consumed10m: number,
): FlowMetric {
  return {
    id,
    produced_per_minute_1m: produced1m,
    consumed_per_minute_1m: consumed1m,
    produced_per_minute_10m: produced10m,
    consumed_per_minute_10m: consumed10m,
  };
}

function snapshot(
  tick: number,
  dynamicForce: DynamicForceSummary,
): DynamicSnapshotPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: `factorio-localized-${tick}`,
    type: "dynamic_snapshot",
    tick,
    payload: {
      sample_interval_ticks: 300,
      sample_sequence: tick,
      truncated: false,
      omitted_forces: 0,
      omitted_series: 0,
      forces: [dynamicForce],
    },
  };
}
