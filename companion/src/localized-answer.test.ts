import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ProductionResult } from "@factorio-ai-assistant/calculator";
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
import { AssistantService } from "./assistant-service.js";
import { resolveCompanionConfig } from "./config.js";
import { buildCompactContext } from "./context.js";
import { LocalizedNameStore } from "./localization.js";
import type { CompanionLogger } from "./logger.js";
import { CompanionStateStore } from "./state-store.js";

const START = 3_600;
const DURATION = 600;

const silentLogger: CompanionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

void test("chat answers name products and machines in the game language", async () => {
  const names = await chineseNames();
  const localized = await answerCalculation(names);

  assert.match(localized, /化学科技包 45\/min/);
  assert.match(localized, /3\.5 台 组装机 2 型/);
  assert.doesNotMatch(localized, /assembling-machine-2/);
  assert.doesNotMatch(localized, /chemical-science-pack/);

  const fallback = await answerCalculation(undefined);
  assert.match(fallback, /chemical-science-pack 45\/min/);
  assert.match(fallback, /3\.5 台 assembling-machine-2/);
});

void test("model context carries a localized name map for present identifiers", async () => {
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
  const map = context.localized_names as Record<string, string>;

  assert.equal(map["item:iron-plate"], "铁板");
  assert.equal(map["technology:robotics"], "机器人技术");
  assert.equal(map["fluid:heavy-oil"], undefined);
});

void test("localized names are trimmed predictably when the budget is tight", async () => {
  const names = await chineseNames();
  const sources = {
    dynamicForce: force({
      items: [
        flow("iron-plate", 50, 100, 50, 100),
        flow("copper-plate", 50, 100, 50, 100),
        flow("steel-plate", 50, 100, 50, 100),
      ],
    }),
    names,
  };
  const generous = buildCompactContext("铁板", sources, 4_096);
  const generousMap = generous.localized_names as Record<string, string>;
  assert.equal(Object.keys(generousMap).length, 3);

  const budget =
    Buffer.byteLength(JSON.stringify(generous), "utf8") - 20;
  const tight = buildCompactContext("铁板", sources, budget);
  const tightMap = (tight.localized_names ?? {}) as Record<string, string>;

  assert.ok(Object.keys(tightMap).length < 3);
  assert.ok(
    Buffer.byteLength(JSON.stringify(tight), "utf8") <= budget,
  );
  for (const [key, name] of Object.entries(tightMap)) {
    assert.equal(name, generousMap[key]);
  }
});

void test("context omits the name map entirely without a synchronized locale", () => {
  const context = buildCompactContext(
    "为什么铁板不够？",
    {
      dynamicForce: force({
        items: [flow("iron-plate", 50, 100, 50, 100)],
      }),
    },
    4_096,
  );

  assert.equal(context.localized_names, undefined);
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

async function answerCalculation(
  names: LocalizedNameStore | undefined,
): Promise<string> {
  const service = new AssistantService({
    config: resolveCompanionConfig({}, {}),
    stateStore: new CompanionStateStore(),
    advisor: new AdvisorEngine(),
    logger: silentLogger,
    ...(names === undefined ? {} : { localization: names }),
  });
  const answer = await service.answer({
    question: "45 蓝瓶每分钟需要多少机器？",
    calculation: productionResult(),
  });
  return answer.text;
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
