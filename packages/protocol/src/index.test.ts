import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_ADVISOR_CONFIG,
  MAX_PACKET_BYTES,
  MAX_SUGGESTED_ACTIONS,
  MAX_SUGGESTED_ACTION_TEXT_CHARACTERS,
  PROTOCOL_VERSION,
  ProtocolError,
  createAdvisorUpdatePacket,
  createAssistantCancelPacket,
  createAssistantRequestPacket,
  createAssistantResponsePacket,
  createCalculationRequestPacket,
  createCalculationResponsePacket,
  createHelloAckPacket,
  createHelloPacket,
  createLocalizationUpdatePacket,
  createResyncRequestPacket,
  createStateAckPacket,
  decodePacket,
  encodePacket,
  type ProtocolErrorCode,
} from "./index.js";

const fixtureDirectory = new URL("../fixtures/", import.meta.url);

void test("encodes and decodes hello packets", () => {
  const packet = createHelloPacket({
    messageId: "factorio-120-1",
    tick: 120,
    modVersion: "0.1.0",
  });

  assert.deepEqual(decodePacket(encodePacket(packet)), packet);
});

void test("encodes advisor configuration and lifecycle updates", () => {
  const hello = createHelloPacket({
    messageId: "factorio-advisor-config",
    tick: 120,
    modVersion: "0.1.0",
    advisorConfig: DEFAULT_ADVISOR_CONFIG,
  });
  const update = createAdvisorUpdatePacket({
    messageId: "companion-advisor-1",
    timestamp: 1_753_680_000_000,
    event: "opened",
    proactive: true,
    alert: {
      id: "power-low:player",
      rule_id: "power-low",
      force_id: "player",
      severity: "critical",
      evidence: "Power satisfaction is 40%.",
      recommendation: "Add generation.",
      first_seen: 600,
      last_seen: 1_200,
    },
  });

  assert.deepEqual(decodePacket(encodePacket(hello)), hello);
  assert.deepEqual(decodePacket(encodePacket(update)), update);
});

void test("normalizes Factorio empty Lua tables in array-valued fields", () => {
  const hello = createHelloPacket({
    messageId: "factorio-empty-lua-array",
    tick: 120,
    modVersion: "0.1.0",
    advisorConfig: DEFAULT_ADVISOR_CONFIG,
  });
  const factorioEncoded = JSON.stringify({
    ...hello,
    payload: {
      ...hello.payload,
      advisor_config: {
        ...hello.payload.advisor_config,
        muted_rules: {},
      },
    },
  });

  assert.deepEqual(decodePacket(factorioEncoded), hello);

  const malformed = JSON.stringify({
    ...hello,
    payload: {
      ...hello.payload,
      advisor_config: {
        ...hello.payload.advisor_config,
        muted_rules: { unexpected: true },
      },
    },
  });
  expectProtocolError(() => decodePacket(malformed), "INVALID_PACKET");
});

void test("rejects inconsistent advisor configuration and alert lifetimes", () => {
  const hello = createHelloPacket({
    messageId: "factorio-advisor-invalid",
    tick: 120,
    modVersion: "0.1.0",
    advisorConfig: {
      ...DEFAULT_ADVISOR_CONFIG,
      critical_power_threshold: 0.95,
      power_satisfaction_threshold: 0.9,
    },
  });
  expectProtocolError(() => decodePacket(JSON.stringify(hello)), "INVALID_PACKET");

  const update = createAdvisorUpdatePacket({
    messageId: "companion-advisor-invalid",
    timestamp: 1_753_680_000_000,
    event: "closed",
    proactive: false,
    alert: {
      id: "research-idle:player",
      rule_id: "research-idle",
      force_id: "player",
      severity: "info",
      evidence: "No research.",
      recommendation: "Queue research.",
      first_seen: 1_200,
      last_seen: 600,
    },
  });
  expectProtocolError(() => decodePacket(JSON.stringify(update)), "INVALID_PACKET");
});

