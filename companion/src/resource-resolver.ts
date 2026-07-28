import type { ResourceKind } from "@factorio-ai-assistant/protocol";

import type { AssistantLanguage } from "./config.js";
import type { LocalizedNameLookup } from "./localization.js";

/** Stable protocol identity of a calculation target. */
export interface ResourceCandidate {
  kind: ResourceKind;
  id: string;
}

export type ResourceMatch =
  | { status: "resolved"; term: string; target: ResourceCandidate }
  | { status: "ambiguous"; term: string; candidates: ResourceCandidate[] }
  | { status: "unavailable"; term: string; candidates: ResourceCandidate[] }
  | { status: "unknown" };

export interface ResourceLabel {
  "zh-CN": string;
  en: string;
}

interface ResourceAlias extends ResourceCandidate {
  label: ResourceLabel;
  aliases: readonly string[];
}

interface AmbiguousTerm {
  terms: readonly string[];
  candidates: readonly ResourceCandidate[];
}

const MAX_CLARIFICATION_CANDIDATES = 8;

const item = (id: string): ResourceCandidate => ({ kind: "item", id });
const fluid = (id: string): ResourceCandidate => ({ kind: "fluid", id });

/**
 * Curated player vocabulary. These are the colloquial names players actually
 * type; the synchronized locale covers the official names and the static
 * catalog covers raw prototype identifiers.
 */
