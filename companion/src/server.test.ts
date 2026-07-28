import assert from "node:assert/strict";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  ADVISOR_RULE_IDS,
  DEFAULT_ADVISOR_CONFIG,
  MAX_PACKET_BYTES,
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  createAssistantCancelPacket,
  createAssistantRequestPacket,
  createHelloPacket,
  createLocalizationUpdatePacket,
  decodePacket,
  encodePacket,
  type DynamicSnapshotPacket,
} from "@factorio-ai-assistant/protocol";

import {
  LOOPBACK_HOST,
  parseCompanionPort,
  startCompanionServer,
  type CompanionLogger,
} from "./server.js";
import { AdvisorEngine } from "./advisor.js";
import type { AIProvider } from "./providers.js";
import { CompanionStateStore } from "./state-store.js";

const silentLogger: CompanionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

void test(
  "exchanges hello and hello_ack with a mock Factorio UDP client",
  { timeout: 3_000 },
  async (context) => {
    const companion = await startCompanionServer({
      port: 0,
      logger: silentLogger,
    });
    const factorio = createSocket("udp4");

    context.after(async () => {
      await closeSocket(factorio);
      await companion.close();
    });

    const factorioAddress = await bindSocket(factorio);
    assert.equal(companion.address.address, LOOPBACK_HOST);
    assert.equal(factorioAddress.address, LOOPBACK_HOST);

    const hello = createHelloPacket({
      messageId: "factorio-integration-1",
      tick: 600,
      modVersion: "0.1.0",
    });

    const responsePromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(hello),
      companion.address.port,
      companion.address.address,
    );

    const response = await responsePromise;
    const acknowledgement = decodePacket(response.datagram);

    assert.equal(response.remote.address, LOOPBACK_HOST);
    assert.equal(response.remote.port, companion.address.port);
    assert.equal(acknowledgement.type, "hello_ack");

    if (acknowledgement.type === "hello_ack") {
      assert.equal(acknowledgement.payload.reply_to, hello.message_id);
      assert.equal(acknowledgement.payload.companion_version, "0.1.0");
      assert.equal(acknowledgement.payload.static_revision, 0);
      assert.equal(acknowledgement.payload.sampling_interval_ticks, 300);
      assert.deepEqual(acknowledgement.payload.assistant_status, {
        mode: "local",
        provider: "local",
        reason: "deterministic rules and calculator only",
        privacy: "local-only",
      });
    }
  },
);

void test(
  "logs a component version mismatch while completing the handshake",
  { timeout: 3_000 },
  async (context) => {
    const warnings: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: CompanionLogger = {
      info: () => undefined,
      warn: (event, fields = {}) => warnings.push({ event, fields }),
      error: () => undefined,
    };
    const companion = await startCompanionServer({ port: 0, logger });
    const factorio = createSocket("udp4");
    context.after(async () => {
      await closeSocket(factorio);
      await companion.close();
    });
    await bindSocket(factorio);
    const hello = createHelloPacket({
      messageId: "factorio-version-mismatch",
      tick: 600,
      modVersion: "0.0.9",
    });

    const responsePromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(hello),
      companion.address.port,
      companion.address.address,
    );
    assert.equal(decodePacket((await responsePromise).datagram).type, "hello_ack");
    assert.deepEqual(warnings, [
      {
        event: "component_version_mismatch",
        fields: {
          mod_version: "0.0.9",
          companion_version: "0.1.0",
        },
      },
    ]);
  },
);

void test(
  "answers and cancels in-game assistant requests",
  { timeout: 3_000 },
  async (context) => {
    const stateStore = new CompanionStateStore();
    const advisor = new AdvisorEngine({
      ...DEFAULT_ADVISOR_CONFIG,
      muted_rules: ADVISOR_RULE_IDS.filter((id) => id !== "research-idle"),
      research_idle_ticks: 0,
    });
    const state = dynamicSnapshot(100, 1);
    stateStore.acceptDynamicSnapshot(state);
    advisor.evaluate(state);
    const provider: AIProvider = {
      kind: "ollama",
      complete(_request, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled by test")),
            { once: true },
          );
        });
      },
    };
    const companion = await startCompanionServer({
      port: 0,
      logger: silentLogger,
      provider,
      stateStore,
      advisor,
    });
    const factorio = createSocket("udp4");
    context.after(async () => {
      await closeSocket(factorio);
      await companion.close();
    });
    await bindSocket(factorio);

    const request = createAssistantRequestPacket({
      messageId: "factorio-assistant-cancel",
      tick: 600,
      forceId: "player",
      question: "请分析当前瓶颈",
    });
    const responsePromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(request),
      companion.address.port,
      companion.address.address,
    );
    await delay(10);
    await send(
      factorio,
      encodePacket(
        createAssistantCancelPacket({
          messageId: "factorio-assistant-cancel-action",
          tick: 601,
          requestId: request.message_id,
        }),
      ),
      companion.address.port,
      companion.address.address,
    );

    const response = decodePacket((await responsePromise).datagram);
    assert.equal(response.type, "assistant_response");
    if (response.type === "assistant_response") {
      assert.equal(response.payload.reply_to, request.message_id);
      assert.equal(response.payload.status, "cancelled");
    }
  },
);

