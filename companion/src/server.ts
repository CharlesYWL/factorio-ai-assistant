import { randomUUID } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";

import {
  ProtocolError,
  createHelloAckPacket,
  decodePacket,
  encodePacket,
} from "@factorio-ai-assistant/protocol";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_COMPANION_PORT = 34_197;
export const COMPANION_VERSION = "0.1.0";

export interface CompanionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface CompanionServerOptions {
  port?: number;
  logger?: CompanionLogger;
}

export interface CompanionServer {
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export async function startCompanionServer(
  options: CompanionServerOptions = {},
): Promise<CompanionServer> {
  const port = options.port ?? DEFAULT_COMPANION_PORT;
  assertBindablePort(port);

  const logger = options.logger ?? console;
  const socket = createSocket("udp4");

  socket.on("message", (datagram, remote) => {
    handleDatagram(socket, datagram, remote, logger);
  });

  await bindSocket(socket, port);

  const address = socket.address();
  socket.on("error", (error) => {
    logger.error(`UDP socket error: ${error.message}`);
  });

  logger.info(`Companion listening on udp://${address.address}:${address.port}`);

  let closed = false;

  return {
    address,
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await new Promise<void>((resolve) => {
        socket.close(resolve);
      });
    },
  };
}

export function parseCompanionPort(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    return DEFAULT_COMPANION_PORT;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("FACTORIO_ASSISTANT_COMPANION_PORT must be an integer");
  }

  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("FACTORIO_ASSISTANT_COMPANION_PORT must be between 1 and 65535");
  }

  return port;
}

function handleDatagram(
  socket: Socket,
  datagram: Buffer,
  remote: RemoteInfo,
  logger: CompanionLogger,
): void {
  if (remote.address !== LOOPBACK_HOST) {
    logger.warn(`Ignored packet from non-loopback address ${remote.address}`);
    return;
  }

  let packet;

  try {
    packet = decodePacket(datagram);
  } catch (error: unknown) {
    if (!(error instanceof ProtocolError)) {
      throw error;
    }

    logger.warn(`Ignored invalid packet from ${remote.address}:${remote.port}: ${error.message}`);
    return;
  }

  if (packet.type !== "hello") {
    logger.warn(`Ignored unexpected ${packet.type} packet ${packet.message_id}`);
    return;
  }

  const response = createHelloAckPacket({
    messageId: `companion-${randomUUID()}`,
    replyTo: packet.message_id,
    timestamp: Date.now(),
    companionVersion: COMPANION_VERSION,
  });

  socket.send(encodePacket(response), remote.port, remote.address, (error) => {
    if (error !== null) {
      logger.error(`Failed to acknowledge ${packet.message_id}: ${error.message}`);
      return;
    }

    logger.info(`Acknowledged ${packet.message_id} for ${remote.address}:${remote.port}`);
  });
}

function bindSocket(socket: Socket, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      socket.off("error", onError);
      resolve();
    };

    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind({
      address: LOOPBACK_HOST,
      port,
      exclusive: true,
    });
  });
}

function assertBindablePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Companion UDP port must be between 0 and 65535");
  }
}
