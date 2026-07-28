/**
 * Free-text parsing for chat-driven production questions. The Companion, not the
 * player, turns a sentence into deterministic calculator arguments; nothing here
 * ever produces a number that is not written in the question itself.
 */

export interface ParsedRate {
  /** Normalized target rate in units per minute. */
  perMinute: number;
  /** The unit phrase the player actually used, for clarification text. */
  term: string;
}

interface RateUnit {
  pattern: RegExp;
  perMinute: number;
}

const RATE_UNITS: readonly RateUnit[] = [
  {
    pattern:
      /(?:每|(?<![\d.])1\s*|一)\s*分钟|(?:每|(?<![\d.])1\s*|一)\s*分(?!钟)|\/\s*min(?:ute)?|per\s+minute|每\s*min\b/iu,
    perMinute: 1,
  },
  {
    pattern:
      /(?:每|(?<![\d.])1\s*|一)\s*秒钟?|\/\s*sec(?:ond)?s?\b|\/\s*s\b|per\s+second/iu,
    perMinute: 60,
  },
  {
    pattern:
      /(?:每|(?<![\d.])1\s*|一)\s*小时|\/\s*h(?:ours?|r)?\b|per\s+hour/iu,
    perMinute: 1 / 60,
  },
];

const NUMBER_PATTERN = /\d+(?:\.\d+)?/gu;
/** Words that make a preceding number a machine count rather than an output rate. */
const NOT_A_RATE_GAP = /台|机器|机台|设备|工厂|产线|machines?|assemblers?|furnaces?/u;

/** Explicit machine-count or ratio asks: these are calculator questions on their own. */
const PRODUCTION_ASK =
  /(?:多少|几)\s*(?:台|个|座|组|条)?\s*(?:机器|机台|组装机|熔炉|化工厂|炼油厂|设备|产线)|(?:机器|机台|组装机|熔炉|化工厂|设备|产线)\s*(?:要|需要)?\s*(?:多少|几)|多少台|几台|怎么配|如何配|怎样配|怎么排|怎么建|如何建|配比|生产比例|比例是?多少|产线怎么|how many machines|machines? (?:do|would|will|are|am)|production ratio|what ratio|ratio for|setup for/u;
/** Weaker asks: only a calculator question when the player also states a rate. */
const PRODUCTION_WEAK_ASK = /需要多少|要多少|需要几|要几|how many/u;
/** Weakest signal: a production verb next to an explicit rate is still a ratio ask. */
const PRODUCTION_VERB =
  /生产|产出|做出|搓|拉一条|支持|produce|producing|sustain|support/u;

/**
 * Reads the target rate from a question and normalizes it to per minute.
 * Returns `undefined` when the player did not state a usable rate.
 */
export function parseTargetRate(question: string): ParsedRate | undefined {
  const normalized = question.toLowerCase();
  const marker = findRateMarker(normalized);
  if (marker === undefined) {
    return undefined;
  }

  const value = findRateValue(normalized, marker.index, marker.length);
  if (value === undefined) {
    return undefined;
  }

  const perMinute = value * marker.perMinute;
  if (!Number.isFinite(perMinute) || perMinute <= 0) {
    return undefined;
  }
  return { perMinute, term: marker.term };
}

/**
 * True when the question asks for a deterministic production ratio. An explicit
 * machine-count or ratio ask qualifies on its own, so a missing rate becomes a
 * clarification instead of a generic advisor answer.
 */
export function isProductionRatioQuestion(question: string): boolean {
  const normalized = question.toLowerCase();
  if (PRODUCTION_ASK.test(normalized)) {
    return true;
  }
  if (parseTargetRate(question) === undefined) {
    return false;
  }
  return (
    PRODUCTION_WEAK_ASK.test(normalized) || PRODUCTION_VERB.test(normalized)
  );
}

interface RateMarker {
  index: number;
  length: number;
  perMinute: number;
  term: string;
}

function findRateMarker(normalized: string): RateMarker | undefined {
  let best: RateMarker | undefined;
  for (const unit of RATE_UNITS) {
    const match = unit.pattern.exec(normalized);
    if (match === null) {
      continue;
    }
    if (best === undefined || match.index < best.index) {
      best = {
        index: match.index,
        length: match[0].length,
        perMinute: unit.perMinute,
        term: match[0].trim(),
      };
    }
  }
  return best;
}

function findRateValue(
  normalized: string,
  markerIndex: number,
  markerLength: number,
): number | undefined {
  const before = normalized.slice(0, markerIndex);
  const beforeMatches = [...before.matchAll(NUMBER_PATTERN)];
  const beforeMatch = beforeMatches.at(-1);
  const beforeGapText =
    beforeMatch === undefined
      ? undefined
      : before.slice(beforeMatch.index + beforeMatch[0].length);

  const after = normalized.slice(markerIndex + markerLength);
  const afterMatch = new RegExp(NUMBER_PATTERN.source, "u").exec(after);

  const beforeCandidate =
    beforeMatch === undefined ||
    beforeGapText === undefined ||
    NOT_A_RATE_GAP.test(beforeGapText)
      ? undefined
      : { value: Number(beforeMatch[0]), gap: beforeGapText.length };
  const afterCandidate =
    afterMatch === null
      ? undefined
      : { value: Number(afterMatch[0]), gap: afterMatch.index };

  if (beforeCandidate === undefined) {
    return afterCandidate?.value;
  }
  if (afterCandidate === undefined) {
    return beforeCandidate.value;
  }
  return beforeCandidate.gap <= afterCandidate.gap
    ? beforeCandidate.value
    : afterCandidate.value;
}
