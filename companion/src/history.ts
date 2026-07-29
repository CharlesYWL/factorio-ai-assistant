import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DynamicSnapshotPacket } from "@factorio-ai-assistant/protocol";

/** Game ticks per minute at the normal 60 UPS. */
const TICKS_PER_MINUTE = 3_600;
/** Series kept per sample, ordered by throughput; the rest are rarely asked about. */
const MAX_SERIES_PER_POINT = 40;
/** Roughly 100 hours of play at one point per minute. */
const MAX_POINTS = 6_000;
/** Rewrite the file once it holds this much dead weight from trimming. */
const COMPACT_AFTER_APPENDS = 500;

/** One minute of history: what was produced and consumed, plus headline state. */
export interface HistoryPoint {
  /** Game tick the sample was taken at; the only reliable clock here. */
  t: number;
  /** `id -> [produced_per_minute, consumed_per_minute]`. */
  f: Record<string, [number, number]>;
  /** Power satisfaction ratio, rounded. */
  p: number;
  /** Technology being researched, if any. */
  r?: string;
}

export interface HistoryOptions {
  /** Directory the per-save history files live in. */
  directory: string;
  maxPoints?: number;
}

/**
 * Keeps a per-save, per-minute record of production so questions about change
 * over time can be answered at all. A snapshot alone cannot say when output
 * started falling or whether a change helped.
 *
 * Downsampled to one point per game minute: the 5-second sampling rate would
 * cost roughly 1.4 GB per 100 hours stored verbatim, against 27 MB this way,
 * and no trend question needs finer resolution.
 */
export class ProductionHistory {
  readonly #directory: string;
  readonly #maxPoints: number;
  #saveId: string | undefined;
  #points: HistoryPoint[] = [];
  #lastRecordedTick: number | undefined;
  #appendsSinceCompaction = 0;
  #writing: Promise<void> = Promise.resolve();

  public constructor(options: HistoryOptions) {
    this.#directory = options.directory;
    this.#maxPoints = options.maxPoints ?? MAX_POINTS;
  }

  public get saveId(): string | undefined {
    return this.#saveId;
  }

  public get points(): readonly HistoryPoint[] {
    return this.#points;
  }

  /**
   * Records a sample if a game minute has passed since the last one. Returns
   * true when a point was stored, so callers can log meaningfully.
   */
  public async record(packet: DynamicSnapshotPacket): Promise<boolean> {
    const saveId = packet.payload.save_id;
    if (saveId === undefined) {
      // An older Mod that cannot identify its save; keeping history would risk
      // mixing timelines, which is worse than having none.
      return false;
    }

    if (saveId !== this.#saveId) {
      await this.#load(saveId);
    }

    const tick = packet.tick;
    if (tick < (this.#lastRecordedTick ?? -1)) {
      // The clock went backwards, so the player loaded an earlier point. Later
      // history describes a future that no longer happened and must go.
      await this.#rewindTo(tick);
    } else if (
      this.#lastRecordedTick !== undefined &&
      tick - this.#lastRecordedTick < TICKS_PER_MINUTE
    ) {
      return false;
    }

    const point = toPoint(packet);
    if (point === undefined) {
      return false;
    }

    this.#points.push(point);
    this.#lastRecordedTick = tick;
    if (this.#points.length > this.#maxPoints) {
      this.#points.splice(0, this.#points.length - this.#maxPoints);
    }

    await this.#append(point);
    return true;
  }

  async #load(saveId: string): Promise<void> {
    this.#saveId = saveId;
    this.#points = [];
    this.#lastRecordedTick = undefined;
    this.#appendsSinceCompaction = 0;

    let raw: string;
    try {
      raw = await readFile(this.#pathFor(saveId), "utf8");
    } catch {
      return;
    }

    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const point = JSON.parse(line) as HistoryPoint;
        if (typeof point.t === "number" && typeof point.f === "object") {
          this.#points.push(point);
        }
      } catch {
        // A partially written final line is expected after a crash; the rest of
        // the file is still usable.
      }
    }

    if (this.#points.length > this.#maxPoints) {
      this.#points.splice(0, this.#points.length - this.#maxPoints);
    }
    this.#lastRecordedTick = this.#points.at(-1)?.t;
  }

  async #rewindTo(tick: number): Promise<void> {
    this.#points = this.#points.filter((point) => point.t < tick);
    this.#lastRecordedTick = this.#points.at(-1)?.t;
    await this.#rewrite();
  }

  async #append(point: HistoryPoint): Promise<void> {
    this.#appendsSinceCompaction += 1;
    if (this.#appendsSinceCompaction >= COMPACT_AFTER_APPENDS) {
      await this.#rewrite();
      return;
    }
    await this.#serialize(async (file) => {
      await appendFile(file, `${JSON.stringify(point)}\n`, "utf8");
    });
  }

  /** Replaces the file atomically, dropping points trimmed from memory. */
  async #rewrite(): Promise<void> {
    this.#appendsSinceCompaction = 0;
    const body = this.#points
      .map((point) => JSON.stringify(point))
      .join("\n");
    await this.#serialize(async (file) => {
      const temporary = `${file}.tmp`;
      await writeFile(temporary, body.length === 0 ? "" : `${body}\n`, "utf8");
      await rename(temporary, file);
    });
  }

  /** Writes are chained so an append can never interleave with a rewrite. */
  async #serialize(write: (file: string) => Promise<void>): Promise<void> {
    const saveId = this.#saveId;
    if (saveId === undefined) {
      return;
    }
    const file = this.#pathFor(saveId);
    this.#writing = this.#writing
      .then(async () => {
        await mkdir(this.#directory, { recursive: true });
        await write(file);
      })
      .catch(() => undefined);
    await this.#writing;
  }

  #pathFor(saveId: string): string {
    return path.join(this.#directory, `${saveId}.jsonl`);
  }
}

