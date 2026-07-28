import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseProductionCatalog,
  type ProductionCatalog,
} from "@factorio-ai-assistant/calculator";
import {
  DEFAULT_ADVISOR_CONFIG,
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type DynamicSnapshotPacket,
  type StaticSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import { AdvisorEngine } from "./advisor.js";
import { AssistantService } from "./assistant-service.js";
import { CalculationService } from "./calculation-service.js";
import { resolveCompanionConfig } from "./config.js";
import type { CompanionLogger } from "./logger.js";
import type {
  AIProvider,
  ProviderRequest,
} from "./providers.js";
import { CompanionStateStore } from "./state-store.js";

interface DialogCase {
  id: string;
  question: string;
  expected_tool: string;
  expected_text: string;
}

interface DialogFixture {
  schema_version: 1;
  factorio_version: string;
  force_id: string;
  questions: DialogCase[];
  dynamic_snapshot: DynamicSnapshotPacket;
}

const silentLogger: CompanionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

void test(
  "grounds all five state-aware dialog fixtures in deterministic tools",
  async () => {
    const fixture = await readDialogFixture();
    const catalog = await readCatalog();
    const store = populatedStateStore(fixture, catalog);
    const advisor = populatedAdvisor(fixture, store);
    const requests = new Map<string, ProviderRequest>();
    const provider: AIProvider = {
      kind: "openai-compatible",
      complete(request) {
        requests.set(request.question, request);
        const evidenceId = firstEvidenceId(request.context);
        return Promise.resolve({
          text: `工具证据支持这段推断 [${evidenceId}]。`,
          model: "state-aware-fixture",
        });
      },
    };
    const service = new AssistantService({
      config: resolveCompanionConfig(
        { provider: "openclaw", model_retry_count: 0 },
        {},
      ),
      stateStore: store,
      advisor,
      logger: silentLogger,
      provider,
    });

    for (const fixtureCase of fixture.questions) {
      const answer = await service.answer({
        question: fixtureCase.question,
        forceId: fixture.force_id,
      });

      assert.equal(answer.mode, "model", fixtureCase.id);
      assert.match(answer.text, new RegExp(escapeRegex(fixtureCase.expected_text)));
      assert.ok(countActions(answer.text) <= 3, fixtureCase.id);
      assert.doesNotMatch(answer.text, /(?:\/c\b|RCON)/iu);

      const request = requests.get(fixtureCase.question);
      assert.ok(request !== undefined, fixtureCase.id);
      assert.equal(firstToolName(request.context), fixtureCase.expected_tool);
    }

    const calculation = new CalculationService(store).calculateDetailed({
      force_id: fixture.force_id,
      target_kind: "item",
      target_id: "chemical-science-pack",
      rate_per_minute: 45,
      module_ids: [],
    });
    const recipe = calculation.recipes.find(
      ({ recipe_id }) => recipe_id === "chemical-science-pack",
    );
    assert.ok(recipe !== undefined);
    const ratioAnswer = await service.answer({
      question: "45 蓝瓶每分钟需要多少机器？",
      forceId: fixture.force_id,
    });
    assert.match(ratioAnswer.text, new RegExp(String(recipe.machines.exact)));
    assert.match(ratioAnswer.text, new RegExp(String(recipe.machines.rounded_up)));
  },
);

void test(
  "uses a synchronized snapshot as evidence when no advisor rule is active",
  async () => {
    const fixture = await readDialogFixture();
    const catalog = await readCatalog();
    const store = populatedStateStore(fixture, catalog);
    let providerCalls = 0;
    const provider: AIProvider = {
      kind: "openai-compatible",
      complete(request) {
        providerCalls += 1;
        assert.equal(firstEvidenceId(request.context), "S1");
        return Promise.resolve({
          text: "当前电力满足率为 40% [S1]。",
          model: "state-aware-no-alerts",
        });
      },
    };
    const service = new AssistantService({
      config: resolveCompanionConfig(
        { provider: "openclaw", model_retry_count: 0 },
        {},
      ),
      stateStore: store,
      advisor: new AdvisorEngine(undefined, "zh-CN"),
      logger: silentLogger,
      provider,
    });

    const answer = await service.answer({
      question: "当前工厂状态怎么样？",
      forceId: fixture.force_id,
    });

    assert.equal(providerCalls, 1);
    assert.equal(answer.mode, "model");
    assert.match(answer.text, /电力网络 1 个/);
    assert.match(answer.text, /发电 40 MW/);
    assert.match(answer.text, /用电 100 MW/);
    assert.match(answer.text, /满足率 40%/);
    assert.match(answer.text, /当前没有进行中的研究/);
    assert.match(answer.text, /\[S3\] 1 分钟净缺口候选/);
    assert.match(answer.text, /物品 iron-plate/);
    assert.match(answer.text, /流体 petroleum-gas/);
    assert.match(answer.text, /当前电力满足率为 40% \[S1\]/);
  },
);

async function readDialogFixture(): Promise<DialogFixture> {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/state-aware-dialog.json", import.meta.url),
      "utf8",
    ),
  ) as DialogFixture;
}

