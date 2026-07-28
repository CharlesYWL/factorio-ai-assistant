import {
  type LocalizationUpdatePacket,
  type LocalizedNameKind,
} from "@factorio-ai-assistant/protocol";

export const MAX_LOCALIZED_NAMES = 4_096;

/**
 * Display-name resolution for prototype identifiers. Identifiers stay the stable
 * protocol key; the resolved name is only ever used for player-facing text and
 * model context.
 */
export interface LocalizedNameEntry {
  kind: LocalizedNameKind;
  id: string;
  name: string;
}

export interface LocalizedNameLookup {
  readonly locale: string | undefined;
  lookup(kind: LocalizedNameKind, id: string): string | undefined;
  display(kind: LocalizedNameKind, id: string, fallback?: string): string;
  describe(kind: LocalizedNameKind, id: string): string;
  /** Every synchronized name, for reverse lookups such as chat target resolution. */
  entries(): readonly LocalizedNameEntry[];
}

export function localizedNameKey(
  kind: LocalizedNameKind,
  id: string,
): string {
  return `${kind}:${id}`;
}

class IdentifierNameLookup implements LocalizedNameLookup {
  public get locale(): string | undefined {
    return undefined;
  }

  public lookup(): string | undefined {
    return undefined;
  }

  public display(
    _kind: LocalizedNameKind,
    id: string,
    fallback?: string,
  ): string {
    return fallback ?? id;
  }

  public describe(_kind: LocalizedNameKind, id: string): string {
    return id;
  }

  public entries(): readonly LocalizedNameEntry[] {
    return [];
  }
}

/** Lookup used before any locale has been synchronized: every ID resolves to itself. */
export const IDENTIFIER_NAMES: LocalizedNameLookup = new IdentifierNameLookup();

export class LocalizedNameStore implements LocalizedNameLookup {
  readonly #names = new Map<string, string>();
  #locale: string | undefined;
  #omitted = 0;

  public get locale(): string | undefined {
    return this.#locale;
  }

  public get size(): number {
    return this.#names.size;
  }

  public get omittedNames(): number {
    return this.#omitted;
  }

  public apply(packet: LocalizationUpdatePacket): void {
    const { locale, reset, names } = packet.payload;

    if (reset || (this.#locale !== undefined && this.#locale !== locale)) {
      this.#names.clear();
      this.#omitted = 0;
    }
    this.#locale = locale;

    for (const entry of names) {
      const key = localizedNameKey(entry.kind, entry.id);
      if (!this.#names.has(key) && this.#names.size >= MAX_LOCALIZED_NAMES) {
        this.#omitted += 1;
        continue;
      }
      this.#names.set(key, entry.name);
    }
  }

  public reset(): void {
    this.#names.clear();
    this.#omitted = 0;
    this.#locale = undefined;
  }

  public lookup(kind: LocalizedNameKind, id: string): string | undefined {
    return this.#names.get(localizedNameKey(kind, id));
  }

  public display(
    kind: LocalizedNameKind,
    id: string,
    fallback?: string,
  ): string {
    return this.lookup(kind, id) ?? fallback ?? id;
  }

  /** Name plus the raw identifier, for debug, tooltip, and ambiguous contexts. */
  public describe(kind: LocalizedNameKind, id: string): string {
    const name = this.lookup(kind, id);
    return name === undefined || name === id ? id : `${name} (${id})`;
  }

  public entries(): readonly LocalizedNameEntry[] {
    const result: LocalizedNameEntry[] = [];
    for (const [key, name] of this.#names) {
      const separator = key.indexOf(":");
      result.push({
        kind: key.slice(0, separator) as LocalizedNameKind,
        id: key.slice(separator + 1),
        name,
      });
    }
    return result;
  }
}

/** Compact `kind:id -> name` map for the requested identifiers, translated ones only. */
export function localizedNameMap(
  lookup: LocalizedNameLookup,
  references: Iterable<readonly [LocalizedNameKind, string]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [kind, id] of references) {
    const name = lookup.lookup(kind, id);
    if (name !== undefined && name !== id) {
      result[localizedNameKey(kind, id)] = name;
    }
  }
  return result;
}
