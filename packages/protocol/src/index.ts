export const PROTOCOL_VERSION = 1 as const;
export const MAX_PACKET_BYTES = 16 * 1024;

export type ProtocolErrorCode =
  | "INVALID_ENCODING"
  | "PACKET_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_PACKET"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_TYPE";

export class ProtocolError extends Error {
  public readonly code: ProtocolErrorCode;

  public constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export interface HelloPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  message_id: string;
  type: "hello";
  tick: number;
  payload: {
    mod_version: string;
  };
}

export interface HelloAckPacket {
  protocol_version: typeof PROTOCOL_VERSION;
  message_id: string;
  type: "hello_ack";
  timestamp: number;
  payload: {
    reply_to: string;
    companion_version: string;
  };
}

export type ProtocolPacket = HelloPacket | HelloAckPacket;

interface HelloPacketInput {
  messageId: string;
  tick: number;
  modVersion: string;
}

interface HelloAckPacketInput {
  messageId: string;
  replyTo: string;
  timestamp: number;
  companionVersion: string;
}

export function createHelloPacket(input: HelloPacketInput): HelloPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    message_id: input.messageId,
    type: "hello",
    tick: input.tick,
    payload: {
      mod_version: input.modVersion,
    },
  };
}

export function createHelloAckPacket(input: HelloAckPacketInput): HelloAckPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    message_id: input.messageId,
    type: "hello_ack",
    timestamp: input.timestamp,
    payload: {
      reply_to: input.replyTo,
      companion_version: input.companionVersion,
    },
  };
}

export function encodePacket(packet: ProtocolPacket): string {
  let encoded: string;

  try {
    encoded = JSON.stringify(packet);
  } catch (error: unknown) {
    throw new ProtocolError(
      "INVALID_PACKET",
      `Packet cannot be serialized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return JSON.stringify(decodePacket(encoded));
}

export function decodePacket(input: string | Uint8Array): ProtocolPacket {
  const text = decodeInput(input);
  const byteLength = new TextEncoder().encode(text).byteLength;

  if (byteLength > MAX_PACKET_BYTES) {
    throw new ProtocolError(
      "PACKET_TOO_LARGE",
      `Packet is ${byteLength} bytes; maximum is ${MAX_PACKET_BYTES}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolError("INVALID_JSON", "Packet is not valid JSON");
  }

  const packet = readRecord(parsed, "packet");
  const version = readInteger(packet.protocol_version, "protocol_version");

  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      "UNSUPPORTED_VERSION",
      `Unsupported protocol_version ${version}; expected ${PROTOCOL_VERSION}`,
    );
  }

  const messageId = readNonEmptyString(packet.message_id, "message_id");
  const type = readNonEmptyString(packet.type, "type");
  const payload = readRecord(packet.payload, "payload");

  if (type === "hello") {
    return {
      protocol_version: PROTOCOL_VERSION,
      message_id: messageId,
      type,
      tick: readNonNegativeInteger(packet.tick, "tick"),
      payload: {
        mod_version: readNonEmptyString(payload.mod_version, "payload.mod_version"),
      },
    };
  }

  if (type === "hello_ack") {
    return {
      protocol_version: PROTOCOL_VERSION,
      message_id: messageId,
      type,
      timestamp: readNonNegativeInteger(packet.timestamp, "timestamp"),
      payload: {
        reply_to: readNonEmptyString(payload.reply_to, "payload.reply_to"),
        companion_version: readNonEmptyString(
          payload.companion_version,
          "payload.companion_version",
        ),
      },
    };
  }

  throw new ProtocolError("UNSUPPORTED_TYPE", `Unsupported message type "${type}"`);
}

function decodeInput(input: string | Uint8Array): string {
  if (typeof input === "string") {
    return input;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new ProtocolError("INVALID_ENCODING", "Packet is not valid UTF-8");
  }
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPacket(`${path} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw invalidPacket(`${path} must be a non-empty string of at most 128 characters`);
  }

  return value;
}

function readInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidPacket(`${path} must be a safe integer`);
  }

  return value;
}

function readNonNegativeInteger(value: unknown, path: string): number {
  const result = readInteger(value, path);

  if (result < 0) {
    throw invalidPacket(`${path} must be non-negative`);
  }

  return result;
}

function invalidPacket(message: string): ProtocolError {
  return new ProtocolError("INVALID_PACKET", message);
}