void test("encodes state-aware hello acknowledgements", () => {
  const packet = createHelloAckPacket({
    messageId: "companion-1",
    replyTo: "factorio-120-1",
    timestamp: 1_753_680_000_000,
    companionVersion: "0.1.0",
    staticRevision: 4,
    samplingIntervalTicks: 120,
    assistantStatus: {
      mode: "local",
      provider: "local",
      reason: "deterministic rules and deterministic calculations only",
      privacy: "local-only",
    },
    localizedNameCount: 42,
  });

  assert.deepEqual(decodePacket(new TextEncoder().encode(encodePacket(packet))), packet);
  assert.equal(packet.payload.localized_name_count, 42);

  const withoutNames = createHelloAckPacket({
    messageId: "companion-2",
    replyTo: "factorio-120-1",
    timestamp: 1_753_680_000_000,
    companionVersion: "0.1.0",
  });

  assert.equal(withoutNames.payload.localized_name_count, undefined);
  assert.deepEqual(decodePacket(encodePacket(withoutNames)), withoutNames);
});

void test("encodes assistant and calculation UI packets", () => {
    const assistantRequest = createAssistantRequestPacket({
      messageId: "factorio-assistant-1",
      tick: 600,
      forceId: "player",
      question: "现在最大的瓶颈是什么？",
    });
    const assistantCancel = createAssistantCancelPacket({
      messageId: "factorio-cancel-1",
      tick: 601,
      requestId: assistantRequest.message_id,
    });
    const assistantResponse = createAssistantResponsePacket({
      messageId: "companion-assistant-1",
      timestamp: 1_753_680_000_000,
      reply_to: assistantRequest.message_id,
      status: "ok",
      mode: "local",
      text: "当前没有活动告警。",
      fallback_reason: "local_mode",
    });
    const calculationRequest = createCalculationRequestPacket({
      messageId: "factorio-calculation-1",
      tick: 602,
      forceId: "player",
      targetKind: "item",
      targetId: "chemical-science-pack",
      ratePerMinute: 45,
      machineId: "assembling-machine-2",
      moduleIds: ["speed-module"],
    });
    const calculationResponse = createCalculationResponsePacket({
      messageId: "companion-calculation-1",
      timestamp: 1_753_680_000_001,
      reply_to: calculationRequest.message_id,
      status: "ok",
      result: {
        target: {
          kind: "item",
          id: "chemical-science-pack",
          per_minute: 45,
        },
        recipes: [
          {
            recipe_id: "chemical-science-pack",
            machine_id: "assembling-machine-2",
            machines_exact: 3.5,
            machines_rounded_up: 4,
            module_ids: ["speed-module"],
          },
        ],
        external_inputs: [],
        byproducts: [],
        rounding: "Exact counts are shown with a rounded-up build count.",
        truncated: false,
      },
    });

    for (const packet of [
      assistantRequest,
      assistantCancel,
      assistantResponse,
      calculationRequest,
      calculationResponse,
    ]) {
      assert.deepEqual(decodePacket(encodePacket(packet)), packet);
    }
});

void test("rejects inconsistent UI response states", () => {
    const response = createAssistantResponsePacket({
      messageId: "companion-invalid-assistant",
      timestamp: 1_753_680_000_000,
      reply_to: "factorio-assistant-1",
      status: "ok",
      mode: "local",
    });

    expectProtocolError(
      () => decodePacket(JSON.stringify(response)),
      "INVALID_PACKET",
    );
    expectProtocolError(
      () =>
        decodePacket(
          JSON.stringify({
            ...createCalculationResponsePacket({
              messageId: "companion-invalid-calculation",
              timestamp: 1_753_680_000_000,
              reply_to: "factorio-calculation-1",
              status: "error",
              error_code: "STATE_UNAVAILABLE",
              error_message: "No state",
            }),
            payload: {
              reply_to: "factorio-calculation-1",
              status: "error",
            },
          }),
        ),
      "INVALID_PACKET",
    );
});

