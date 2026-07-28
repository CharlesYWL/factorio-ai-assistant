import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_ADVISOR_CONFIG,
  MAX_PACKET_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  createAdvisorUpdatePacket,
  createHelloAckPacket,
  createHelloPacket,
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
  });

  assert.deepEqual(decodePacket(new TextEncoder().encode(encodePacket(packet))), packet);
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

function expectProtocolError(action: () => void, code: ProtocolErrorCode): void {
  try {
    action();
    assert.fail(`Expected ProtocolError with code ${code}`);
  } catch (error: unknown) {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
  }
}
