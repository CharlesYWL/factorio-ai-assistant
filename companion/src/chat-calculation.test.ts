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
  type LocalizationUpdatePacket,
  type StaticSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import { AdvisorEngine } from "./advisor.js";
import {
  AssistantToolbox,
  formatGroundedAnswer,
} from "./assistant-tools.js";
import { LocalizedNameStore } from "./localization.js";
import {
  isProductionRatioQuestion,
  parseTargetRate,
} from "./production-question.js";
import { resolveResourceMention } from "./resource-resolver.js";
import { CompanionStateStore } from "./state-store.js";

interface ResolvedCase {
  id: string;
  question: string;
  target_kind: "item" | "fluid";
  target_id: string;
  rate_per_minute: number;
}

interface ClarificationCase {
  id: string;
  question: string;
  expect_all: string[];
}

interface ChatCalculationFixture {
  schema_version: 1;
  factorio_version: string;
  force_id: string;
  resolved: ResolvedCase[];
  clarifications: ClarificationCase[];
}

void test(
  "answers natural-language production questions without a prototype ID",
  async () => {
    const fixture = await readFixture();
    const toolbox = await createToolbox(fixture);

    for (const scenario of fixture.resolved) {
      const grounding = toolbox.ground(scenario.question);
      assert.equal(
        grounding.intent,
        "calculation",
        `${scenario.id} must route to the deterministic calculator`,
      );

      const call = grounding.calls[0];
      assert.ok(call !== undefined, `${scenario.id} must record a tool call`);
      assert.equal(call.name, "calculate_production_ratio");
      assert.equal(
        call.status,
        "ok",
        `${scenario.id} failed: ${call.error_code ?? ""} ${call.error_message ?? ""}`,
      );
      assert.equal(call.arguments.target_kind, scenario.target_kind);
      assert.equal(call.arguments.target_id, scenario.target_id);
      assert.equal(call.arguments.rate_per_minute, scenario.rate_per_minute);

      const target = grounding.calculation?.targets[0];
      assert.ok(target !== undefined);
      assert.equal(target.id, scenario.target_id);
      assert.equal(target.per_minute, scenario.rate_per_minute);

      const recipe = grounding.calculation?.recipes[0];
      assert.ok(recipe !== undefined);
      assert.ok(recipe.machines.rounded_up >= 1);

      const answer = formatGroundedAnswer("zh-CN", grounding);
      assert.doesNotMatch(answer, /\[(?:计算结果|推断|缺失数据|假设)\]/u);
      assertNoIdentifierDemand(answer, scenario.id);
    }
  },
);

void test("asks a short clarification instead of demanding an ID", async () => {
  const fixture = await readFixture();
  const toolbox = await createToolbox(fixture);

  for (const scenario of fixture.clarifications) {
    const grounding = toolbox.ground(scenario.question);
    assert.equal(
      grounding.intent,
      "calculation",
      `${scenario.id} must stay on the calculator path`,
    );
    const call = grounding.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.status, "error");
    assert.equal(call.error_code, "INVALID_ARGUMENT");

    const clarification = grounding.missingData.join("\n");
    for (const expected of scenario.expect_all) {
      assert.ok(
        clarification.includes(expected),
        `${scenario.id} clarification must mention ${expected}: ${clarification}`,
      );
    }
    assert.ok(
      grounding.calculation === undefined,
      `${scenario.id} must not invent a calculation`,
    );
    assertNoIdentifierDemand(
      formatGroundedAnswer("zh-CN", grounding),
      scenario.id,
    );
  }
});

void test("prefers the synchronized game locale over prototype IDs", async () => {
  const fixture = await readFixture();
  const names = new LocalizedNameStore();
  names.apply(localizationPacket());
  const toolbox = await createToolbox(fixture, names);

  const grounding = toolbox.ground("每分钟 60 个管道需要多少台机器？");
  const call = grounding.calls[0];
  assert.ok(call !== undefined);
  assert.equal(
    call.status,
    "ok",
    `${call.error_code ?? ""} ${call.error_message ?? ""}`,
  );
  assert.equal(call.arguments.target_id, "pipe");
  assert.match(formatGroundedAnswer("zh-CN", grounding), /管道/u);
});