void test("carries optional grounded suggestions on a successful answer", () => {
  const response = createAssistantResponsePacket({
    messageId: "companion-assistant-actions",
    timestamp: 1_753_680_000_000,
    reply_to: "factorio-assistant-1",
    status: "ok",
    mode: "model",
    text: "电力是当前的限制项 [A1]",
    suggested_actions: [
      { action_id: "alert-3f2a19bc", text: "增加锅炉和蒸汽机。", source: "alert" },
      { action_id: "model-91b6cd04", text: "电力是当前的限制项", source: "model" },
    ],
  });

  assert.deepEqual(decodePacket(encodePacket(response)), response);
  assert.equal(response.payload.suggested_actions?.length, 2);

  const withoutActions = createAssistantResponsePacket({
    messageId: "companion-assistant-plain",
    timestamp: 1_753_680_000_001,
    reply_to: "factorio-assistant-2",
    status: "ok",
    mode: "local",
    text: "当前没有活动告警。",
    suggested_actions: [],
  });
  assert.equal(
    Object.hasOwn(withoutActions.payload, "suggested_actions"),
    false,
    "An empty suggestion list must stay off the wire",
  );

  const capped = createAssistantResponsePacket({
    messageId: "companion-assistant-capped",
    timestamp: 1_753_680_000_002,
    reply_to: "factorio-assistant-3",
    status: "ok",
    mode: "local",
    text: "四条建议只发前三条。",
    suggested_actions: [1, 2, 3, 4].map((index) => ({
      action_id: `guide-0000000${index}`,
      text: `step ${index}`,
      source: "guide" as const,
    })),
  });
  assert.equal(capped.payload.suggested_actions?.length, MAX_SUGGESTED_ACTIONS);

  // The limit is characters on both sides of the wire: a Chinese suggestion of
  // the documented length is three times as many bytes and must still pass.
  const chinese = createAssistantResponsePacket({
    messageId: "companion-assistant-chinese",
    timestamp: 1_753_680_000_003,
    reply_to: "factorio-assistant-4",
    status: "ok",
    mode: "local",
    text: "长建议。",
    suggested_actions: [
      {
        action_id: "guide-0000000f",
        text: "补".repeat(MAX_SUGGESTED_ACTION_TEXT_CHARACTERS),
        source: "guide",
      },
    ],
  });
  assert.deepEqual(decodePacket(encodePacket(chinese)), chinese);
  assert.equal(
    Buffer.byteLength(
      chinese.payload.suggested_actions?.[0]?.text ?? "",
      "utf8",
    ),
    MAX_SUGGESTED_ACTION_TEXT_CHARACTERS * 3,
  );
});

void test("rejects suggestions that could not become a safe todo", () => {
  const base = createAssistantResponsePacket({
    messageId: "companion-assistant-bad-actions",
    timestamp: 1_753_680_000_000,
    reply_to: "factorio-assistant-1",
    status: "ok",
    mode: "local",
    text: "答案正文。",
  });
  const withActions = (actions: unknown): string =>
    JSON.stringify({
      ...base,
      payload: { ...base.payload, suggested_actions: actions },
    });

  for (const actions of [
    [{ action_id: "guide 0001", text: "spaced id", source: "guide" }],
    [{ action_id: "guide-0001", text: "unknown source", source: "provider" }],
    [{ action_id: "guide-0001", text: "", source: "guide" }],
    [{ action_id: "guide-0001", text: "control\u0007char", source: "guide" }],
    [{ action_id: "guide-0001", text: "a".repeat(321), source: "guide" }],
    [{ action_id: "a".repeat(65), text: "long id", source: "guide" }],
    [
      { action_id: "guide-0001", text: "first", source: "guide" },
      { action_id: "guide-0001", text: "duplicate id", source: "guide" },
    ],
    [1, 2, 3, 4].map((index) => ({
      action_id: `guide-000${index}`,
      text: `step ${index}`,
      source: "guide",
    })),
    "not-an-array",
    [{ text: "no id", source: "guide" }],
  ]) {
    expectProtocolError(
      () => decodePacket(withActions(actions)),
      "INVALID_PACKET",
    );
  }

  const cancelled = createAssistantResponsePacket({
    messageId: "companion-assistant-cancelled",
    timestamp: 1_753_680_000_000,
    reply_to: "factorio-assistant-1",
    status: "cancelled",
  });
  expectProtocolError(
    () =>
      decodePacket(
        JSON.stringify({
          ...cancelled,
          payload: {
            ...cancelled.payload,
            suggested_actions: [
              { action_id: "guide-0001", text: "step", source: "guide" },
            ],
          },
        }),
      ),
    "INVALID_PACKET",
  );
});

