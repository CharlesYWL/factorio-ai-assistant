import assert from "node:assert/strict";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  createHelloPacket,
  decodePacket,
  encodePacket,
} from "@factorio-ai-assistant/protocol";

import {
  LOOPBACK_HOST,
  parseCompanionPort,
  startCompanionServer,
  type CompanionLogger,
} from "./server.js";

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
    }
  },
);

void test("parses a configured port without allowing an external bind address", () => {
  assert.equal(parseCompanionPort(undefined), 34_197);
  assert.equal(parseCompanionPort(" 40000 "), 40_000);
  assert.throws(() => parseCompanionPort("0"), /between 1 and 65535/);
  assert.throws(() => parseCompanionPort("127.0.0.1:34197"), /must be an integer/);
});

function bindSocket(socket: Socket): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, LOOPBACK_HOST, () => {
      socket.off("error", reject);
      resolve(socket.address());
    });
  });
}

function send(socket: Socket, data: string, port: number, address: string): Promise<void> {
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

function closeSocket(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    socket.close(resolve);
  });
}
