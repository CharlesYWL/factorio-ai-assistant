import type { AdvisorAlert, FlowMetric } from "@factorio-ai-assistant/protocol";

export type GuideLanguage = "zh-CN" | "en";

export type LocalizedText = Readonly<Record<GuideLanguage, string>>;

export type FlowWindow = "1m" | "10m";

export type ResourceKind = "item" | "fluid";

export interface GuideSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly accessed: string;
  readonly applies_to: string;
}

export interface TechnologyCondition {
  readonly kind: "technology_researched" | "technology_missing";
  readonly technology_id: string;
}

export interface ResearchCondition {
  readonly kind: "research_idle" | "research_active";
}

export interface FlowCondition {
  readonly kind:
    | "flow_produced_at_least"
    | "flow_produced_below"
    | "flow_net_below";
  readonly resource_kind: ResourceKind;
  readonly resource_id: string;
  readonly window: FlowWindow;
  readonly per_minute: number;
}

export type GuideCondition =
  | TechnologyCondition
  | ResearchCondition
  | FlowCondition;

export type ConditionOutcome = "met" | "unmet" | "unknown";

export interface GuideRule {
  readonly id: string;
  readonly order: number;
  readonly objective: LocalizedText;
  readonly rationale: LocalizedText;
  readonly verification: LocalizedText;
  readonly preconditions: readonly GuideCondition[];
  readonly verification_signals: readonly GuideCondition[];
  readonly next_rule_ids: readonly string[];
  readonly source_ids: readonly string[];
}

export interface GuideStage {
  readonly id: string;
  readonly order: number;
  readonly title: LocalizedText;
  readonly goal: LocalizedText;
  /** Every technology must be researched before the force is considered to have entered this stage. */
  readonly entry_technologies: readonly string[];
  /** Researching all of these marks the stage objective complete. */
  readonly completion_technologies: readonly string[];
  readonly rules: readonly GuideRule[];
  readonly source_ids: readonly string[];
}

export interface ProgressionGuide {
  readonly guide_version: string;
  readonly guide_revision: number;
  readonly game: string;
  readonly factorio_version: string;
  readonly data_source: string;
  readonly sources: readonly GuideSource[];
  readonly stages: readonly GuideStage[];
}

export interface ProgressionFlow extends FlowMetric {
  readonly kind: ResourceKind;
}

/**
 * A field left `undefined` means "not synchronized"; it is never treated as zero or as
 * "not researched". Truncated snapshots downgrade absent records to `unknown` as well.
 */
export interface ProgressionState {
  readonly force_id?: string;
  readonly researched_technologies?: readonly string[];
  readonly static_truncated?: boolean;
  readonly current_research?:
    | { readonly technology_id: string; readonly progress: number }
    | null
    | undefined;
  readonly flows?: readonly ProgressionFlow[];
  readonly dynamic_truncated?: boolean;
  readonly alerts?: readonly AdvisorAlert[];
}

export type StageBasis = "state" | "general";

export interface StageOverviewEntry {
  readonly id: string;
  readonly order: number;
  readonly title: LocalizedText;
  readonly goal: LocalizedText;
}

export interface ProgressionStageResult {
  readonly id: string;
  readonly order: number;
  readonly total: number;
  readonly title: LocalizedText;
  readonly goal: LocalizedText;
  readonly basis: StageBasis;
  readonly matched_technologies: readonly string[];
  readonly complete: boolean;
  /**
   * True when at least one stage gate could not be decided from the synchronized state,
   * so the reported stage is a lower bound rather than a confirmed position.
   */
  readonly uncertain: boolean;
}

export type StepOrigin = "bottleneck" | "guide";

export interface ProgressionStep {
  readonly order: number;
  readonly origin: StepOrigin;
  readonly rule_id: string;
  readonly objective: LocalizedText;
  readonly rationale: LocalizedText;
  readonly verification: LocalizedText;
  readonly source_ids: readonly string[];
  readonly alert_id?: string;
  readonly alert_severity?: AdvisorAlert["severity"];
}

export interface ProgressionGap {
  readonly rule_id: string;
  readonly reason: LocalizedText;
}

export interface ProgressionPlan {
  readonly guide_version: string;
  readonly guide_revision: number;
  readonly factorio_version: string;
  readonly stage: ProgressionStageResult;
  readonly next_stage: StageOverviewEntry | null;
  readonly next_goal: LocalizedText;
  readonly steps: readonly ProgressionStep[];
  readonly data_gaps: readonly ProgressionGap[];
  readonly sources: readonly GuideSource[];
  readonly stage_overview: readonly StageOverviewEntry[];
}

export interface ProgressionPlanOptions {
  readonly maxSteps?: number;
  readonly guide?: ProgressionGuide;
}
