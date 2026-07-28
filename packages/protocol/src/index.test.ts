import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  ProtocolError,
  createHelloAckPacket,
  createHelloPacket,
  decodePacket,
  encodePacket,
  type ProtocolErrorCode,
} from "./index.js";

void test("encodes and decodes hello packets", () => {
  const packet = createHelloPacket({
    messageId: "factorio-120-1",
    tick: 120,
    modVersion: "0.1.0",
  });

  assert.deepEqual(decodePacket(encodePacket(packet)), packet);
});

void test("encodes and decodes hello acknowledgements", () => {
  const packet = createHelloAckPacket({
    messageId: "companion-1",
    replyTo: "factorio-120-1",
    timestamp: 1_753_680_000_000,
    companionVersion: "0.1.0",
  });

  assert.deepEqual(decodePacket(new TextEncoder().encode(encodePacket(packet))), packet);
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

void test("rejects unknown protocol versions", () => {
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
