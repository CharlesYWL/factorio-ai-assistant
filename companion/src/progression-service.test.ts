import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalizationUpdatePacket,
  DEFAULT_ADVISOR_CONFIG,
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type DynamicSnapshotPacket,
  type StaticSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import { AdvisorEngine } from "./advisor.js";
import { AssistantService } from "./assistant-service.js";
import { AssistantToolbox } from "./assistant-tools.js";
import { resolveCompanionConfig } from "./config.js";
import { LocalizedNameStore } from "./localization.js";
import type { CompanionLogger } from "./logger.js";
import { ProgressionService } from "./progression-service.js";
import type { AIProvider } from "./providers.js";
import { CompanionStateStore } from "./state-store.js";

const silentLogger: CompanionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const MID_GAME_TECHNOLOGIES = [
  "steam-power",
  "electronics",
  "automation-science-pack",
  "automation",
  "logistics",
  "logistic-science-pack",
  "steel-processing",
];

void test("plans the current stage from researched technologies", () => {
  const store = populatedStore();
  const advisor = new AdvisorEngine(DEFAULT_ADVISOR_CONFIG, "zh-CN");
  const { plan, forceId, stateAvailable } = new ProgressionService(
    store,
    advisor,
  ).plan({ forceId: "player" });

  assert.equal(forceId, "player");
  assert.equal(stateAvailable, true);
  assert.equal(plan.stage.id, "smelting-logistics-military");
  assert.equal(plan.stage.order, 3);
  assert.equal(plan.stage.basis, "state");
  assert.equal(plan.next_stage?.id, "oil-chemical-blue");
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.sources.every(({ url }) => url.startsWith("https://")));
});

void test("answers a next-step question with ordered guide evidence", async () => {
  const answer = await answerLocally("接下来该做什么？");

  assert.equal(answer.mode, "local");
  assert.match(answer.text, /当前阶段：3\/8/u);
  assert.doesNotMatch(
    answer.text,
    /\[(?:流程指南|推断|缺失数据|假设|行动)\]/u,
  );
  assert.ok(countActions(answer.text) > 0 && countActions(answer.text) <= 3);
});

void test("puts the active bottleneck ahead of generic stage steps", async () => {
  const answer = await answerLocally("下一步该扩建什么？");
  const actions = actionLines(answer.text);

  assert.ok(actions.length >= 2);
  assert.match(actions[0] ?? "", /先处理当前瓶颈（material-deficit）/u);
  assert.doesNotMatch(actions[0] ?? "", /证据|\[A1\]/u);
});

void test("keeps advisor alerts as the first tool for research questions", () => {
  const store = populatedStore();
  const toolbox = new AssistantToolbox(store, populatedAdvisor(store), "zh-CN");
  const grounding = toolbox.ground("我现在最该研究什么？", "player");

  assert.equal(grounding.intent, "research");
  assert.equal(grounding.calls[0]?.name, "read_advisor_alerts");
  assert.equal(grounding.calls[1]?.name, "read_progression_guide");
  assert.equal(grounding.calls[1]?.id, "tool-2");
  assert.ok(grounding.evidence.some(({ category }) => category === "guide"));
});

void test("puts the progression guide first for planning questions", () => {
  const store = populatedStore();
  const toolbox = new AssistantToolbox(store, populatedAdvisor(store), "zh-CN");
  const grounding = toolbox.ground("下一步做什么？", "player");

  assert.equal(grounding.intent, "planning");
  assert.equal(grounding.calls[0]?.name, "read_progression_guide");
  assert.equal(grounding.calls[0]?.id, "tool-1");
  assert.equal(grounding.calls[0]?.status, "ok");
  assert.equal(grounding.progression?.stage.id, "smelting-logistics-military");
});