void test("decodes assistant answers with and without suggested actions", async () => {
  for (const fileName of [
    "assistant-response-legacy.json",
    "assistant-response-suggested-actions.json",
  ]) {
    const encoded = await readFile(new URL(fileName, fixtureDirectory), "utf8");
    const fixture = JSON.parse(encoded) as unknown;

    assert.deepEqual(decodePacket(encoded), fixture);
  }

  const legacy = decodePacket(
    await readFile(
      new URL("assistant-response-legacy.json", fixtureDirectory),
      "utf8",
    ),
  );
  assert.equal(legacy.type, "assistant_response");
  assert.equal(
    legacy.payload.suggested_actions,
    undefined,
    "A pre-todo Companion answer must still decode",
  );

  const current = decodePacket(
    await readFile(
      new URL("assistant-response-suggested-actions.json", fixtureDirectory),
      "utf8",
    ),
  );
  assert.equal(current.type, "assistant_response");
  assert.deepEqual(
    current.payload.suggested_actions?.map(({ source }) => source),
    ["alert", "calculation", "model"],
  );
});

void test("validates the optional companion sampling interval", () => {
  const packet = createHelloAckPacket({
    messageId: "companion-sampling",
    replyTo: "factorio-sampling",
    timestamp: 1_753_680_000_000,
    companionVersion: "0.1.0",
    samplingIntervalTicks: 60,
  });
  assert.deepEqual(decodePacket(encodePacket(packet)), packet);

  expectProtocolError(
    () =>
      decodePacket(
        JSON.stringify({
          ...packet,
          payload: { ...packet.payload, sampling_interval_ticks: 59 },
        }),
      ),
    "INVALID_PACKET",
  );
});

void test("encodes state acknowledgements and resync requests", () => {
  const acknowledgement = createStateAckPacket({
    messageId: "companion-ack-1",
    replyTo: "factorio-static-1",
    timestamp: 1_753_680_000_000,
    revision: 2,
  });
  const resync = createResyncRequestPacket({
    messageId: "companion-resync-1",
    timestamp: 1_753_680_000_001,
    expectedRevision: 2,
  });

  assert.deepEqual(decodePacket(encodePacket(acknowledgement)), acknowledgement);
  assert.deepEqual(decodePacket(encodePacket(resync)), resync);
});

void test("validates representative Factorio 2.0 static and dynamic fixtures", async () => {
  for (const fileName of [
    "vanilla-2.0-static-v2.json",
    "vanilla-2.0-dynamic-v2.json",
  ]) {
    const encoded = await readFile(new URL(fileName, fixtureDirectory), "utf8");
    const fixture = JSON.parse(encoded) as unknown;
    const decoded = decodePacket(encoded);

    assert.deepEqual(decoded, fixture);
    assert.ok(Buffer.byteLength(encodePacket(decoded), "utf8") <= MAX_PACKET_BYTES);
  }
});

void test("normalizes an omitted Factorio research field to null", async () => {
  const encoded = await readFile(
    new URL("vanilla-2.0-dynamic-v2.json", fixtureDirectory),
    "utf8",
  );
  const fixture = JSON.parse(encoded) as Record<string, unknown>;
  const payload = fixture.payload as Record<string, unknown>;
  const forces = payload.forces as Array<Record<string, unknown>>;
  const firstForce = forces[0];

  assert.ok(firstForce !== undefined);
  delete firstForce.research;
  firstForce.items = {};
  firstForce.fluids = {};

  const decoded = decodePacket(JSON.stringify(fixture));
  assert.equal(decoded.type, "dynamic_snapshot");
  assert.equal(decoded.payload.forces[0]?.research, null);
  assert.deepEqual(decoded.payload.forces[0]?.items, []);
  assert.deepEqual(decoded.payload.forces[0]?.fluids, []);
});

void test("ignores unknown fields while retaining strict known-field validation", async () => {
  const encoded = await readFile(
    new URL("vanilla-2.0-dynamic-v2.json", fixtureDirectory),
    "utf8",
  );
  const fixture = JSON.parse(encoded) as Record<string, unknown>;
  const payload = fixture.payload as Record<string, unknown>;
  const forces = payload.forces as Array<Record<string, unknown>>;
  const firstForce = forces[0];

  assert.ok(firstForce !== undefined);
  fixture.future_envelope_field = "ignored";
  payload.future_payload_field = { version: 2 };
  firstForce.future_force_field = true;

  const decoded = decodePacket(JSON.stringify(fixture));
  assert.equal("future_envelope_field" in decoded, false);
  assert.equal("future_payload_field" in decoded.payload, false);

  const decodedForce =
    decoded.type === "dynamic_snapshot" ? decoded.payload.forces[0] : undefined;
  assert.ok(decodedForce !== undefined);
  assert.equal("future_force_field" in decodedForce, false);
});