export const RESOURCE_ALIASES: readonly ResourceAlias[] = [
  {
    ...item("automation-science-pack"),
    label: { "zh-CN": "红瓶", en: "automation science pack" },
    aliases: [
      "automation science",
      "red science",
      "红瓶",
      "红药水",
      "红科技包",
      "红色科技包",
      "红科学包",
      "自动化科学包",
      "自动化科技包",
    ],
  },
  {
    ...item("logistic-science-pack"),
    label: { "zh-CN": "绿瓶", en: "logistic science pack" },
    aliases: [
      "logistic science",
      "green science",
      "绿瓶",
      "绿药水",
      "绿科技包",
      "绿色科技包",
      "绿科学包",
      "物流科学包",
      "物流科技包",
    ],
  },
  {
    ...item("military-science-pack"),
    label: { "zh-CN": "黑瓶", en: "military science pack" },
    aliases: [
      "military science",
      "black science",
      "黑瓶",
      "黑科技包",
      "黑科学包",
      "军事科学包",
      "军用科学包",
      "军事科技包",
    ],
  },
  {
    ...item("chemical-science-pack"),
    label: { "zh-CN": "蓝瓶", en: "chemical science pack" },
    aliases: [
      "chemical science",
      "blue science",
      "蓝瓶",
      "蓝药水",
      "蓝科技包",
      "蓝色科技包",
      "蓝科学包",
      "化学科学包",
      "化工科学包",
      "化学科技包",
    ],
  },
  {
    ...item("production-science-pack"),
    label: { "zh-CN": "紫瓶", en: "production science pack" },
    aliases: [
      "production science",
      "purple science",
      "紫瓶",
      "紫药水",
      "紫科技包",
      "紫色科技包",
      "紫科学包",
      "生产科学包",
      "生产科技包",
    ],
  },
  {
    ...item("utility-science-pack"),
    label: { "zh-CN": "黄瓶", en: "utility science pack" },
    aliases: [
      "utility science",
      "yellow science",
      "黄瓶",
      "黄药水",
      "黄科技包",
      "黄色科技包",
      "黄科学包",
      "实用科学包",
      "效能科学包",
      "通用科学包",
    ],
  },
  {
    ...item("space-science-pack"),
    label: { "zh-CN": "白瓶", en: "space science pack" },
    aliases: [
      "space science",
      "white science",
      "白瓶",
      "白科技包",
      "白科学包",
      "太空科学包",
      "宇宙科学包",
    ],
  },
  {
    ...item("electronic-circuit"),
    label: { "zh-CN": "绿电路", en: "electronic circuit" },
    aliases: [
      "electronic circuit",
      "green circuit",
      "绿电路",
      "绿板",
      "绿色电路",
      "电子电路",
      "电子线路",
    ],
  },
  {
    ...item("advanced-circuit"),
    label: { "zh-CN": "红电路", en: "advanced circuit" },
    aliases: [
      "advanced circuit",
      "red circuit",
      "红电路",
      "红板",
      "红色电路",
      "高级电路",
      "进阶电路",
    ],
  },
  {
    ...item("processing-unit"),
    label: { "zh-CN": "蓝电路", en: "processing unit" },
    aliases: [
      "processing unit",
      "blue circuit",
      "蓝电路",
      "蓝板",
      "蓝色电路",
      "处理器",
      "处理单元",
    ],
  },
  {
    ...item("steel-plate"),
    label: { "zh-CN": "钢材", en: "steel plate" },
    aliases: ["steel plate", "steel", "钢材", "钢板", "钢铁", "钢"],
  },
  {
    ...item("plastic-bar"),
    label: { "zh-CN": "塑料", en: "plastic bar" },
    aliases: ["plastic bar", "plastic", "塑料棒", "塑料", "塑胶"],
  },
  {
    ...item("sulfur"),
    label: { "zh-CN": "硫磺", en: "sulfur" },
    aliases: ["sulfur", "sulphur", "硫磺", "硫黄", "硫"],
  },
  {
    ...item("battery"),
    label: { "zh-CN": "电池", en: "battery" },
    aliases: ["battery", "batteries", "蓄电池", "电池"],
  },
  {
    ...item("iron-plate"),
    label: { "zh-CN": "铁板", en: "iron plate" },
    aliases: ["iron plate", "铁板"],
  },
  {
    ...item("copper-plate"),
    label: { "zh-CN": "铜板", en: "copper plate" },
    aliases: ["copper plate", "铜板"],
  },
  {
    ...item("iron-gear-wheel"),
    label: { "zh-CN": "铁齿轮", en: "iron gear wheel" },
    aliases: ["iron gear wheel", "gear wheel", "gear", "铁齿轮", "齿轮"],
  },
  {
    ...item("copper-cable"),
    label: { "zh-CN": "铜线", en: "copper cable" },
    aliases: ["copper cable", "铜线", "铜缆"],
  },
  {
    ...item("iron-stick"),
    label: { "zh-CN": "铁棒", en: "iron stick" },
    aliases: ["iron stick", "铁棒", "铁条"],
  },
  {
    ...item("stone-brick"),
    label: { "zh-CN": "石砖", en: "stone brick" },
    aliases: ["stone brick", "石砖"],
  },
  {
    ...item("concrete"),
    label: { "zh-CN": "混凝土", en: "concrete" },
    aliases: ["concrete", "混凝土"],
  },
  {
    ...item("engine-unit"),
    label: { "zh-CN": "引擎", en: "engine unit" },
    aliases: ["engine unit", "engine", "引擎单元", "引擎", "发动机"],
  },
  {
    ...item("electric-engine-unit"),
    label: { "zh-CN": "电动引擎", en: "electric engine unit" },
    aliases: [
      "electric engine unit",
      "electric engine",
      "电动引擎",
      "电力引擎",
      "电动发动机",
    ],
  },
  {
    ...item("flying-robot-frame"),
    label: { "zh-CN": "机器人框架", en: "flying robot frame" },
    aliases: [
      "flying robot frame",
      "robot frame",
      "飞行机器人框架",
      "机器人框架",
    ],
  },
  {
    ...item("low-density-structure"),
    label: { "zh-CN": "低密度结构", en: "low density structure" },
    aliases: ["low density structure", "低密度结构", "低密度"],
  },
  {
    ...item("rocket-fuel"),
    label: { "zh-CN": "火箭燃料", en: "rocket fuel" },
    aliases: ["rocket fuel", "火箭燃料"],
  },
  {
    ...item("rocket-control-unit"),
    label: { "zh-CN": "火箭控制单元", en: "rocket control unit" },
    aliases: ["rocket control unit", "火箭控制单元", "火箭控制器"],
  },
  {
    ...item("solid-fuel"),
    label: { "zh-CN": "固体燃料", en: "solid fuel" },
    aliases: ["solid fuel", "固体燃料"],
  },
  {
    ...item("explosives"),
    label: { "zh-CN": "炸药", en: "explosives" },
    aliases: ["explosives", "炸药"],
  },
  {
    ...item("firearm-magazine"),
    label: { "zh-CN": "机枪弹匣", en: "firearm magazine" },
    aliases: ["firearm magazine", "机枪弹匣", "普通弹匣"],
  },
  {
    ...item("piercing-rounds-magazine"),
    label: { "zh-CN": "穿甲弹匣", en: "piercing rounds magazine" },
    aliases: ["piercing rounds magazine", "piercing magazine", "穿甲弹匣"],
  },
  {
    ...item("grenade"),
    label: { "zh-CN": "手雷", en: "grenade" },
    aliases: ["grenade", "手雷", "手榴弹"],
  },
  {
    ...item("stone-wall"),
    label: { "zh-CN": "石墙", en: "stone wall" },
    aliases: ["stone wall", "石墙"],
  },
  {
    ...item("transport-belt"),
    label: { "zh-CN": "黄带", en: "transport belt" },
    aliases: ["transport belt", "黄带", "黄色传送带", "基础传送带"],
  },
  {
    ...item("fast-transport-belt"),
    label: { "zh-CN": "红带", en: "fast transport belt" },
    aliases: ["fast transport belt", "红带", "快速传送带"],
  },
  {
    ...item("express-transport-belt"),
    label: { "zh-CN": "蓝带", en: "express transport belt" },
    aliases: ["express transport belt", "蓝带", "极速传送带"],
  },
  {
    ...item("inserter"),
    label: { "zh-CN": "机械臂", en: "inserter" },
    aliases: ["inserter", "机械臂", "爪子"],
  },
  {
    ...fluid("sulfuric-acid"),
    label: { "zh-CN": "硫酸", en: "sulfuric acid" },
    aliases: ["sulfuric acid", "sulphuric acid", "硫酸"],
  },
  {
    ...fluid("lubricant"),
    label: { "zh-CN": "润滑油", en: "lubricant" },
    aliases: ["lubricant", "润滑油", "润滑剂"],
  },
  {
    ...fluid("petroleum-gas"),
    label: { "zh-CN": "石油气", en: "petroleum gas" },
    aliases: ["petroleum gas", "petroleum", "石油气", "天然气"],
  },
  {
    ...fluid("light-oil"),
    label: { "zh-CN": "轻油", en: "light oil" },
    aliases: ["light oil", "轻油"],
  },
  {
    ...fluid("heavy-oil"),
    label: { "zh-CN": "重油", en: "heavy oil" },
    aliases: ["heavy oil", "重油"],
  },
];

