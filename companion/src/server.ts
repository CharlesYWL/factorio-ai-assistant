import { createHash, randomUUID } from "node:crypto";
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
import { AssistantService } from "./assistant-service.js";
import {
  DEFAULT_COMPANION_PORT,
  LOOPBACK_HOST,
  parseCompanionPort,
  resolveCompanionConfig,
  type CompanionConfig,
} from "./config.js";
import {
  JsonLogger,
  type CompanionLogger,
} from "./logger.js";
import type { AIProvider } from "./providers.js";
import { CompanionStateStore, StateSyncError } from "./state-store.js";

export { DEFAULT_COMPANION_PORT, LOOPBACK_HOST, parseCompanionPort };
export type { CompanionLogger } from "./logger.js";
export const COMPANION_VERSION = "0.1.0";

const RECENT_REQUEST_TTL_MS = 60_000;
const MAX_RECENT_REQUESTS = 1_024;

export interface CompanionServerOptions {
  port?: number;
  samplingIntervalTicks?: number;
  logger?: CompanionLogger;
  stateStore?: CompanionStateStore;
  advisor?: AdvisorEngine;
  config?: CompanionConfig;
  provider?: AIProvider;
}

export interface CompanionServer {
  readonly address: AddressInfo;
  readonly state: CompanionStateStore;
  readonly advisor: AdvisorEngine;
  readonly assistant: AssistantService;
  close(): Promise<void>;
}

