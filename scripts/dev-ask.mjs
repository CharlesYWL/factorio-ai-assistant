// Ad-hoc probe: sends a question to the running companion over the real UDP
// protocol and prints the answer, so a chat bug can be reproduced without
// clicking through the game UI.
import { createSocket } from "node:dgram";
import process from "node:process";

import {
  createAssistantRequestPacket,
  decodePacket,
} from "@factorio-ai-assistant/protocol";

// `--after "<previous question>|<previous answer>"` exercises the opt-in
// follow-up path without needing the in-game setting.
const afterIndex = process.argv.indexOf("--after");
const previousTurn =
  afterIndex === -1 ? undefined : process.argv[afterIndex + 1];
const history =
  previousTurn === undefined
    ? undefined
    : [
        {
          question: previousTurn.split("|")[0] ?? "",
          answer: previousTurn.split("|")[1] ?? "",
        },
      ];
const questionArgs =
  afterIndex === -1
    ? process.argv.slice(2)
    : [...process.argv.slice(2, afterIndex), ...process.argv.slice(afterIndex + 2)];

const question = questionArgs.join(" ");
if (question.length === 0) {
  process.stderr.write(
    'usage: node scripts/dev-ask.mjs <question> [--after "<prev question>|<prev answer>"]\n',
  );
  process.exit(1);
}

const COMPANION_PORT = Number(process.env.FACTORIO_ASSISTANT_COMPANION_PORT ?? 34_197);
const FORCE_ID = process.env.FACTORIO_ASSISTANT_FORCE_ID ?? "player";
const TIMEOUT_MS = 45_000;

const socket = createSocket("udp4");
const timer = setTimeout(() => {
  process.stderr.write("timed out waiting for the companion response\n");
  socket.close();
  process.exit(1);
}, TIMEOUT_MS);
timer.unref();

socket.on("message", (data) => {
  let packet;
  try {
    packet = decodePacket(data);
  } catch (error) {
    process.stderr.write(`undecodable packet: ${error.message}\n`);
    return;
  }
  if (packet.type !== "assistant_response") {
    return;
  }

  const payload = packet.payload;
  process.stdout.write(`state: ${payload.state}\n`);
  process.stdout.write(`mode: ${payload.mode ?? "-"}\n`);
  if (payload.fallback_reason !== undefined) {
    process.stdout.write(`fallback_reason: ${payload.fallback_reason}\n`);
  }
  process.stdout.write(`--- answer ---\n${payload.text ?? "(none)"}\n`);
  clearTimeout(timer);
  socket.close();
});

socket.bind(0, "127.0.0.1", () => {
  const packet = createAssistantRequestPacket({
    messageId: `dev-ask-${Date.now()}`,
    tick: 1,
    forceId: FORCE_ID,
    question,
    ...(history === undefined ? {} : { history }),
  });
  socket.send(
    Buffer.from(JSON.stringify(packet), "utf8"),
    COMPANION_PORT,
    "127.0.0.1",
  );
});