const SCIENCE_PACK_CANDIDATES: readonly ResourceCandidate[] = [
  item("automation-science-pack"),
  item("logistic-science-pack"),
  item("military-science-pack"),
  item("chemical-science-pack"),
  item("production-science-pack"),
  item("utility-science-pack"),
  item("space-science-pack"),
];

const CIRCUIT_CANDIDATES: readonly ResourceCandidate[] = [
  item("electronic-circuit"),
  item("advanced-circuit"),
  item("processing-unit"),
];

const OIL_CANDIDATES: readonly ResourceCandidate[] = [
  fluid("petroleum-gas"),
  fluid("light-oil"),
  fluid("heavy-oil"),
  fluid("lubricant"),
];

const BELT_CANDIDATES: readonly ResourceCandidate[] = [
  item("transport-belt"),
  item("fast-transport-belt"),
  item("express-transport-belt"),
];

/**
 * Generic words that never identify a single prototype. They are only used when
 * nothing more specific matched, and they produce a clarification question
 * instead of a guess.
 */
const AMBIGUOUS_TERMS: readonly AmbiguousTerm[] = [
  {
    terms: ["科学包", "科技包", "药水", "瓶子", "science pack"],
    candidates: SCIENCE_PACK_CANDIDATES,
  },
  { terms: ["电路", "电路板", "circuit"], candidates: CIRCUIT_CANDIDATES },
  { terms: ["传送带", "belt"], candidates: BELT_CANDIDATES },
  { terms: ["油"], candidates: OIL_CANDIDATES },
];