void test("accepts Factorio prototype identifiers up to its documented limit", async () => {
  const encoded = await readFile(
    new URL("vanilla-2.0-dynamic-v2.json", fixtureDirectory),
    "utf8",
  );
  const fixture = JSON.parse(encoded) as Record<string, unknown>;
  const payload = fixture.payload as Record<string, unknown>;
  const forces = payload.forces as Array<Record<string, unknown>>;
  const firstForce = forces[0];
  assert.ok(firstForce !== undefined);
  const items = firstForce.items as Array<Record<string, unknown>>;
  const firstItem = items[0];
  assert.ok(firstItem !== undefined);

  firstItem.id = "x".repeat(200);
  assert.equal(decodePacket(JSON.stringify(fixture)).type, "dynamic_snapshot");

  firstItem.id = "x".repeat(257);
  expectProtocolError(() => decodePacket(JSON.stringify(fixture)), "INVALID_PACKET");
});

void test("rejects malformed known state fields safely", async () => {
  const encoded = await readFile(
    new URL("vanilla-2.0-dynamic-v2.json", fixtureDirectory),
    "utf8",
  );
  const fixture = JSON.parse(encoded) as Record<string, unknown>;
  const payload = fixture.payload as Record<string, unknown>;
  const forces = payload.forces as Array<Record<string, unknown>>;
  const firstForce = forces[0];

  assert.ok(firstForce !== undefined);
  const power = firstForce.power as Record<string, unknown>;
  power.satisfaction_ratio = "full";

  expectProtocolError(() => decodePacket(JSON.stringify(fixture)), "INVALID_PACKET");
});

void test("validates production timing while preserving signed force bonuses", async () => {
  const encoded = await readFile(
    new URL("vanilla-2.0-static-v2.json", fixtureDirectory),
    "utf8",
  );
  const fixture = JSON.parse(encoded) as Record<string, unknown>;
  const payload = fixture.payload as Record<string, unknown>;
  const forces = payload.forces as Array<Record<string, unknown>>;
  const bonuses = forces[0]?.recipe_productivity_bonuses as Array<
    Record<string, unknown>
  >;
  const recipes = payload.recipes as Array<Record<string, unknown>>;
  const firstBonus = bonuses[0];
  const firstRecipe = recipes[0];
  assert.ok(firstBonus !== undefined);
  assert.ok(firstRecipe !== undefined);

  firstBonus.bonus = -0.1;
  const decoded = decodePacket(JSON.stringify(fixture));
  assert.equal(decoded.type, "static_snapshot");
  assert.equal(
    decoded.payload.forces[0]?.recipe_productivity_bonuses[0]?.bonus,
    -0.1,
  );

  firstRecipe.energy_seconds = 0;
  expectProtocolError(() => decodePacket(JSON.stringify(fixture)), "INVALID_PACKET");
});

void test("enforces the datagram hard limit before parsing", () => {
  const oversized = " ".repeat(MAX_PACKET_BYTES + 1);
  expectProtocolError(() => decodePacket(oversized), "PACKET_TOO_LARGE");
});

void test("rejects malformed JSON packets", () => {
  expectProtocolError(() => decodePacket('{"type":'), "INVALID_JSON");
});

void test("rejects structurally invalid packets", () => {
  expectProtocolError(
    () =>
      decodePacket(
        JSON.stringify({
          protocol_version: PROTOCOL_VERSION,
          message_id: "factorio-1-1",
          type: "hello",
          tick: 1,
          payload: {},
        }),
      ),
    "INVALID_PACKET",
  );
});

void test("rejects unknown protocol and state schema versions", async () => {
  expectProtocolError(
    () =>
      decodePacket(
        JSON.stringify({
          protocol_version: 999,
          message_id: "future-1",
          type: "hello",
          tick: 1,
          payload: {
            mod_version: "0.1.0",
          },
        }),
      ),
    "UNSUPPORTED_VERSION",
  );

  const encoded = await readFile(
    new URL("vanilla-2.0-dynamic-v2.json", fixtureDirectory),
    "utf8",
  );
  const fixture = JSON.parse(encoded) as Record<string, unknown>;
  fixture.schema_version = 999;

  expectProtocolError(
    () => decodePacket(JSON.stringify(fixture)),
    "UNSUPPORTED_SCHEMA_VERSION",
  );
});

