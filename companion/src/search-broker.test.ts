import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type SearchResponsePacket,
} from "@factorio-ai-assistant/protocol";

import { SearchBroker } from "./search-broker.js";

function reply(replyTo: string, count = 3): SearchResponsePacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: "factorio-search-1",
    type: "search_response",
    timestamp: 1,
    payload: {
      reply_to: replyTo,
      clusters: [
        {
          x: 120,
          y: -64,
          count,
          ids: ["assembling-machine-3"],
          statuses: ["working"],
          unit: 4242,
        },
      ],
      total_matches: count,
      truncated: false,
    },
  };
}

void test("routes a reply to the request that asked for it", async () => {
  const broker = new SearchBroker();
  const sent: string[] = [];
  broker.useTransport({
    send: (packet) => {
      sent.push(packet.message_id);
      return true;
    },
  });

  const pending = broker.search("player", { recipe: "artillery-shell" });
  assert.equal(sent.length, 1);

  // Replies are matched by `reply_to`, because unrelated packets arrive in
  // between and arrival order proves nothing.
  assert.equal(broker.accept(reply("some-other-request")), false);
  assert.equal(broker.accept(reply(sent[0]!)), true);

  const response = await pending;
  assert.equal(response?.payload.total_matches, 3);
});

void test("gives up rather than hanging when the Mod never answers", async () => {
  const broker = new SearchBroker();
  broker.useTransport({ send: () => true });

  // A search that never resolves would burn the tool-loop deadline and leave
  // the player waiting on an answer that cannot arrive.
  const pending = broker.search("player", { recipe: "artillery-shell" });
  broker.reset();

  assert.equal(await pending, undefined);
});

void test("reports no search path when the game has never been seen", async () => {
  const broker = new SearchBroker();

  assert.equal(broker.available, false);
  assert.equal(await broker.search("player", { recipe: "iron-plate" }), undefined);
});

void test("treats a failed send as no result", async () => {
  const broker = new SearchBroker();
  broker.useTransport({ send: () => false });

  assert.equal(await broker.search("player", { recipe: "iron-plate" }), undefined);
});
