import { randomUUID } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";

import {
  ProtocolError,
  createAdvisorUpdatePacket,
  createHelloAckPacket,
  createResyncRequestPacket,
  createStateAckPacket,
  decodePacket,
  encodePacket,
  type ProtocolPacket,
} from "@factorio-ai-assistant/protocol";

import { AdvisorEngine } from "./advisor.js";
import { CompanionStateStore, StateSyncError } from "./state-store.js";

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
  stateStore?: CompanionStateStore;
  advisor?: AdvisorEngine;
}

export interface CompanionServer {
  readonly address: AddressInfo;
  readonly state: CompanionStateStore;
  readonly advisor: AdvisorEngine;
  close(): Promise<void>;
}

export async function startCompanionServer(
  options: CompanionServerOptions = {},
): Promise<CompanionServer> {
  const port = options.port ?? DEFAULT_COMPANION_PORT;
  assertBindablePort(port);

  const logger = options.logger ?? console;
  const stateStore = options.stateStore ?? new CompanionStateStore();
  const advisor = options.advisor ?? new AdvisorEngine();
  const socket = createSocket("udp4");

  socket.on("message", (datagram, remote) => {
    handleDatagram(socket, datagram, remote, logger, stateStore, advisor);
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
    state: stateStore,
    advisor,
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
  stateStore: CompanionStateStore,
  advisor: AdvisorEngine,
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

  switch (packet.type) {
    case "hello":
      if (packet.payload.advisor_config !== undefined) {
        advisor.configure(packet.payload.advisor_config);
      }
      sendPacket(
        socket,
        createHelloAckPacket({
          messageId: `companion-${randomUUID()}`,
          replyTo: packet.message_id,
          timestamp: Date.now(),
          companionVersion: COMPANION_VERSION,
          staticRevision: stateStore.staticRevision,
        }),
        remote,
        logger,
        `Acknowledged ${packet.message_id} for ${remote.address}:${remote.port}`,
      );
      return;
    case "static_snapshot": {
      let completed: boolean;

      try {
        completed = stateStore.acceptStaticSnapshotChunk(packet);
      } catch (error: unknown) {
        if (!(error instanceof StateSyncError)) {
          throw error;
        }

        requestResync(socket, remote, logger, error);
        return;
      }

      acknowledgeStatePacket(
        socket,
        remote,
        logger,
        packet.message_id,
        packet.payload.revision,
        completed
          ? `Accepted static snapshot ${packet.payload.snapshot_id} revision ${packet.payload.revision}`
          : undefined,
      );
      return;
    }
    case "static_delta":
      try {
        stateStore.acceptStaticDelta(packet);
      } catch (error: unknown) {
        if (!(error instanceof StateSyncError)) {
          throw error;
        }

        requestResync(socket, remote, logger, error);
        return;
      }

      acknowledgeStatePacket(
        socket,
        remote,
        logger,
        packet.message_id,
        packet.payload.revision,
        `Accepted static delta revision ${packet.payload.revision}`,
      );
      return;
    case "dynamic_snapshot":
      stateStore.acceptDynamicSnapshot(packet);
      for (const event of advisor.evaluate(packet, stateStore.staticState)) {
        sendPacket(
          socket,
          createAdvisorUpdatePacket({
            messageId: `companion-${randomUUID()}`,
            timestamp: Date.now(),
            event: event.type,
            proactive: event.proactive,
            alert: event.alert,
          }),
          remote,
          logger,
          `${event.type === "closed" ? "Closed" : "Emitted"} advisor alert ` +
            `${event.alert.id}${event.proactive ? " proactively" : ""}`,
        );
      }
      if (packet.payload.truncated) {
        logger.warn(
          `Accepted truncated dynamic snapshot ${packet.message_id}: ` +
            `${packet.payload.omitted_forces} forces and ` +
            `${packet.payload.omitted_series} series omitted`,
        );
      }
      return;
    case "hello_ack":
    case "state_ack":
    case "resync_request":
    case "advisor_update":
      logger.warn(`Ignored unexpected ${packet.type} packet ${packet.message_id}`);
  }
}

function acknowledgeStatePacket(
  socket: Socket,
  remote: RemoteInfo,
  logger: CompanionLogger,
  replyTo: string,
  revision: number,
  successMessage: string | undefined,
): void {
  sendPacket(
    socket,
    createStateAckPacket({
      messageId: `companion-${randomUUID()}`,
      replyTo,
      timestamp: Date.now(),
      revision,
    }),
    remote,
    logger,
    successMessage,
  );
}

function requestResync(
  socket: Socket,
  remote: RemoteInfo,
  logger: CompanionLogger,
  error: StateSyncError,
): void {
  logger.warn(`${error.message}; requesting a full static snapshot`);
  sendPacket(
    socket,
    createResyncRequestPacket({
      messageId: `companion-${randomUUID()}`,
      timestamp: Date.now(),
      expectedRevision: error.expectedRevision,
    }),
    remote,
    logger,
  );
}

function sendPacket(
  socket: Socket,
  packet: ProtocolPacket,
  remote: RemoteInfo,
  logger: CompanionLogger,
  successMessage?: string,
): void {
  socket.send(encodePacket(packet), remote.port, remote.address, (error) => {
    if (error !== null) {
      logger.error(`Failed to send ${packet.type} ${packet.message_id}: ${error.message}`);
      return;
    }

    if (successMessage !== undefined) {
      logger.info(successMessage);
    }
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