void test("rejects invalid static chunk and delta ordering", async () => {
  const encoded = await readFile(
    new URL("vanilla-2.0-static-v2.json", fixtureDirectory),
    "utf8",
  );
  const fixture = JSON.parse(encoded) as Record<string, unknown>;
  const payload = fixture.payload as Record<string, unknown>;
  payload.chunk_index = 1;

  expectProtocolError(() => decodePacket(JSON.stringify(fixture)), "INVALID_PACKET");

  payload.chunk_index = 0;
  fixture.type = "static_delta";
  fixture.payload = {
    base_revision: 2,
    revision: 4,
    force: {
      id: "player",
      researched_technologies_added: [],
      researched_technologies_removed: [],
      available_recipes_added: [],
      available_recipes_removed: [],
      recipe_productivity_bonuses: [],
    },
  };

  expectProtocolError(() => decodePacket(JSON.stringify(fixture)), "INVALID_PACKET");
});

void test("encodes and decodes localization updates in both locales", async () => {
  for (const [locale, fileName] of [
    ["zh-CN", "vanilla-2.0-localization-zh-CN.json"],
    ["en", "vanilla-2.0-localization-en.json"],
  ] as const) {
    const encoded = await readFile(
      new URL(fileName, fixtureDirectory),
      "utf8",
    );
    const packet = decodePacket(encoded);

    assert.equal(packet.type, "localization_update");
    if (packet.type !== "localization_update") {
      return;
    }
    assert.equal(packet.payload.locale, locale);
    assert.equal(packet.payload.reset, true);
    assert.ok(
      Buffer.byteLength(encodePacket(packet), "utf8") <= MAX_PACKET_BYTES,
    );
    assert.deepEqual(decodePacket(encodePacket(packet)), packet);

    const ids = new Set(
      packet.payload.names.map((entry) => `${entry.kind}:${entry.id}`),
    );
    for (const key of [
      "item:iron-plate",
      "item:copper-plate",
      "item:steel-plate",
      "item:electronic-circuit",
      "item:advanced-circuit",
      "item:processing-unit",
      "item:automation-science-pack",
      "item:logistic-science-pack",
      "item:military-science-pack",
      "item:chemical-science-pack",
      "item:production-science-pack",
      "item:utility-science-pack",
      "item:space-science-pack",
      "fluid:heavy-oil",
      "fluid:light-oil",
      "fluid:petroleum-gas",
      "machine:assembling-machine-2",
    ]) {
      assert.ok(ids.has(key), `${fileName} must cover ${key}`);
    }
  }
});

void test("rejects malformed localization updates", () => {
  const packet = createLocalizationUpdatePacket({
    messageId: "factorio-locale-1",
    tick: 60,
    locale: "zh-CN",
    reset: false,
    names: [{ kind: "item", id: "iron-plate", name: "铁板" }],
  });

  assert.deepEqual(decodePacket(encodePacket(packet)), packet);

  expectProtocolError(
    () =>
      decodePacket(
        JSON.stringify({
          ...packet,
          payload: {
            ...packet.payload,
            names: [
              { kind: "item", id: "iron-plate", name: "铁板" },
              { kind: "item", id: "iron-plate", name: "Iron plate" },
            ],
          },
        }),
      ),
    "INVALID_PACKET",
  );

  expectProtocolError(
    () =>
      decodePacket(
        JSON.stringify({
          ...packet,
          payload: {
            ...packet.payload,
            names: [{ kind: "surface", id: "nauvis", name: "纳维斯" }],
          },
        }),
      ),
    "INVALID_PACKET",
  );

  expectProtocolError(
    () =>
      decodePacket(
        JSON.stringify({
          ...packet,
          payload: { ...packet.payload, locale: "" },
        }),
      ),
    "INVALID_PACKET",
  );
});

function expectProtocolError(action: () => void, code: ProtocolErrorCode): void {  try {
    action();
    assert.fail(`Expected ProtocolError with code ${code}`);
  } catch (error: unknown) {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
  }
}