void test(
  "ingests a static snapshot, acknowledges it, and advertises its revision",
  { timeout: 3_000 },
  async (context) => {
    const companion = await startCompanionServer({
      port: 0,
      logger: silentLogger,
    });
    const factorio = createSocket("udp4");

    context.after(async () => {
      await closeSocket(factorio);
      await companion.close();
    });

    await bindSocket(factorio);
    const staticPacket = await readFile(
      new URL(
        "../../packages/protocol/fixtures/vanilla-2.0-static-v2.json",
        import.meta.url,
      ),
      "utf8",
    );
    const stateAckPromise = receiveOne(factorio);
    await send(
      factorio,
      staticPacket,
      companion.address.port,
      companion.address.address,
    );

    const stateAck = decodePacket((await stateAckPromise).datagram);
    assert.equal(stateAck.type, "state_ack");
    assert.equal(companion.state.staticRevision, 1);

    const hello = createHelloPacket({
      messageId: "factorio-after-static",
      tick: 4_200,
      modVersion: "0.1.0",
    });
    const helloAckPromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(hello),
      companion.address.port,
      companion.address.address,
    );

    const helloAck = decodePacket((await helloAckPromise).datagram);
    assert.equal(helloAck.type, "hello_ack");
    if (helloAck.type === "hello_ack") {
      assert.equal(helloAck.payload.static_revision, 1);
    }
  },
);

void test(
  "evaluates configured rules and returns advisor updates to Factorio",
  { timeout: 3_000 },
  async (context) => {
    const companion = await startCompanionServer({
      port: 0,
      logger: silentLogger,
    });
    const factorio = createSocket("udp4");

    context.after(async () => {
      await closeSocket(factorio);
      await companion.close();
    });

    await bindSocket(factorio);
    const hello = createHelloPacket({
      messageId: "factorio-advisor-hello",
      tick: 100,
      modVersion: "0.1.0",
      advisorConfig: {
        ...DEFAULT_ADVISOR_CONFIG,
        muted_rules: ADVISOR_RULE_IDS.filter((id) => id !== "research-idle"),
        research_idle_ticks: 1,
        recovery_ticks: 1,
      },
    });
    const helloAckPromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(hello),
      companion.address.port,
      companion.address.address,
    );
    await helloAckPromise;

    await send(
      factorio,
      encodePacket(dynamicSnapshot(100, 1)),
      companion.address.port,
      companion.address.address,
    );
    const advisorUpdatePromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(dynamicSnapshot(101, 2)),
      companion.address.port,
      companion.address.address,
    );

    const update = decodePacket((await advisorUpdatePromise).datagram);
    assert.equal(update.type, "advisor_update");
    if (update.type === "advisor_update") {
      assert.equal(update.payload.event, "opened");
      assert.equal(update.payload.proactive, true);
      assert.equal(update.payload.alert.rule_id, "research-idle");
      assert.equal(update.payload.alert.first_seen, 100);
      assert.equal(update.payload.alert.last_seen, 101);
    }
    assert.equal(companion.advisor.activeAlerts.length, 1);
  },
);

void test("parses a configured port without allowing an external bind address", () => {
  assert.equal(parseCompanionPort(undefined), 34_197);
  assert.equal(parseCompanionPort(" 40000 "), 40_000);
  assert.throws(() => parseCompanionPort("0"), /between 1 and 65535/);
  assert.throws(() => parseCompanionPort("127.0.0.1:34197"), /must be an integer/);
});

void test(
  "replays the exact cached response for duplicate requests",
  { timeout: 3_000 },
  async (context) => {
    const companion = await startCompanionServer({
      port: 0,
      samplingIntervalTicks: 120,
      logger: silentLogger,
    });
    const factorio = createSocket("udp4");
    context.after(async () => {
      await closeSocket(factorio);
      await companion.close();
    });
    await bindSocket(factorio);
    const encoded = encodePacket(
      createHelloPacket({
        messageId: "factorio-duplicate",
        tick: 600,
        modVersion: "0.1.0",
      }),
    );

    const firstPromise = receiveOne(factorio);
    await send(
      factorio,
      encoded,
      companion.address.port,
      companion.address.address,
    );
    const first = (await firstPromise).datagram;
    const secondPromise = receiveOne(factorio);
    await send(
      factorio,
      encoded,
      companion.address.port,
      companion.address.address,
    );
    const second = (await secondPromise).datagram;

    assert.deepEqual(second, first);
    const response = decodePacket(second);
    assert.equal(response.type, "hello_ack");
    if (response.type === "hello_ack") {
      assert.equal(response.payload.sampling_interval_ticks, 120);
    }
  },
);