export interface ResourceResolverSources {
  /** Everything the synchronized catalog can actually produce. */
  products: Iterable<readonly [ResourceKind, string]>;
  names: LocalizedNameLookup;
}

interface ScoredMatch {
  term: string;
  candidates: ResourceCandidate[];
}

export function candidateKey(candidate: ResourceCandidate): string {
  return `${candidate.kind}:${candidate.id}`;
}

/**
 * Resolves the production target a player named in free text. Aliases win over
 * synchronized display names, which win over raw prototype identifiers; generic
 * words only ever produce an explicit clarification.
 */
export function resolveResourceMention(
  question: string,
  sources: ResourceResolverSources,
): ResourceMatch {
  const haystack = question.toLowerCase();
  const producible = new Set<string>();
  for (const [kind, id] of sources.products) {
    producible.add(candidateKey({ kind, id }));
  }
  const known = (candidate: ResourceCandidate): boolean =>
    producible.size === 0 || producible.has(candidateKey(candidate));

  const specificStages: (() => ScoredMatch | undefined)[] = [
    () => matchAliases(haystack),
    () => matchLocalizedNames(haystack, sources.names),
    () => matchPrototypeIds(haystack, producible),
  ];

  for (const stage of specificStages) {
    const match = stage();
    if (match === undefined || match.candidates.length === 0) {
      continue;
    }
    const available = match.candidates.filter(known);
    if (available.length === 0) {
      // The player named something real that this save cannot produce; never
      // silently fall back to a different product.
      return {
        status: "unavailable",
        term: match.term,
        candidates: match.candidates.slice(0, MAX_CLARIFICATION_CANDIDATES),
      };
    }
    const first = available[0];
    if (available.length === 1 && first !== undefined) {
      return { status: "resolved", term: match.term, target: first };
    }
    return {
      status: "ambiguous",
      term: match.term,
      candidates: available.slice(0, MAX_CLARIFICATION_CANDIDATES),
    };
  }

  const generic = matchAmbiguousTerms(haystack, known);
  if (generic !== undefined && generic.candidates.length > 0) {
    const first = generic.candidates[0];
    if (generic.candidates.length === 1 && first !== undefined) {
      return { status: "resolved", term: generic.term, target: first };
    }
    return {
      status: "ambiguous",
      term: generic.term,
      candidates: generic.candidates.slice(0, MAX_CLARIFICATION_CANDIDATES),
    };
  }

  return { status: "unknown" };
}

/** Short, actionable clarification for an ambiguous or unrecognized target. */
export function clarifyResourceMatch(
  language: AssistantLanguage,
  match: ResourceMatch,
  names: LocalizedNameLookup,
): string {
  if (match.status === "resolved") {
    throw new Error("A resolved target does not need clarification");
  }
  if (match.status === "unknown") {
    return language === "zh-CN"
      ? "没认出你要算的产物。直接说名字就行，例如「蓝瓶」「绿电路」「钢材」「塑料」。"
      : 'I could not tell which product you mean. Just name it, for example "blue science", "green circuit", "steel", or "plastic".';
  }

  if (match.status === "unavailable") {
    const named = match.candidates
      .map((candidate) => describeCandidate(language, candidate, names))
      .join(language === "zh-CN" ? "、" : ", ");
    return language === "zh-CN"
      ? `当前同步到的配方里没有能产出${named}的配方，换一个目标或先解锁它。`
      : `The synchronized catalog has no recipe that produces ${named}; pick another target or unlock it first.`;
  }

  const options = match.candidates
    .map((candidate) => describeCandidate(language, candidate, names))
    .join(language === "zh-CN" ? "、" : ", ");
  return language === "zh-CN"
    ? `「${match.term}」可能指 ${options}，你要算哪一个？`
    : `"${match.term}" could mean ${options}. Which one should I calculate?`;
}