async function readCatalog(): Promise<ProductionCatalog> {
  return parseProductionCatalog(
    JSON.parse(
      await readFile(
        new URL(
          "../../packages/calculator/fixtures/vanilla-2.0.72-base.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown,
  );
}

function populatedStateStore(
  fixture: DialogFixture,
  catalog: ProductionCatalog,
): CompanionStateStore {
  const staticPacket: StaticSnapshotPacket = {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-state-aware-static",
    type: "static_snapshot",
    tick: fixture.dynamic_snapshot.tick - 1,
    payload: {
      snapshot_id: "state-aware-static",
      revision: 1,
      chunk_index: 0,
      chunk_count: 1,
      truncated: false,
      omitted_records: 0,
      game: {
        version: fixture.factorio_version,
        mods: [{ id: "base", version: fixture.factorio_version }],
      },
      forces: [
        {
          id: fixture.force_id,
          researched_technologies: ["advanced-oil-processing"],
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
  assert.equal(store.acceptStaticSnapshotChunk(staticPacket), true);
  store.acceptDynamicSnapshot(fixture.dynamic_snapshot);
  return store;
}

function populatedAdvisor(
  fixture: DialogFixture,
  store: CompanionStateStore,
): AdvisorEngine {
  const advisor = new AdvisorEngine(
    {
      ...DEFAULT_ADVISOR_CONFIG,
      recovery_ticks: 0,
      research_idle_ticks: 0,
      power_low_ticks: 0,
      lubricant_zero_ticks: 0,
      oil_imbalance_ticks: 0,
      science_stable_ticks: 0,
      material_deficit_ticks: 0,
      crude_decline_ticks: 0,
      production_stop_ticks: 0,
    },
    "zh-CN",
  );
  advisor.evaluate(fixture.dynamic_snapshot, store.staticState);
  assert.ok(advisor.activeAlerts.length >= 3);
  return advisor;
}

function firstEvidenceId(context: unknown): string {
  const tools = readRecord(readRecord(context).deterministic_tools);
  const evidence = tools.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error("Expected deterministic tool evidence");
  }
  const id = readRecord(evidence[0]).id;
  if (typeof id !== "string") {
    throw new Error("Expected a deterministic evidence ID");
  }
  return id;
}

function firstToolName(context: unknown): string {
  const tools = readRecord(readRecord(context).deterministic_tools);
  const calls = tools.calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error("Expected a deterministic tool call");
  }
  const name = readRecord(calls[0]).name;
  if (typeof name !== "string") {
    throw new Error("Expected a deterministic tool name");
  }
  return name;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function countActions(value: string): number {
  return [...value.matchAll(/^\d+\.\s/gm)].length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
