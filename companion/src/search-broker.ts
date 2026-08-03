import { randomUUID } from "node:crypto";

import {
  createSearchRequestPacket,
  type SearchFilter,
  type SearchResponsePacket,
} from "@factorio-ai-assistant/protocol";

/** Long enough for the Mod to scan a large map, short enough not to strand a
 * tool round. The Mod scans synchronously on the game thread, so the reply
 * lands within a tick or two of the request unless the game is paused. */
const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchTransport {
  send(packet: ReturnType<typeof createSearchRequestPacket>): boolean;
}

/**
 * Asks the Mod to scan the map and waits for the matching reply.
 *
 * Everything else the Companion knows arrives unsolicited, so this is the only
 * path that needs request/response correlation. Replies are matched by the
 * `reply_to` field rather than by arrival order, because an unrelated packet
 * can land in between.
 */
export class SearchBroker {
  readonly #pending = new Map<
    string,
    {
      resolve: (packet: SearchResponsePacket | undefined) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #transport: SearchTransport | undefined;

  /** Set once the UDP socket knows where the Mod is. */
  public useTransport(transport: SearchTransport | undefined): void {
    this.#transport = transport;
  }

  public get available(): boolean {
    return this.#transport !== undefined;
  }

  /**
   * Resolves with the Mod's answer, or `undefined` when the Mod is unreachable
   * or does not reply in time. A search that quietly hangs would burn the
   * tool-loop deadline and leave the player waiting for nothing.
   */
  public async search(
    forceId: string,
    filter: SearchFilter,
  ): Promise<SearchResponsePacket | undefined> {
    const transport = this.#transport;
    if (transport === undefined) {
      return undefined;
    }

    const packet = createSearchRequestPacket({
      messageId: `companion-${randomUUID()}`,
      timestamp: Date.now(),
      forceId,
      filter,
    });

    if (!transport.send(packet)) {
      return undefined;
    }

    return new Promise<SearchResponsePacket | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(packet.message_id);
        resolve(undefined);
      }, SEARCH_TIMEOUT_MS);
      timer.unref();
      this.#pending.set(packet.message_id, { resolve, timer });
    });
  }

  /** Routes a reply to whoever asked for it. */
  public accept(packet: SearchResponsePacket): boolean {
    const waiting = this.#pending.get(packet.payload.reply_to);
    if (waiting === undefined) {
      return false;
    }
    this.#pending.delete(packet.payload.reply_to);
    clearTimeout(waiting.timer);
    waiting.resolve(packet);
    return true;
  }

  /** Releases every waiter, so shutdown does not hang on a pending search. */
  public reset(): void {
    for (const waiting of this.#pending.values()) {
      clearTimeout(waiting.timer);
      waiting.resolve(undefined);
    }
    this.#pending.clear();
  }
}
