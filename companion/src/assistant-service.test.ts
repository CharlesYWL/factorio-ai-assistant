import assert from "node:assert/strict";
import test from "node:test";

import type { ProductionResult } from "@factorio-ai-assistant/calculator";

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

void test("starts in explicit local mode without a key", async () => {
  const service = createService(resolveCompanionConfig({}, {}));

  assert.deepEqual(service.status, {
    mode: "local",
    provider: "local",
    model: null,
    reason: "deterministic rules and calculator only",
  });
  const answer = await service.answer({ question: "现在有什么问题？" });
  assert.equal(answer.mode, "local");
  assert.equal(answer.fallbackReason, "local_mode");
  assert.match(answer.text, /本地模式/);
});

void test("returns deterministic calculation output when the provider is unavailable", async () => {
  let calls = 0;
  const provider: AIProvider = {
    kind: "openai-compatible",
    complete() {
      calls += 1;
      return Promise.reject(
        new ProviderError("unavailable", "offline", true),
      );
    },
  };
  const service = createService(
    resolveCompanionConfig(
      {
        provider: "openclaw",
        model_retry_count: 0,
      },
      {},
    ),
    provider,
  );

  const answer = await service.answer({
    question: "45 蓝瓶每分钟需要多少机器？",
    calculation: productionResult(),
  });

  assert.equal(calls, 1);
  assert.equal(answer.mode, "local");
  assert.equal(answer.fallbackReason, "unavailable");
  assert.match(answer.text, /chemical-science-pack 45\/min/);
  assert.match(answer.text, /3.5 \(4 rounded up\)/);
});

void test("passes only compact, budgeted context to a successful provider", async () => {
  let captured: ProviderRequest | undefined;
  const provider: AIProvider = {
    kind: "ollama",
    complete(request) {
      captured = request;
      return Promise.resolve({ text: "Model answer", model: "mock-model" });
    },
  };
  const service = createService(
    resolveCompanionConfig(
      {
        provider: "ollama",
        context_budget_bytes: 2_048,
      },
      {},
    ),
    provider,
  );

  const answer = await service.answer({
    question: "How many machines?",
    calculation: productionResult(),
  });

  assert.equal(answer.mode, "model");
  assert.equal(answer.text, "Model answer");
  assert.ok(captured !== undefined);
  assert.ok(
    Buffer.byteLength(JSON.stringify(captured.context), "utf8") <= 2_048,
  );
  assert.equal(
    JSON.stringify(captured.context).includes("effective_crafting_speed"),
    false,
  );
});

void test("rejects malicious or oversized input before calling a provider", async () => {
  let calls = 0;
  const provider: AIProvider = {
    kind: "ollama",
    complete() {
      calls += 1;
      return Promise.resolve({ text: "unexpected", model: "mock" });
    },
  };
  const service = createService(
    resolveCompanionConfig({ provider: "ollama" }, {}),
    provider,
  );

  await assert.rejects(
    service.answer({ question: `bad\u0000input` }),
    AssistantInputError,
  );
  await assert.rejects(
    service.answer({ question: "界".repeat(MAX_QUESTION_BYTES) }),
    AssistantInputError,
  );
  assert.equal(calls, 0);
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
