import type { AdvisorAlert } from "@factorio-ai-assistant/protocol";

import {
  GUIDE_FACTORIO_VERSION,
  GUIDE_REVISION,
  GUIDE_VERSION,
  VANILLA_PROGRESSION_GUIDE,
} from "./data.js";
import type {
  ConditionOutcome,
  GuideCondition,
  GuideRule,
  GuideSource,
  GuideStage,
  LocalizedText,
  ProgressionFlow,
  ProgressionGap,
  ProgressionGuide,
  ProgressionPlan,
  ProgressionPlanOptions,
  ProgressionStageResult,
  ProgressionState,
  ProgressionStep,
  StageOverviewEntry,
} from "./types.js";

export * from "./types.js";
export {
  GUIDE_FACTORIO_VERSION,
  GUIDE_REVISION,
  GUIDE_VERSION,
  VANILLA_PROGRESSION_GUIDE,
} from "./data.js";

const DEFAULT_MAX_STEPS = 3;
const MAX_BOTTLENECK_STEPS = 2;
const SEVERITY_RANK: Record<AdvisorAlert["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

interface ResolvedState {
  readonly technologies: ReadonlySet<string> | undefined;
  readonly staticTruncated: boolean;
  readonly flows: ReadonlyMap<string, ProgressionFlow> | undefined;
  readonly dynamicTruncated: boolean;
  readonly currentResearch: ProgressionState["current_research"];
  readonly alerts: readonly AdvisorAlert[];
}

/**
 * Deterministically maps synchronized force state onto the built-in progression guide.
 * Nothing here calls a model, reads the network, or invents state: an input that was not
 * synchronized stays `unknown` and is reported as a data gap instead of being assumed.
 */
export function planProgression(
  state: ProgressionState = {},
  options: ProgressionPlanOptions = {},
): ProgressionPlan {
  const guide = options.guide ?? VANILLA_PROGRESSION_GUIDE;
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const resolved = resolveState(state);
  const stageMatch = matchStage(guide, resolved);
  const stage = stageMatch.stage;
  const nextStage = guide.stages.find(({ order }) => order === stage.order + 1);
  const gaps: ProgressionGap[] = [];

  collectStateGaps(resolved, gaps);
  if (stageMatch.uncertain) {
    gaps.push({
      rule_id: "state:stage_undecidable",
      reason: {
        "zh-CN":
          "部分阶段门槛科技无法从被裁剪的静态状态确认，当前阶段只是下界，实际进度可能更靠后。",
        en: "Some stage gate technologies cannot be confirmed from the truncated static state, so the reported stage is a lower bound and the real progress may be further along.",
      },
    });
  }

  const bottleneckSteps = buildBottleneckSteps(resolved.alerts, stage);
  const guideSteps = buildGuideSteps(
    stage,
    resolved,
    gaps,
    stageMatch.basis === "general",
  );
  const steps = [...bottleneckSteps, ...guideSteps]
    .slice(0, maxSteps)
    .map((step, index) => ({ ...step, order: index + 1 }));

  const stageComplete =
    stageMatch.basis === "state" &&
    stage.completion_technologies.length > 0 &&
    stage.completion_technologies.every(
      (id) => evaluateCondition({ kind: "technology_researched", technology_id: id }, resolved) === "met",
    );

  const stageResult: ProgressionStageResult = {
    id: stage.id,
    order: stage.order,
    total: guide.stages.length,
    title: stage.title,
    goal: stage.goal,
    basis: stageMatch.basis,
    matched_technologies: stageMatch.matchedTechnologies,
    complete: stageComplete,
    uncertain: stageMatch.uncertain,
  };

  return {
    guide_version: guide.guide_version,
    guide_revision: guide.guide_revision,
    factorio_version: guide.factorio_version,
    stage: stageResult,
    next_stage: nextStage === undefined ? null : toOverviewEntry(nextStage),
    next_goal: nextGoal(stage, nextStage, stageComplete),
    steps,
    data_gaps: gaps,
    sources: collectSources(guide, stage, steps),
    stage_overview: guide.stages.map(toOverviewEntry),
  };
}

/** Tri-state evaluation of a single guide condition against unresolved state. */
export function evaluateGuideCondition(
  condition: GuideCondition,
  state: ProgressionState,
): ConditionOutcome {
  return evaluateCondition(condition, resolveState(state));
}

function evaluateCondition(
  condition: GuideCondition,
  state: ResolvedState,
): ConditionOutcome {
  switch (condition.kind) {
    case "technology_researched":
    case "technology_missing": {
      const researched = technologyOutcome(condition.technology_id, state);
      if (researched === "unknown") {
        return "unknown";
      }
      const isResearched = researched === "met";
      const wanted = condition.kind === "technology_researched";
      return isResearched === wanted ? "met" : "unmet";
    }
    case "research_idle":
    case "research_active": {
      if (state.currentResearch === undefined) {
        return "unknown";
      }
      const idle = state.currentResearch === null;
      const wanted = condition.kind === "research_idle";
      return idle === wanted ? "met" : "unmet";
    }
    case "flow_produced_at_least":
    case "flow_produced_below":
    case "flow_net_below": {
      const flow = flowFor(condition, state);
      if (flow === "unknown") {
        return "unknown";
      }
      const produced =
        condition.window === "1m"
          ? flow.produced_per_minute_1m
          : flow.produced_per_minute_10m;
      const consumed =
        condition.window === "1m"
          ? flow.consumed_per_minute_1m
          : flow.consumed_per_minute_10m;
      if (condition.kind === "flow_produced_at_least") {
        return produced >= condition.per_minute ? "met" : "unmet";
      }
      if (condition.kind === "flow_produced_below") {
        return produced < condition.per_minute ? "met" : "unmet";
      }
      return produced - consumed < condition.per_minute ? "met" : "unmet";
    }
  }
}

function technologyOutcome(
  technologyId: string,
  state: ResolvedState,
): ConditionOutcome {
  if (state.technologies === undefined) {
    return "unknown";
  }
  if (state.technologies.has(technologyId)) {
    return "met";
  }
  return state.staticTruncated ? "unknown" : "unmet";
}

function flowFor(
  condition: Extract<GuideCondition, { resource_id: string }>,
  state: ResolvedState,
): ProgressionFlow | "unknown" {
  if (state.flows === undefined) {
    return "unknown";
  }
  const flow = state.flows.get(`${condition.resource_kind}:${condition.resource_id}`);
  if (flow !== undefined) {
    return flow;
  }
  if (state.dynamicTruncated) {
    return "unknown";
  }
  return {
    kind: condition.resource_kind,
    id: condition.resource_id,
    produced_per_minute_1m: 0,
    consumed_per_minute_1m: 0,
    produced_per_minute_10m: 0,
    consumed_per_minute_10m: 0,
  };
}

function resolveState(state: ProgressionState): ResolvedState {
  return {
    technologies:
      state.researched_technologies === undefined
        ? undefined
        : new Set(state.researched_technologies),
    staticTruncated: state.static_truncated ?? false,
    flows:
      state.flows === undefined
        ? undefined
        : new Map(state.flows.map((flow) => [`${flow.kind}:${flow.id}`, flow])),
    dynamicTruncated: state.dynamic_truncated ?? false,
    currentResearch: state.current_research,
    alerts: state.alerts ?? [],
  };
}

function matchStage(
  guide: ProgressionGuide,
  state: ResolvedState,
): {
  stage: GuideStage;
  basis: ProgressionStageResult["basis"];
  matchedTechnologies: string[];
  uncertain: boolean;
} {
  const firstStage = guide.stages[0];
  if (firstStage === undefined) {
    throw new Error("Progression guide contains no stages");
  }
  if (state.technologies === undefined) {
    return {
      stage: firstStage,
      basis: "general",
      matchedTechnologies: [],
      uncertain: false,
    };
  }

  let matched = firstStage;
  let matchedTechnologies: string[] = [];
  let uncertain = false;
  for (const stage of [...guide.stages].sort((left, right) => left.order - right.order)) {
    const outcomes = stage.entry_technologies.map((id) =>
      technologyOutcome(id, state),
    );
    if (outcomes.includes("unknown")) {
      // A truncated snapshot cannot prove the gate is unmet, so the force may already be
      // past this stage. Keep scanning higher stages and flag the result as uncertain.
      uncertain = true;
      continue;
    }
    if (outcomes.every((outcome) => outcome === "met")) {
      matched = stage;
      matchedTechnologies = [...stage.entry_technologies];
    }
  }
  return { stage: matched, basis: "state", matchedTechnologies, uncertain };
}

function buildBottleneckSteps(
  alerts: readonly AdvisorAlert[],
  stage: GuideStage,
): ProgressionStep[] {
  return [...alerts]
    .sort(
      (left, right) =>
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
        left.first_seen - right.first_seen ||
        left.id.localeCompare(right.id),
    )
    .slice(0, MAX_BOTTLENECK_STEPS)
    .map((alert, index) => ({
      order: index + 1,
      origin: "bottleneck" as const,
      rule_id: `advisor:${alert.rule_id}`,
      objective: bilingual(
        `先处理当前瓶颈（${alert.rule_id}）再推进流程：${alert.recommendation}`,
        `Clear the active bottleneck (${alert.rule_id}) before advancing the plan: ${alert.recommendation}`,
      ),
      rationale: bilingual(
        `本地规则在“${stage.title["zh-CN"]}”阶段检测到活动告警；证据：${alert.evidence}`,
        `A deterministic rule is active during the ${stage.title.en} stage; evidence: ${alert.evidence}`,
      ),
      verification: bilingual(
        `告警 ${alert.id} 连续恢复后自动关闭。`,
        `Alert ${alert.id} closes on its own after a sustained recovery.`,
      ),
      source_ids: [],
      alert_id: alert.id,
      alert_severity: alert.severity,
    }));
}

function buildGuideSteps(
  stage: GuideStage,
  state: ResolvedState,
  gaps: ProgressionGap[],
  general: boolean,
): ProgressionStep[] {
  const steps: ProgressionStep[] = [];
  for (const rule of [...stage.rules].sort((left, right) => left.order - right.order)) {
    const outcome = general ? "met" : evaluateRule(rule, state);
    if (outcome === "unknown") {
      gaps.push({
        rule_id: rule.id,
        reason: bilingual(
          `规则 ${rule.id} 的前置条件依赖尚未同步的状态，本轮无法判定。`,
          `Rule ${rule.id} depends on state that has not been synchronized, so it cannot be decided this run.`,
        ),
      });
      continue;
    }
    if (outcome === "unmet") {
      continue;
    }
    steps.push({
      order: steps.length + 1,
      origin: "guide",
      rule_id: rule.id,
      objective: rule.objective,
      rationale: rule.rationale,
      verification: rule.verification,
      source_ids: [...rule.source_ids],
    });
  }
  return steps;
}

function evaluateRule(rule: GuideRule, state: ResolvedState): ConditionOutcome {
  let unknown = false;
  for (const condition of rule.preconditions) {
    const outcome = evaluateCondition(condition, state);
    if (outcome === "unmet") {
      return "unmet";
    }
    if (outcome === "unknown") {
      unknown = true;
    }
  }
  return unknown ? "unknown" : "met";
}

function collectStateGaps(state: ResolvedState, gaps: ProgressionGap[]): void {
  if (state.technologies === undefined) {
    gaps.push({
      rule_id: "state:researched_technologies",
      reason: bilingual(
        "尚未同步已研究科技，阶段判定只能给出通用流程说明。",
        "Researched technologies are not synchronized, so the stage can only be described in general terms.",
      ),
    });
  } else if (state.staticTruncated) {
    gaps.push({
      rule_id: "state:static_truncated",
      reason: bilingual(
        "静态状态被裁剪，未出现的科技不能当作未研究。",
        "The static state was truncated, so an absent technology cannot be treated as unresearched.",
      ),
    });
  }
  if (state.flows === undefined) {
    gaps.push({
      rule_id: "state:flows",
      reason: bilingual(
        "尚未同步生产流量，无法判断哪条产线先补。",
        "Production flows are not synchronized, so the line to expand first cannot be determined.",
      ),
    });
  } else if (state.dynamicTruncated) {
    gaps.push({
      rule_id: "state:dynamic_truncated",
      reason: bilingual(
        "动态快照被裁剪，未出现的产物流不能当作 0。",
        "The dynamic snapshot was truncated, so omitted flows cannot be treated as zero.",
      ),
    });
  }
}

function nextGoal(
  stage: GuideStage,
  nextStage: GuideStage | undefined,
  stageComplete: boolean,
): LocalizedText {
  if (stageComplete && nextStage !== undefined) {
    return bilingual(
      `本阶段目标已达成，下一阶段是“${nextStage.title["zh-CN"]}”：${nextStage.goal["zh-CN"]}`,
      `This stage is complete; the next stage is ${nextStage.title.en}: ${nextStage.goal.en}`,
    );
  }
  return stage.goal;
}

function collectSources(
  guide: ProgressionGuide,
  stage: GuideStage,
  steps: readonly ProgressionStep[],
): GuideSource[] {
  const wanted = new Set<string>(stage.source_ids);
  for (const step of steps) {
    for (const id of step.source_ids) {
      wanted.add(id);
    }
  }
  return guide.sources.filter(({ id }) => wanted.has(id));
}

function toOverviewEntry(stage: GuideStage): StageOverviewEntry {
  return {
    id: stage.id,
    order: stage.order,
    title: stage.title,
    goal: stage.goal,
  };
}

function bilingual(zh: string, en: string): LocalizedText {
  return { "zh-CN": zh, en };
}

export function guideDescriptor(): {
  guide_version: string;
  guide_revision: number;
  factorio_version: string;
} {
  return {
    guide_version: GUIDE_VERSION,
    guide_revision: GUIDE_REVISION,
    factorio_version: GUIDE_FACTORIO_VERSION,
  };
}