/** Player-facing label for a target: game locale first, curated name second. */
export function describeCandidate(
  language: AssistantLanguage,
  candidate: ResourceCandidate,
  names: LocalizedNameLookup,
): string {
  const localized = names.lookup(candidate.kind, candidate.id);
  const alias = RESOURCE_ALIASES.find(
    (entry) => entry.kind === candidate.kind && entry.id === candidate.id,
  );
  const label =
    localized !== undefined && localized !== candidate.id
      ? localized
      : alias?.label[language];
  if (label === undefined) {
    return candidate.id;
  }
  return language === "zh-CN"
    ? `${label}（${candidate.id}）`
    : `${label} (${candidate.id})`;
}

function matchAliases(haystack: string): ScoredMatch | undefined {
  let best: ScoredMatch | undefined;
  let bestLength = 0;
  const seen = new Set<string>();

  for (const entry of RESOURCE_ALIASES) {
    let longest: string | undefined;
    for (const alias of entry.aliases) {
      if (!haystack.includes(alias.toLowerCase())) {
        continue;
      }
      if (longest === undefined || alias.length > longest.length) {
        longest = alias;
      }
    }
    if (longest === undefined) {
      continue;
    }
    const candidate: ResourceCandidate = { kind: entry.kind, id: entry.id };
    if (longest.length > bestLength) {
      bestLength = longest.length;
      best = { term: longest, candidates: [candidate] };
      seen.clear();
      seen.add(candidateKey(candidate));
    } else if (
      longest.length === bestLength &&
      best !== undefined &&
      !seen.has(candidateKey(candidate))
    ) {
      seen.add(candidateKey(candidate));
      best.candidates.push(candidate);
    }
  }

  return best;
}

function matchLocalizedNames(
  haystack: string,
  names: LocalizedNameLookup,
): ScoredMatch | undefined {
  let best: ScoredMatch | undefined;
  let bestLength = 0;
  const seen = new Set<string>();

  for (const entry of names.entries()) {
    if (entry.kind !== "item" && entry.kind !== "fluid") {
      continue;
    }
    const candidate: ResourceCandidate = { kind: entry.kind, id: entry.id };
    const needle = entry.name.toLowerCase().trim();
    if (needle.length < 2 || !haystack.includes(needle)) {
      continue;
    }
    if (needle.length > bestLength) {
      bestLength = needle.length;
      best = { term: entry.name, candidates: [candidate] };
      seen.clear();
      seen.add(candidateKey(candidate));
    } else if (
      needle.length === bestLength &&
      best !== undefined &&
      !seen.has(candidateKey(candidate))
    ) {
      seen.add(candidateKey(candidate));
      best.candidates.push(candidate);
    }
  }

  return best;
}

function matchPrototypeIds(
  haystack: string,
  producible: ReadonlySet<string>,
): ScoredMatch | undefined {
  let best: ScoredMatch | undefined;
  let bestLength = 0;

  for (const key of producible) {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator) as ResourceKind;
    const id = key.slice(separator + 1);
    const needle = id.toLowerCase();
    if (needle.length <= bestLength || !haystack.includes(needle)) {
      continue;
    }
    bestLength = needle.length;
    best = { term: id, candidates: [{ kind, id }] };
  }

  return best;
}

function matchAmbiguousTerms(
  haystack: string,
  known: (candidate: ResourceCandidate) => boolean,
): ScoredMatch | undefined {
  let best: ScoredMatch | undefined;
  let bestLength = 0;

  for (const entry of AMBIGUOUS_TERMS) {
    for (const term of entry.terms) {
      const needle = term.toLowerCase();
      if (needle.length <= bestLength || !haystack.includes(needle)) {
        continue;
      }
      const candidates = entry.candidates.filter(known);
      if (candidates.length === 0) {
        continue;
      }
      bestLength = needle.length;
      best = { term, candidates: candidates.map((value) => ({ ...value })) };
    }
  }

  return best;
}