void test(
  "rejects conflicting message IDs and survives malformed input",
  { timeout: 3_000 },
  async (context) => {
    const warnings: string[] = [];
    const logger: CompanionLogger = {
      info: () => undefined,
      warn: (event) => warnings.push(event),
      error: () => undefined,
    };
    const companion = await startCompanionServer({ port: 0, logger });
    const factorio = createSocket("udp4");
    context.after(async () => {
      await closeSocket(factorio);
      await companion.close();
    });
    await bindSocket(factorio);
    const first = createHelloPacket({
      messageId: "factorio-conflict",
      tick: 600,
      modVersion: "0.1.0",
    });
    const responsePromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(first),
      companion.address.port,
      companion.address.address,
    );
    await responsePromise;

    await send(
      factorio,
      encodePacket({ ...first, tick: 601 }),
      companion.address.port,
      companion.address.address,
    );
    assert.equal(await receiveWithin(factorio, 50), undefined);
    assert.ok(warnings.includes("udp_message_id_conflict"));

    await send(
      factorio,
      Buffer.alloc(Math.min(MAX_PACKET_BYTES - 1, 8_192), "x"),
      companion.address.port,
      companion.address.address,
    );
    const healthyHello = createHelloPacket({
      messageId: "factorio-after-malicious-input",
      tick: 602,
      modVersion: "0.1.0",
    });
    const healthyResponsePromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(healthyHello),
      companion.address.port,
      companion.address.address,
    );
    assert.equal(
      decodePacket((await healthyResponsePromise).datagram).type,
      "hello_ack",
    );
  },
);

void test(
  "accepts localization updates and answers with localized names",
  { timeout: 3_000 },
  async (context) => {
    const companion = await startCompanionServer({
      port: 0,
      logger: silentLogger,
    });
    const factorio = createSocket("udp4");
    context.after(async () => {
      await closeSocket(factorio);
      await companion.close();
    });
    await bindSocket(factorio);

    assert.equal(companion.localization.locale, undefined);

    const update = createLocalizationUpdatePacket({
      messageId: "factorio-locale-integration",
      tick: 900,
      locale: "zh-CN",
      reset: true,
      names: [
        { kind: "item", id: "iron-plate", name: "铁板" },
        { kind: "fluid", id: "petroleum-gas", name: "石油气" },
      ],
    });

    await send(
      factorio,
      encodePacket(update),
      companion.address.port,
      companion.address.address,
    );

    // A localization update is fire-and-forget: the Companion must not reply.
    assert.equal(await receiveWithin(factorio, 100), undefined);
    assert.equal(companion.localization.locale, "zh-CN");
    assert.equal(companion.localization.display("item", "iron-plate"), "铁板");
    assert.equal(
      companion.localization.display("item", "uranium-ore"),
      "uranium-ore",
    );

    const healthyHello = createHelloPacket({
      messageId: "factorio-after-localization",
      tick: 960,
      modVersion: "0.1.0",
    });
    const responsePromise = receiveOne(factorio);
    await send(
      factorio,
      encodePacket(healthyHello),
      companion.address.port,
      companion.address.address,
    );
    const acknowledgement = decodePacket((await responsePromise).datagram);
    assert.equal(acknowledgement.type, "hello_ack");
    if (acknowledgement.type === "hello_ack") {
      // The Mod reconciles its own delivered count against this value, so a
      // restarted Companion re-receives every name instead of silently
      // falling back to prototype IDs.
      assert.equal(acknowledgement.payload.localized_name_count, 2);
    }
  },
);

function dynamicSnapshot(tick: number, sequence: number): DynamicSnapshotPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: `factorio-dynamic-${sequence}`,
    type: "dynamic_snapshot",
    tick,
    payload: {
      sample_interval_ticks: 1,
      sample_sequence: sequence,
      truncated: false,
      omitted_forces: 0,
      omitted_series: 0,
      forces: [
        {
          id: "player",
          research: null,
          items: [],
          fluids: [],
          power: {
            network_count: 1,
            generated_watts: 100,
            consumed_watts: 100,
            satisfaction_ratio: 1,
          },
        },
      ],
    },
  };
}

function bindSocket(socket: Socket): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, LOOPBACK_HOST, () => {
      socket.off("error", reject);
      resolve(socket.address());
    });
  });
}

function send(
  socket: Socket,
  data: string | Uint8Array,
  port: number,
  address: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.send(data, port, address, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function receiveOne(
  socket: Socket,
): Promise<{ datagram: Buffer; remote: RemoteInfo }> {
  return new Promise((resolve) => {
    socket.once("message", (datagram, remote) => {
      resolve({ datagram, remote });
    });
  });
}

function receiveWithin(socket: Socket, milliseconds: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const onMessage = (datagram: Buffer): void => {
      clearTimeout(timer);
      resolve(datagram);
    };
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      resolve(undefined);
    }, milliseconds);
    socket.once("message", onMessage);
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    socket.close(resolve);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