export async function startCompanionServer(
  options: CompanionServerOptions = {},
): Promise<CompanionServer> {
  const config = options.config ?? resolveCompanionConfig();
  const port = options.port ?? config.port;
  const samplingIntervalTicks =
    options.samplingIntervalTicks ?? config.samplingIntervalTicks;
  assertBindablePort(port);
  assertSamplingInterval(samplingIntervalTicks);

  const logger = options.logger ?? new JsonLogger();
  const stateStore = options.stateStore ?? new CompanionStateStore();
  const advisor = options.advisor ?? new AdvisorEngine();
  const assistant = new AssistantService({
    config,
    stateStore,
    advisor,
    logger,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  });
  const recentRequests = new RecentRequestCache();
  const socket = createSocket("udp4");

  socket.on("message", (datagram, remote) => {
    try {
      handleDatagram(
        socket,
        datagram,
        remote,
        logger,
        stateStore,
        advisor,
        samplingIntervalTicks,
        recentRequests,
      );
    } catch (error: unknown) {
      logger.error("udp_handler_error", {
        remote_address: remote.address,
        remote_port: remote.port,
        error_name: error instanceof Error ? error.name : "unknown",
      });
    }
  });

  await bindSocket(socket, port);

  const address = socket.address();
  socket.on("error", (error) => {
    logger.error("udp_socket_error", {
      error_code: "code" in error ? String(error.code) : "unknown",
    });
  });

  logger.info("companion_listening", {
    address: address.address,
    port: address.port,
    sampling_interval_ticks: samplingIntervalTicks,
  });

  let closed = false;

  return {
    address,
    state: stateStore,
    advisor,
    assistant,
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

function handleDatagram(
  socket: Socket,
  datagram: Buffer,
  remote: RemoteInfo,
  logger: CompanionLogger,
  stateStore: CompanionStateStore,
  advisor: AdvisorEngine,
  samplingIntervalTicks: number,
  recentRequests: RecentRequestCache,
): void {
  if (remote.address !== LOOPBACK_HOST) {
    logger.warn("udp_non_loopback_packet_rejected", {
      remote_address: remote.address,
      remote_port: remote.port,
    });
    return;
  }

  let packet;

  try {
    packet = decodePacket(datagram);
  } catch (error: unknown) {
    if (!(error instanceof ProtocolError)) {
      throw error;
    }

    logger.warn("udp_invalid_packet_rejected", {
      remote_address: remote.address,
      remote_port: remote.port,
      error_code: error.code,
    });
    return;
  }

  const digest = createHash("sha256").update(datagram).digest("base64url");
  const cached = recentRequests.lookup(remote, packet.message_id, digest);
  if (cached.kind === "conflict") {
    logger.warn("udp_message_id_conflict", {
      remote_address: remote.address,
      remote_port: remote.port,
      message_id: packet.message_id,
    });
    return;
  }
  if (cached.kind === "duplicate") {
    if (cached.response !== null) {
      sendEncodedPacket(socket, cached.response, remote, logger, packet.type);
    }
    logger.info("udp_duplicate_packet_ignored", {
      message_id: packet.message_id,
      packet_type: packet.type,
      response_replayed: cached.response !== null,
    });
    return;
  }

  switch (packet.type) {
    case "hello":
      if (packet.payload.advisor_config !== undefined) {
        advisor.configure(packet.payload.advisor_config);
      }
      sendResponsePacket(
        socket,
        createHelloAckPacket({
          messageId: `companion-${randomUUID()}`,
          replyTo: packet.message_id,
          timestamp: Date.now(),
          companionVersion: COMPANION_VERSION,
          staticRevision: stateStore.staticRevision,
          samplingIntervalTicks,
        }),
        remote,
        logger,
        recentRequests,
        packet.message_id,
        digest,
        "hello_ack_sent",
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

        requestResync(
          socket,
          remote,
          logger,
          error,
          recentRequests,
          packet.message_id,
          digest,
        );
        return;
      }

      acknowledgeStatePacket(
        socket,
        remote,
        logger,
        packet.message_id,
        packet.payload.revision,
        recentRequests,
        digest,
        completed ? "static_snapshot_completed" : "static_snapshot_chunk_accepted",
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

        requestResync(
          socket,
          remote,
          logger,
          error,
          recentRequests,
          packet.message_id,
          digest,
        );
        return;
      }

      acknowledgeStatePacket(
        socket,
        remote,
        logger,
        packet.message_id,
        packet.payload.revision,
        recentRequests,
        digest,
        "static_delta_accepted",
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
          "advisor_update_sent",
        );
      }
      if (packet.payload.truncated) {
        logger.warn("dynamic_snapshot_truncated", {
          message_id: packet.message_id,
          omitted_forces: packet.payload.omitted_forces,
          omitted_series: packet.payload.omitted_series,
        });
      }
      recentRequests.remember(remote, packet.message_id, digest, null);
      return;
    case "hello_ack":
    case "state_ack":
    case "resync_request":
    case "advisor_update":
      logger.warn("udp_unexpected_packet_ignored", {
        message_id: packet.message_id,
        packet_type: packet.type,
      });
      recentRequests.remember(remote, packet.message_id, digest, null);
  }
}

function acknowledgeStatePacket(
  socket: Socket,
  remote: RemoteInfo,
  logger: CompanionLogger,
  replyTo: string,
  revision: number,
  recentRequests: RecentRequestCache,
  digest: string,
  successEvent: string,
): void {
  sendResponsePacket(
    socket,
    createStateAckPacket({
      messageId: `companion-${randomUUID()}`,
      replyTo,
      timestamp: Date.now(),
      revision,
    }),
    remote,
    logger,
    recentRequests,
    replyTo,
    digest,
    successEvent,
  );
}

function requestResync(
  socket: Socket,
  remote: RemoteInfo,
  logger: CompanionLogger,
  error: StateSyncError,
  recentRequests: RecentRequestCache,
  replyTo: string,
  digest: string,
): void {
  logger.warn("static_resync_requested", {
    error_code: error.code,
    expected_revision: error.expectedRevision,
  });
  sendResponsePacket(
    socket,
    createResyncRequestPacket({
      messageId: `companion-${randomUUID()}`,
      timestamp: Date.now(),
      expectedRevision: error.expectedRevision,
    }),
    remote,
    logger,
    recentRequests,
    replyTo,
    digest,
    "resync_request_sent",
  );
}

function sendPacket(
  socket: Socket,
  packet: ProtocolPacket,
  remote: RemoteInfo,
  logger: CompanionLogger,
  successEvent?: string,
): void {
  sendEncodedPacket(
    socket,
    encodePacket(packet),
    remote,
    logger,
    packet.type,
    successEvent,
  );
}

function sendResponsePacket(
  socket: Socket,
  packet: ProtocolPacket,
  remote: RemoteInfo,
  logger: CompanionLogger,
  recentRequests: RecentRequestCache,
  requestMessageId: string,
  digest: string,
  successEvent: string,
): void {
  const encoded = encodePacket(packet);
  recentRequests.remember(
    remote,
    requestMessageId,
    digest,
    encoded,
  );
  sendEncodedPacket(
    socket,
    encoded,
    remote,
    logger,
    packet.type,
    successEvent,
  );
}

function sendEncodedPacket(
  socket: Socket,
  encoded: string,
  remote: RemoteInfo,
  logger: CompanionLogger,
  packetType: string,
  successEvent?: string,
): void {
  socket.send(encoded, remote.port, remote.address, (error) => {
    if (error !== null) {
      logger.error("udp_send_failed", {
        packet_type: packetType,
        error_code: "code" in error ? String(error.code) : "unknown",
      });
      return;
    }

    if (successEvent !== undefined) {
      logger.info(successEvent, {
        packet_type: packetType,
        remote_address: remote.address,
        remote_port: remote.port,
      });
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

function assertSamplingInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value < 60 || value > 3_600) {
    throw new Error("Sampling interval must be between 60 and 3600 ticks");
  }
}

type CacheLookup =
  | { kind: "miss" }
  | { kind: "conflict" }
  | { kind: "duplicate"; response: string | null };

interface CachedRequest {
  digest: string;
  response: string | null;
  expiresAt: number;
}

class RecentRequestCache {
  readonly #entries = new Map<string, CachedRequest>();

  public lookup(
    remote: RemoteInfo,
    messageId: string,
    digest: string,
  ): CacheLookup {
    this.#removeExpired();
    const entry = this.#entries.get(cacheKey(remote, messageId));
    if (entry === undefined) {
      return { kind: "miss" };
    }
    if (entry.digest !== digest) {
      return { kind: "conflict" };
    }
    return { kind: "duplicate", response: entry.response };
  }

  public remember(
    remote: RemoteInfo,
    messageId: string,
    digest: string,
    response: string | null,
  ): void {
    this.#removeExpired();
    while (this.#entries.size >= MAX_RECENT_REQUESTS) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#entries.delete(oldest);
    }
    this.#entries.set(cacheKey(remote, messageId), {
      digest,
      response,
      expiresAt: Date.now() + RECENT_REQUEST_TTL_MS,
    });
  }

  #removeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
  }
}

function cacheKey(remote: RemoteInfo, messageId: string): string {
  return `${remote.address}:${remote.port}:${messageId}`;
}
