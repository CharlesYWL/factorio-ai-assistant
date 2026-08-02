import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type StaticSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import { AdvisorEngine } from "./advisor.js";
import {
  AssistantInputError,
  AssistantService,
  MAX_QUESTION_BYTES,
} from "./assistant-service.js";
import { resolveCompanionConfig } from "./config.js";
import type { CompanionLogger } from "./logger.js";
import {
  ProviderError,
  type AIProvider,
  type ProviderRequest,
} from "./providers.js";
import { CompanionStateStore } from "./state-store.js";

const silentLogger: CompanionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

void test("reports local mode when no model is configured", async () => {
  const service = createService(resolveCompanionConfig({}, {}));

  assert.equal(service.status.mode, "local");
  assert.equal(service.status.model, null);

  const answer = await service.answer({ question: "现在有什么问题？" });
  assert.equal(answer.mode, "local");
  assert.equal(answer.fallbackReason, "no_model_configured");
});

void test("returns the model's answer unmodified", async () => {
  // The Companion no longer rewrites, trims, or re-orders the answer; whatever
  // reasoning the model produced is what the player asked to see.
  const text =
    "黄瓶 10/min 需要 2 台组装机。\n上游铜线需求 583/min，约 2 台。\n合计 4 台。";
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete: () => Promise.resolve({ text, model: "test-model" }),
  };
  const service = createService(
    resolveCompanionConfig({ provider: "openclaw", model_retry_count: 0 }, {}),
    provider,
  );

  const answer = await service.answer({ question: "每分钟10个黄瓶要多少机器" });

  assert.equal(answer.mode, "model");
  assert.equal(answer.text, text);
  assert.equal(answer.model, "test-model");
});

void test("keeps numbers the model derived from the supplied recipes", async () => {
  // An earlier version rejected any number not copied verbatim from
  // precomputed evidence, which discarded correct arithmetic. Derived values
  // must survive.
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete: () =>
      Promise.resolve({
        text: "需要 0.933 台，向上取整 1 台；铜线 583.333/min。",
        model: "test-model",
      }),
  };
  const service = createService(
    resolveCompanionConfig({ provider: "openclaw", model_retry_count: 0 }, {}),
    provider,
  );

  const answer = await service.answer({ question: "每分钟10个黄瓶要多少机器" });

  assert.equal(answer.mode, "model");
  assert.match(answer.text, /0\.933/u);
  assert.match(answer.text, /583\.333/u);
});

void test("offers recipe tools and serves what the model asks for", async () => {
  const captured: ProviderRequest[] = [];
  let round = 0;
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete(request) {
      captured.push(request);
      round += 1;
      // First round: ask for a recipe. Second: answer with what came back.
      return round === 1
        ? Promise.resolve({
            text: "",
            model: "test-model",
            toolCalls: [
              {
                id: "call-1",
                name: "get_recipe",
                arguments: JSON.stringify({ ids: ["utility-science-pack"] }),
              },
            ],
          })
        : Promise.resolve({ text: "ok", model: "test-model" });
    },
  };
  const store = new CompanionStateStore();
  assert.equal(store.acceptStaticSnapshotChunk(staticPacket()), true);
  const service = new AssistantService({
    config: resolveCompanionConfig(
      { provider: "openclaw", model_retry_count: 0 },
      {},
    ),
    stateStore: store,
    advisor: new AdvisorEngine(),
    logger: silentLogger,
    provider,
  });

  const answer = await service.answer({
    question: "每分钟 10 个 utility-science-pack 要多少机器",
    forceId: "player",
  });

  const context = captured[0]?.context as Record<string, unknown>;
  const catalog = context.recipe_catalog as { recipes: Array<{ id: string }> };
  assert.ok(catalog.recipes.some((entry) => entry.id === "utility-science-pack"));
  assert.ok(catalog.recipes.some((entry) => entry.id === "copper-plate"));
  assert.ok(captured[0]?.tools !== undefined, "tools must be offered");

  // The looked-up recipe must be replayed, or the model answers blind.
  const replayed = captured[1]?.toolTurns?.[0];
  assert.equal(replayed?.calls[0]?.name, "get_recipe");
  assert.ok(replayed?.results[0]?.content.includes("utility-science-pack"));
  assert.equal(answer.text, "ok");
});

void test("stops calling tools after the round limit", async () => {
  let calls = 0;
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete(request) {
      calls += 1;
      // A model that never stops asking must not stall the request forever.
      return request.tools === undefined
        ? Promise.resolve({ text: "forced answer", model: "test-model" })
        : Promise.resolve({
            text: "",
            model: "test-model",
            toolCalls: [
              {
                id: `call-${calls}`,
                name: "search_recipes",
                arguments: JSON.stringify({ query: "science" }),
              },
            ],
          });
    },
  };
  const store = new CompanionStateStore();
  assert.equal(store.acceptStaticSnapshotChunk(staticPacket()), true);
  const service = new AssistantService({
    config: resolveCompanionConfig(
      { provider: "openclaw", model_retry_count: 0 },
      {},
    ),
    stateStore: store,
    advisor: new AdvisorEngine(),
    logger: silentLogger,
    provider,
  });

  const answer = await service.answer({
    question: "随便问问",
    forceId: "player",
  });

  assert.equal(answer.text, "forced answer");
  assert.ok(calls <= 5, `expected a bounded number of calls, got ${calls}`);
});