function toPoint(packet: DynamicSnapshotPacket): HistoryPoint | undefined {
  const force = packet.payload.forces[0];
  if (force === undefined) {
    return undefined;
  }

  const flows = [...force.items, ...force.fluids]
    .filter(
      (flow) =>
        flow.produced_per_minute_1m > 0 || flow.consumed_per_minute_1m > 0,
    )
    .sort(
      (left, right) =>
        right.produced_per_minute_1m +
        right.consumed_per_minute_1m -
        (left.produced_per_minute_1m + left.consumed_per_minute_1m),
    )
    .slice(0, MAX_SERIES_PER_POINT);

  const f: Record<string, [number, number]> = {};
  for (const flow of flows) {
    f[flow.id] = [
      round(flow.produced_per_minute_1m),
      round(flow.consumed_per_minute_1m),
    ];
  }

  return {
    t: packet.tick,
    f,
    p: round(force.power.satisfaction_ratio),
    ...(force.research === null
      ? {}
      : { r: force.research.technology_id }),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A single series' movement over the window the question is about. */
export interface TrendEntry {
  id: string;
  now: number;
  earlier: number;
  /** Signed percentage change, or null when it started from zero. */
  change_percent: number | null;
}

export interface TrendSummary {
  /** How much game time the comparison spans. */
  window_minutes: number;
  /** Points available in total, so the model can judge how much to trust it. */
  sample_count: number;
  /** Production that fell the most, worst first. */
  declining: TrendEntry[];
  /** Production that rose the most. */
  rising: TrendEntry[];
  /** Series present earlier that produce nothing now. */
  stopped: string[];
  /** Series producing now that produced nothing earlier. */
  started: string[];
  power: { now: number; earlier: number };
}

/** Series must move at least this much to be worth reporting as a trend. */
const MIN_REPORTED_CHANGE_PERCENT = 15;
const MIN_REPORTED_RATE = 1;
const MAX_TREND_ENTRIES = 6;

/**
 * Compares the latest point against one about `windowMinutes` earlier. The
 * model is given conclusions rather than the raw series because the interesting
 * question is "what changed", and thousands of points would crowd out the rest
 * of the context to answer it.
 */
export function summarizeTrend(
  points: readonly HistoryPoint[],
  windowMinutes = 10,
): TrendSummary | undefined {
  const latest = points.at(-1);
  if (latest === undefined || points.length < 2) {
    return undefined;
  }

  const targetTick = latest.t - windowMinutes * TICKS_PER_MINUTE;
  let earlier = points[0];
  for (const point of points) {
    if (point.t <= targetTick) {
      earlier = point;
    } else {
      break;
    }
  }
  if (earlier === undefined || earlier.t === latest.t) {
    return undefined;
  }

  const declining: TrendEntry[] = [];
  const rising: TrendEntry[] = [];
  const stopped: string[] = [];
  const started: string[] = [];

  for (const [id, [producedNow]] of Object.entries(latest.f)) {
    const producedBefore = earlier.f[id]?.[0] ?? 0;
    if (producedBefore < MIN_REPORTED_RATE && producedNow >= MIN_REPORTED_RATE) {
      started.push(id);
      continue;
    }
    if (producedBefore < MIN_REPORTED_RATE) {
      continue;
    }

    const changePercent =
      ((producedNow - producedBefore) / producedBefore) * 100;
    if (Math.abs(changePercent) < MIN_REPORTED_CHANGE_PERCENT) {
      continue;
    }
    const entry: TrendEntry = {
      id,
      now: producedNow,
      earlier: producedBefore,
      change_percent: Math.round(changePercent),
    };
    if (changePercent < 0) {
      declining.push(entry);
    } else {
      rising.push(entry);
    }
  }

  for (const [id, [producedBefore]] of Object.entries(earlier.f)) {
    const producedNow = latest.f[id]?.[0] ?? 0;
    if (producedBefore >= MIN_REPORTED_RATE && producedNow < MIN_REPORTED_RATE) {
      stopped.push(id);
    }
  }

  declining.sort((left, right) => left.change_percent! - right.change_percent!);
  rising.sort((left, right) => right.change_percent! - left.change_percent!);

  return {
    window_minutes: Math.round((latest.t - earlier.t) / TICKS_PER_MINUTE),
    sample_count: points.length,
    declining: declining.slice(0, MAX_TREND_ENTRIES),
    rising: rising.slice(0, MAX_TREND_ENTRIES),
    stopped: stopped.slice(0, MAX_TREND_ENTRIES),
    started: started.slice(0, MAX_TREND_ENTRIES),
    power: { now: latest.p, earlier: earlier.p },
  };
}