void test("normalizes stated rates to a per-minute target", () => {
  assert.equal(parseTargetRate("每分钟 45 蓝瓶")?.perMinute, 45);
  assert.equal(parseTargetRate("45 蓝瓶每分钟需要多少机器？")?.perMinute, 45);
  assert.equal(parseTargetRate("一分钟 120 绿板怎么配？")?.perMinute, 120);
  assert.equal(parseTargetRate("每秒 2 个绿板")?.perMinute, 120);
  assert.equal(parseTargetRate("每小时 600 钢材")?.perMinute, 10);
  assert.equal(parseTargetRate("60/min 绿板")?.perMinute, 60);
  assert.equal(parseTargetRate("45 chemical science per minute")?.perMinute, 45);
  assert.equal(parseTargetRate("蓝瓶需要多少台机器？"), undefined);
  assert.equal(parseTargetRate("3 台机器每分钟能出多少蓝瓶？"), undefined);
});

void test("only routes ratio questions to the calculator", () => {
  assert.equal(isProductionRatioQuestion("一分钟 120 绿板怎么配？"), true);
  assert.equal(isProductionRatioQuestion("蓝瓶需要多少台机器？"), true);
  assert.equal(isProductionRatioQuestion("当前最大的生产瓶颈是什么？"), false);
  assert.equal(isProductionRatioQuestion("下一步应该优先扩建什么？"), false);
  assert.equal(isProductionRatioQuestion("当前电力和科研状态怎么样？"), false);
  assert.equal(isProductionRatioQuestion("接下来该研究什么科技？"), false);
});

void test("keeps generic words ambiguous instead of guessing", () => {
  const products = [
    ["item", "electronic-circuit"],
    ["item", "advanced-circuit"],
    ["item", "processing-unit"],
  ] as const;
  const names = new LocalizedNameStore();

  const ambiguous = resolveResourceMention("每分钟 60 电路", {
    products,
    names,
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(
    ambiguous.status === "ambiguous" ? ambiguous.candidates.length : 0,
    3,
  );

  const resolved = resolveResourceMention("每分钟 60 红电路", {
    products,
    names,
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(
    resolved.status === "resolved" ? resolved.target.id : undefined,
    "advanced-circuit",
  );

  const unavailable = resolveResourceMention("每分钟 60 蓝电路", {
    products: [["item", "electronic-circuit"]] as const,
    names,
  });
  assert.equal(unavailable.status, "unavailable");

  for (const [question, expected] of [
    ["每分钟 20 黑瓶", "military-science-pack"],
    ["每分钟 10 白瓶", "space-science-pack"],
    ["每分钟 30 硫磺", "sulfur"],
    ["每分钟 30 硫酸", "sulfuric-acid"],
    ["每分钟 30 电池", "battery"],
    ["每分钟 30 塑料", "plastic-bar"],
    ["每分钟 30 钢材", "steel-plate"],
  ] as const) {
    const match = resolveResourceMention(question, {
      products: [],
      names,
    });
    assert.equal(
      match.status === "resolved" ? match.target.id : match.status,
      expected,
      `${question} must resolve to ${expected}`,
    );
  }
});

function assertNoIdentifierDemand(answer: string, id: string): void {
  assert.doesNotMatch(
    answer,
    /prototype id|请提供.{0,6}(?:内部)?\s*id|internal id/iu,
    `${id} must never ask the player for a prototype ID`,
  );
}

async function readFixture(): Promise<ChatCalculationFixture> {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/chat-calculation.json", import.meta.url),
      "utf8",
    ),
  ) as ChatCalculationFixture;
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

async function createToolbox(
  fixture: ChatCalculationFixture,
  names?: LocalizedNameStore,
): Promise<AssistantToolbox> {
  const catalog = await readCatalog();
  const store = new CompanionStateStore();
  const packet: StaticSnapshotPacket = {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-chat-calculation-static",
    type: "static_snapshot",
    tick: 1,
    payload: {
      snapshot_id: "chat-calculation-static",
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
  assert.equal(store.acceptStaticSnapshotChunk(packet), true);

  const advisor = new AdvisorEngine(DEFAULT_ADVISOR_CONFIG, "zh-CN");
  return names === undefined
    ? new AssistantToolbox(store, advisor, "zh-CN")
    : new AssistantToolbox(store, advisor, "zh-CN", names);
}

function localizationPacket(): LocalizationUpdatePacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-chat-calculation-locale",
    type: "localization_update",
    tick: 2,
    payload: {
      locale: "zh-CN",
      reset: true,
      names: [
        { kind: "item", id: "pipe", name: "管道" },
        { kind: "item", id: "iron-plate", name: "铁板" },
        { kind: "item", id: "iron-gear-wheel", name: "铁齿轮" },
        { kind: "machine", id: "assembling-machine-2", name: "组装机 2 型" },
        { kind: "recipe", id: "pipe", name: "管道" },
      ],
    },
  };
}