void test("falls back to known state when the provider fails", async () => {
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete: () =>
      Promise.reject(new ProviderError("unavailable", "offline", true)),
  };
  const service = createService(
    resolveCompanionConfig({ provider: "openclaw", model_retry_count: 0 }, {}),
    provider,
  );

  const answer = await service.answer({ question: "现在有什么问题？" });

  assert.equal(answer.mode, "local");
  assert.equal(answer.fallbackReason, "unavailable");
  assert.match(answer.text, /模型暂时不可用/u);
});

void test("falls back rather than returning an empty answer", async () => {
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete: () => Promise.resolve({ text: "   ", model: "test-model" }),
  };
  const service = createService(
    resolveCompanionConfig({ provider: "openclaw", model_retry_count: 0 }, {}),
    provider,
  );

  const answer = await service.answer({ question: "现在有什么问题？" });

  assert.equal(answer.mode, "local");
  assert.equal(answer.fallbackReason, "empty_response");
});

void test("propagates cancellation instead of answering", async () => {
  const controller = new AbortController();
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete: () =>
      Promise.reject(new ProviderError("cancelled", "cancelled", false)),
  };
  const service = createService(
    resolveCompanionConfig({ provider: "openclaw", model_retry_count: 0 }, {}),
    provider,
  );

  await assert.rejects(
    () =>
      service.answer({
        question: "现在有什么问题？",
        signal: controller.signal,
      }),
    ProviderError,
  );
});

void test("rejects malicious or oversized input before calling a provider", async () => {
  let calls = 0;
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete() {
      calls += 1;
      return Promise.resolve({ text: "ok", model: "test-model" });
    },
  };
  const service = createService(
    resolveCompanionConfig({ provider: "openclaw", model_retry_count: 0 }, {}),
    provider,
  );

  for (const question of [
    "",
    "   ",
    "a".repeat(MAX_QUESTION_BYTES + 1),
    "control\u0000character",
  ]) {
    await assert.rejects(
      () => service.answer({ question }),
      AssistantInputError,
      `${JSON.stringify(question)} must be rejected`,
    );
  }
  assert.equal(calls, 0);
});

void test("passes opted-in turns through to the model", async () => {
  let captured: ProviderRequest | undefined;
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete(request) {
      captured = request;
      return Promise.resolve({ text: "ok", model: "test-model" });
    },
  };
  const service = createService(
    resolveCompanionConfig({ provider: "openclaw", model_retry_count: 0 }, {}),
    provider,
  );

  await service.answer({
    question: "那铜板呢",
    history: [{ question: "绿板要多少铜线", answer: "180/min。" }],
  });

  const context = captured?.context as Record<string, unknown>;
  assert.deepEqual(context.recent_turns, [
    { question: "绿板要多少铜线", answer: "180/min。" },
  ]);
});

function createService(
  config: ReturnType<typeof resolveCompanionConfig>,
  provider?: AIProvider,
): AssistantService {
  return new AssistantService({
    config,
    stateStore: new CompanionStateStore(),
    advisor: new AdvisorEngine(),
    logger: silentLogger,
    ...(provider === undefined ? {} : { provider }),
  });
}

function staticPacket(): StaticSnapshotPacket {
  const recipe = (
    id: string,
    ingredients: Array<[string, number]>,
    amount = 1,
  ) => ({
    id,
    category: "crafting",
    energy_seconds: 1,
    ingredients: ingredients.map(([ingredientId, value]) => ({
      kind: "item" as const,
      id: ingredientId,
      amount: value,
    })),
    products: [{ kind: "item" as const, id, amount }],
    allowed_effects: [],
    allowed_module_categories: [],
    maximum_productivity: 4,
  });
  const recipes = [
    recipe("utility-science-pack", [["copper-cable", 5]], 3),
    recipe("copper-cable", [["copper-plate", 1]], 2),
    recipe("copper-plate", [["copper-ore", 1]]),
  ];

  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-static-1",
    type: "static_snapshot",
    tick: 1,
    payload: {
      snapshot_id: "static-1",
      revision: 1,
      chunk_index: 0,
      chunk_count: 1,
      truncated: false,
      omitted_records: 0,
      game: { version: "2.0.72", mods: [{ id: "base", version: "2.0.72" }] },
      forces: [
        {
          id: "player",
          researched_technologies: ["automation"],
          available_recipes: recipes.map(({ id }) => id),
          recipe_productivity_bonuses: [],
        },
      ],
      recipes,
      machines: [
        {
          id: "assembling-machine-3",
          kind: "assembling-machine",
          crafting_speed: 1.25,
          crafting_categories: ["crafting"],
          module_slots: 4,
          allowed_effects: [],
          allowed_module_categories: [],
        },
      ],
      modules: [],
    },
  };
}