void test("localizes progression-guide prototype IDs in compact actions", async () => {
  const store = new CompanionStateStore();
  assert.equal(
    store.acceptStaticSnapshotChunk(
      staticPacket([...MID_GAME_TECHNOLOGIES, "utility-science-pack"], false),
    ),
    true,
  );
  store.acceptDynamicSnapshot(dynamicPacket());
  const names = new LocalizedNameStore();
  names.apply(
    createLocalizationUpdatePacket({
      messageId: "factorio-guide-localization",
      tick: 600,
      locale: "zh-CN",
      reset: true,
      names: [
        { kind: "technology", id: "rocket-silo", name: "火箭发射井" },
        { kind: "technology", id: "concrete", name: "混凝土" },
        { kind: "technology", id: "rocket-fuel", name: "火箭燃料" },
        {
          kind: "technology",
          id: "electric-energy-accumulators",
          name: "电能蓄电",
        },
        { kind: "technology", id: "solar-energy", name: "太阳能" },
        {
          kind: "technology",
          id: "utility-science-pack",
          name: "效用科技包",
        },
        { kind: "technology", id: "speed-module-3", name: "速度插件 3" },
        {
          kind: "technology",
          id: "productivity-module-3",
          name: "产能插件 3",
        },
        { kind: "technology", id: "radar", name: "雷达" },
      ],
    }),
  );
  const service = new AssistantService({
    config: resolveCompanionConfig({}, {}),
    stateStore: store,
    advisor: new AdvisorEngine(DEFAULT_ADVISOR_CONFIG, "zh-CN", names),
    logger: silentLogger,
    localization: names,
  });

  const answer = await service.answer({
    question: "接下来该做什么？",
    forceId: "player",
  });

  assert.match(answer.text, /当前阶段：8\/8/u);
  for (const expected of [
    "火箭发射井",
    "混凝土",
    "火箭燃料",
    "电能蓄电",
    "太阳能",
    "效用科技包",
    "速度插件 3",
    "产能插件 3",
    "雷达",
  ]) {
    assert.match(answer.text, new RegExp(expected, "u"));
  }
  assert.doesNotMatch(
    answer.text,
    /rocket-silo|concrete|rocket-fuel|utility-science-pack|speed-module-3|productivity-module-3/u,
  );
});

void test("routes the built-in quick questions to the progression guide", () => {
  const store = populatedStore();
  const toolbox = new AssistantToolbox(store, populatedAdvisor(store), "zh-CN");

  for (const question of [
    "下一步应该优先扩建什么？",
    "What should I expand next?",
  ]) {
    const grounding = toolbox.ground(question, "player");
    assert.equal(grounding.intent, "planning", question);
    assert.equal(
      grounding.calls[0]?.name,
      "read_progression_guide",
      question,
    );
  }
});

void test("keeps failure questions on the diagnosis path", () => {
  const store = populatedStore();
  const toolbox = new AssistantToolbox(store, populatedAdvisor(store), "zh-CN");

  for (const question of [
    "为什么我的炼油流程停了？",
    "为什么石油产线停了，接下来怎么办？",
    "why did my smelting line stop?",
  ]) {
    const grounding = toolbox.ground(question, "player");
    assert.equal(grounding.intent, "diagnosis", question);
    assert.equal(grounding.calls[0]?.name, "read_advisor_alerts", question);
  }
});

void test("reports the stage as a lower bound when the static state is truncated", async () => {
  const store = new CompanionStateStore();
  assert.equal(
    store.acceptStaticSnapshotChunk(
      staticPacket(["automation", "automation-science-pack"], true),
    ),
    true,
  );
  store.acceptDynamicSnapshot(dynamicPacket());
  const service = new AssistantService({
    config: resolveCompanionConfig({}, {}),
    stateStore: store,
    advisor: new AdvisorEngine(DEFAULT_ADVISOR_CONFIG, "zh-CN"),
    logger: silentLogger,
  });

  const answer = await service.answer({
    question: "接下来该做什么？",
    forceId: "player",
  });

  assert.match(answer.text, /当前阶段：至少 2\/8/u);
  assert.match(answer.text, /⚠ 部分状态数据已裁剪/u);
});

void test("gives a general stage clarification without synchronized state", async () => {
  const service = new AssistantService({
    config: resolveCompanionConfig({}, {}),
    stateStore: new CompanionStateStore(),
    advisor: new AdvisorEngine(DEFAULT_ADVISOR_CONFIG, "zh-CN"),
    logger: silentLogger,
  });
  const answer = await service.answer({ question: "下一步该做什么？" });

  assert.equal(answer.mode, "local");
  assert.match(answer.text, /通用流程：1\/8/u);
  assert.match(answer.text, /⚠ 当前存档状态尚未完整同步/u);
  assert.doesNotMatch(
    answer.text,
    /\[(?:流程指南|推断|缺失数据|假设)\]/u,
  );
  assert.doesNotMatch(answer.text, /当前阶段：3\/8/u);
});

void test("reports truncated snapshots as data gaps instead of assuming zero", () => {
  const store = new CompanionStateStore();
  assert.equal(
    store.acceptStaticSnapshotChunk(
      staticPacket(["automation", "automation-science-pack"], true),
    ),
    true,
  );
  const { plan } = new ProgressionService(
    store,
    new AdvisorEngine(DEFAULT_ADVISOR_CONFIG, "zh-CN"),
  ).plan({ forceId: "player" });

  assert.equal(plan.stage.id, "automation-red-green");
  assert.ok(
    plan.data_gaps.some(({ rule_id }) => rule_id === "state:static_truncated"),
  );
  assert.ok(plan.data_gaps.some(({ rule_id }) => rule_id === "state:flows"));
});

void test("discards a model answer that adds its own numbers or Lua commands", async () => {
  for (const unsafe of [
    "现在建 12 台组装机 [G1]。",
    "运行 /c game.print(\"done\") 就能自动建造 [G1]。",
  ]) {
    const provider: AIProvider = {
      kind: "openai-compatible",
      complete: () =>
        Promise.resolve({ text: unsafe, model: "unsafe-fixture" }),
    };
    const store = populatedStore();
    const service = new AssistantService({
      config: resolveCompanionConfig(
        { provider: "openclaw", model_retry_count: 0 },
        {},
      ),
      stateStore: store,
      advisor: populatedAdvisor(store),
      logger: silentLogger,
      provider,
    });

    const answer = await service.answer({
      question: "接下来该做什么？",
      forceId: "player",
    });

    assert.equal(answer.mode, "local", unsafe);
    assert.equal(answer.fallbackReason, "model_conflict", unsafe);
    assert.match(answer.text, /当前阶段：3\/8/u);
    assert.doesNotMatch(answer.text, /\/c\s|game\.print/u);
  }
});

void test("keeps a grounded model inference that only cites guide evidence", async () => {
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete: () =>
      Promise.resolve({
        text: "指南规则和当前告警指向同样的产线 [G1]。",
        model: "grounded-fixture",
      }),
  };
  const store = populatedStore();
  const service = new AssistantService({
    config: resolveCompanionConfig(
      { provider: "openclaw", model_retry_count: 0 },
      {},
    ),
    stateStore: store,
    advisor: populatedAdvisor(store),
    logger: silentLogger,
    provider,
  });

  const answer = await service.answer({
    question: "接下来该做什么？",
    forceId: "player",
  });

  assert.equal(answer.mode, "model");
  assert.match(answer.text, /指南规则和当前告警指向同样的产线。/u);
  assert.match(answer.text, /当前阶段：3\/8/u);
  assert.doesNotMatch(answer.text, /\[G1\]|\[流程指南\]/u);
});

async function answerLocally(question: string): Promise<{
  mode: string;
  text: string;
}> {
  const store = populatedStore();
  const service = new AssistantService({
    config: resolveCompanionConfig({}, {}),
    stateStore: store,
    advisor: populatedAdvisor(store),
    logger: silentLogger,
  });
  return service.answer({ question, forceId: "player" });
}

function populatedStore(): CompanionStateStore {
  const store = new CompanionStateStore();
  assert.equal(
    store.acceptStaticSnapshotChunk(staticPacket(MID_GAME_TECHNOLOGIES, false)),
    true,
  );
  store.acceptDynamicSnapshot(dynamicPacket());
  return store;
}

function populatedAdvisor(store: CompanionStateStore): AdvisorEngine {
  const advisor = new AdvisorEngine(
    {
      ...DEFAULT_ADVISOR_CONFIG,
      recovery_ticks: 0,
      research_idle_ticks: 0,
      material_deficit_ticks: 0,
    },
    "zh-CN",
  );
  const dynamicState = store.dynamicState;
  assert.ok(dynamicState !== undefined);
  advisor.evaluate(dynamicState, store.staticState);
  assert.ok(advisor.activeAlerts.length > 0);
  return advisor;
}

function staticPacket(
  technologies: string[],
  truncated: boolean,
): StaticSnapshotPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-progression-static",
    type: "static_snapshot",
    tick: 60,
    payload: {
      snapshot_id: "progression-static",
      revision: 1,
      chunk_index: 0,
      chunk_count: 1,
      truncated,
      omitted_records: truncated ? 12 : 0,
      game: { version: "2.0.72", mods: [{ id: "base", version: "2.0.72" }] },
      forces: [
        {
          id: "player",
          researched_technologies: technologies,
          available_recipes: [],
          recipe_productivity_bonuses: [],
        },
      ],
      recipes: [],
      machines: [],
      modules: [],
    },
  };
}

function dynamicPacket(): DynamicSnapshotPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-progression-dynamic",
    type: "dynamic_snapshot",
    tick: 600,
    payload: {
      sample_interval_ticks: 300,
      sample_sequence: 2,
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
              produced_per_minute_1m: 200,
              consumed_per_minute_1m: 320,
              produced_per_minute_10m: 200,
              consumed_per_minute_10m: 320,
            },
          ],
          fluids: [],
          power: {
            network_count: 1,
            generated_watts: 3_000_000,
            consumed_watts: 2_000_000,
            satisfaction_ratio: 1,
          },
        },
      ],
    },
  };
}

function actionLines(value: string): string[] {
  return value.split("\n").filter((line) => /^\d+\.\s/u.test(line));
}

function countActions(value: string): number {
  return actionLines(value).length;
}
