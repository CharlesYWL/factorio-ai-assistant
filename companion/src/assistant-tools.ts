import type { ProductionResult } from "@factorio-ai-assistant/calculator";
import type {
  ProgressionPlan,
  ProgressionStep,
} from "@factorio-ai-assistant/guide";
import type {
  AdvisorAlert,
  DynamicForceSummary,
  ResourceKind,
} from "@factorio-ai-assistant/protocol";

import type { AdvisorEngine } from "./advisor.js";
import {
  CalculationService,
  CalculationServiceError,
} from "./calculation-service.js";
import type { AssistantLanguage } from "./config.js";
import {
  MAX_PROGRESSION_STEPS,
  ProgressionService,
  type ProgressionResult,
} from "./progression-service.js";
import type { CompanionStateStore } from "./state-store.js";

export type AssistantIntent =
  | "calculation"
  | "diagnosis"
  | "research"
  | "planning"
  | "bottlenecks"
  | "evidence"
  | "general";

export type AssistantToolName =
  | "calculate_production_ratio"
  | "read_advisor_alerts"
  | "read_progression_guide";

export interface AssistantToolDefinition {
  name: AssistantToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

export const ASSISTANT_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [
  {
    name: "calculate_production_ratio",
    description:
      "Read-only deterministic production ratio calculation from synchronized Factorio prototypes.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["force_id", "target_kind", "target_id", "rate_per_minute"],
      properties: {
        force_id: { type: "string", minLength: 1, maxLength: 256 },
        target_kind: { enum: ["item", "fluid"] },
        target_id: { type: "string", minLength: 1, maxLength: 256 },
        rate_per_minute: { type: "number", exclusiveMinimum: 0 },
      },
    },
  },
  {
    name: "read_advisor_alerts",
    description:
      "Read-only access to at most three active deterministic advisor rules and their evidence.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["force_id", "limit"],
      properties: {
        force_id: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 3 },
      },
    },
  },
  {
    name: "read_progression_guide",
    description:
      "Read-only stage inference against the built-in, versioned Factorio 2.0 base-game progression guide; returns the current stage, ordered next steps, and data gaps.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["force_id", "max_steps"],
      properties: {
        force_id: { type: "string", minLength: 1, maxLength: 256 },
        max_steps: { type: "integer", minimum: 1, maximum: 3 },
      },
    },
  },
];

export interface AssistantToolCall {
  id: string;
  name: AssistantToolName;
  status: "ok" | "error";
  arguments: Record<string, string | number>;
  output?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
}

export interface GroundingEvidence {
  id: string;
  category: "fact" | "calculation" | "guide";
  text: string;
}

export interface GroundedAction {
  text: string;
  evidence_id: string;
}

export interface AssistantGrounding {
  intent: AssistantIntent;
  calls: AssistantToolCall[];
  evidence: GroundingEvidence[];
  actions: GroundedAction[];
  assumptions: string[];
  missingData: string[];
  localInference: string;
  alerts: AdvisorAlert[];
  calculation?: ProductionResult;
  progression?: ProgressionPlan;
}

export interface AssistantToolModelContext {
  contract_version: 1;
  policy: "read-only";
  intent: AssistantIntent;
  calls: AssistantToolCall[];
  evidence: GroundingEvidence[];
  assumptions: string[];
  missing_data: string[];
}

interface ParsedCalculation {
  forceId: string;
  targetKind: ResourceKind;
  targetId: string;
  ratePerMinute: number;
}

interface ResourceAlias {
  aliases: readonly string[];
  kind: ResourceKind;
  id: string;
}

const RESOURCE_ALIASES: readonly ResourceAlias[] = [
  {
    aliases: ["automation science", "red science", "红瓶"],
    kind: "item",
    id: "automation-science-pack",
  },
  {
    aliases: ["logistic science", "green science", "绿瓶"],
    kind: "item",
    id: "logistic-science-pack",
  },
  {
    aliases: ["military science", "black science", "黑瓶"],
    kind: "item",
    id: "military-science-pack",
  },
  {
    aliases: ["chemical science", "blue science", "蓝瓶"],
    kind: "item",
    id: "chemical-science-pack",
  },
  {
    aliases: ["production science", "purple science", "紫瓶"],
    kind: "item",
    id: "production-science-pack",
  },
  {
    aliases: ["utility science", "yellow science", "黄瓶"],
    kind: "item",
    id: "utility-science-pack",
  },
  {
    aliases: ["space science", "white science", "白瓶"],
    kind: "item",
    id: "space-science-pack",
  },
];

const OIL_RULES = new Set([
  "lubricant-zero",
  "oil-imbalance",
  "production-decline",
  "power-low",
]);
const RESEARCH_RULES = new Set(["research-idle", "robotics-stalled"]);

export class AssistantToolbox {
  readonly #stateStore: CompanionStateStore;
  readonly #advisor: AdvisorEngine;
  readonly #calculation: CalculationService;
  readonly #progression: ProgressionService;
  readonly #language: AssistantLanguage;

  public constructor(
    stateStore: CompanionStateStore,
    advisor: AdvisorEngine,
    language: AssistantLanguage,
  ) {
    this.#stateStore = stateStore;
    this.#advisor = advisor;
    this.#calculation = new CalculationService(stateStore);
    this.#progression = new ProgressionService(stateStore, advisor);
    this.#language = language;
  }

  public ground(
    question: string,
    requestedForceId?: string,
    suppliedCalculation?: ProductionResult,
  ): AssistantGrounding {
    const intent = classifyAssistantIntent(question);
    if (suppliedCalculation !== undefined) {
      return this.#calculationGrounding(
        intent,
        suppliedCalculation,
        requestedForceId,
      );
    }
    if (intent === "calculation") {
      return this.#runCalculation(question, requestedForceId);
    }
    if (intent === "planning" || intent === "research") {
      return this.#withProgression(
        this.#runAdvisor(intent, question, requestedForceId),
        question,
        requestedForceId,
      );
    }
    return this.#runAdvisor(intent, question, requestedForceId);
  }

  #withProgression(
    base: AssistantGrounding,
    question: string,
    requestedForceId: string | undefined,
  ): AssistantGrounding {
    const intent = base.intent;
    if (intent === "calculation") {
      return base;
    }
    const forceId =
      requestedForceId ??
      base.alerts[0]?.force_id ??
      this.#stateStore.dynamicState?.payload.forces[0]?.id;
    const result = this.#progression.plan({
      ...(forceId === undefined ? {} : { forceId }),
      maxSteps: MAX_PROGRESSION_STEPS,
      alerts: base.alerts,
    });
    const { plan } = result;

    const alertEvidenceIds = new Map<string, string>();
    for (const [index, alert] of base.alerts.entries()) {
      const evidenceId = base.evidence[index]?.id;
      if (evidenceId !== undefined) {
        alertEvidenceIds.set(alert.id, evidenceId);
      }
    }

    const guideEvidence: GroundingEvidence[] = [
      {
        id: "G1",
        category: "guide",
        text: stageEvidenceText(this.#language, plan),
      },
    ];
    const actions: GroundedAction[] = [];
    for (const step of plan.steps) {
      if (step.origin === "bottleneck") {
        actions.push({
          text: step.objective[this.#language],
          evidence_id:
            (step.alert_id === undefined
              ? undefined
              : alertEvidenceIds.get(step.alert_id)) ?? "G1",
        });
        continue;
      }
      const evidenceId = `G${guideEvidence.length + 1}`;
      guideEvidence.push({
        id: evidenceId,
        category: "guide",
        text: ruleEvidenceText(this.#language, step),
      });
      actions.push({
        text: step.objective[this.#language],
        evidence_id: evidenceId,
      });
    }

    const noAdvisorEvidence = missingAdvisorEvidence(
      this.#language,
      intent,
      question,
      this.#stateStore.dynamicState?.payload.forces.some(
        (force) => force.id === forceId,
      ) ?? false,
    );
    const missingData = base.missingData.filter(
      (entry) => actions.length === 0 || entry !== noAdvisorEvidence,
    );
    for (const gap of plan.data_gaps) {
      const reason = gap.reason[this.#language];
      if (!missingData.includes(reason)) {
        missingData.push(reason);
      }
    }
    if (!result.stateAvailable) {
      missingData.push(
        this.#language === "zh-CN"
          ? "尚未同步任何存档状态，以下只是通用流程阶段说明，不代表当前工厂。"
          : "No save state has been synchronized, so the following is a general stage overview rather than a statement about the current factory.",
      );
    }

    return {
      ...base,
      calls: orderProgressionCalls(
        intent,
        base.calls,
        progressionCall(result, this.#language),
      ),
      evidence: [...base.evidence, ...guideEvidence],
      actions,
      assumptions: [...base.assumptions, guideAssumption(this.#language, plan)],
      missingData,
      localInference: progressionInference(this.#language, plan, base.alerts.length),
      progression: plan,
    };
  }

  #runCalculation(
    question: string,
    requestedForceId: string | undefined,
  ): AssistantGrounding {
    const parsed = this.#parseCalculation(question, requestedForceId);
    if (typeof parsed === "string") {
      return this.#missingCalculation(parsed, requestedForceId);
    }

    const arguments_ = calculationArguments(parsed);
    try {
      return this.#calculationGrounding(
        "calculation",
        this.#calculation.calculateDetailed({
          force_id: parsed.forceId,
          target_kind: parsed.targetKind,
          target_id: parsed.targetId,
          rate_per_minute: parsed.ratePerMinute,
          module_ids: [],
        }),
        parsed.forceId,
      );
    } catch (error: unknown) {
      if (!(error instanceof CalculationServiceError)) {
        throw error;
      }
      return {
        intent: "calculation",
        calls: [
          {
            id: "tool-1",
            name: "calculate_production_ratio",
            status: "error",
            arguments: arguments_,
            error_code: error.code,
            error_message: error.message,
          },
        ],
        evidence: [],
        actions: [],
        assumptions: [],
        missingData: [
          this.#language === "zh-CN"
            ? `确定性计算不可用（${error.code}）：${error.message}`
            : `Deterministic calculation is unavailable (${error.code}): ${error.message}`,
        ],
        localInference:
          this.#language === "zh-CN"
            ? "没有足够的同步数据，不能安全给出机器数量。"
            : "There is not enough synchronized data to safely provide a machine count.",
        alerts: [],
      };
    }
  }

  #parseCalculation(
    question: string,
    requestedForceId: string | undefined,
  ): ParsedCalculation | string {
    const forceId =
      requestedForceId ??
      this.#stateStore.dynamicState?.payload.forces[0]?.id ??
      this.#stateStore.staticState?.forces[0]?.id;
    if (forceId === undefined) {
      return this.#language === "zh-CN"
        ? "尚未同步 force 信息。"
        : "No force information has been synchronized.";
    }

    const target = this.#findTarget(question);
    if (target === undefined) {
      return this.#language === "zh-CN"
        ? "请提供可识别的物品或流体名称，例如 chemical-science-pack。"
        : "Provide a recognizable item or fluid, such as chemical-science-pack.";
    }

    const ratePerMinute = parseRatePerMinute(question);
    if (ratePerMinute === undefined) {
      return this.#language === "zh-CN"
        ? "请提供大于 0 的每分钟目标产量。"
        : "Provide a per-minute target rate greater than zero.";
    }

    return {
      forceId,
      targetKind: target.targetKind,
      targetId: target.targetId,
      ratePerMinute,
    };
  }

  #findTarget(
    question: string,
  ): Pick<ParsedCalculation, "targetKind" | "targetId"> | undefined {
    const normalized = question.toLowerCase();
    for (const resource of RESOURCE_ALIASES) {
      if (resource.aliases.some((alias) => normalized.includes(alias))) {
        return { targetKind: resource.kind, targetId: resource.id };
      }
    }

    const products = new Map<string, ResourceKind>();
    for (const recipe of this.#stateStore.staticState?.recipes ?? []) {
      for (const product of recipe.products) {
        products.set(product.id.toLowerCase(), product.kind);
      }
    }
    const matchedId = [...products.keys()]
      .sort((left, right) => right.length - left.length)
      .find((id) => normalized.includes(id));
    if (matchedId === undefined) {
      return undefined;
    }
    const kind = products.get(matchedId);
    if (kind === undefined) {
      return undefined;
    }
    return { targetKind: kind, targetId: matchedId };
  }

  #missingCalculation(
    message: string,
    requestedForceId: string | undefined,
  ): AssistantGrounding {
    return {
      intent: "calculation",
      calls: [
        {
          id: "tool-1",
          name: "calculate_production_ratio",
          status: "error",
          arguments:
            requestedForceId === undefined
              ? {}
              : { force_id: requestedForceId },
          error_code: "INVALID_ARGUMENT",
          error_message: message,
        },
      ],
      evidence: [],
      actions: [],
      assumptions: [],
      missingData: [message],
      localInference:
        this.#language === "zh-CN"
          ? "缺少计算参数，因此没有生成机器数量。"
          : "No machine count was generated because calculation inputs are missing.",
      alerts: [],
    };
  }

  #calculationGrounding(
    intent: AssistantIntent,
    calculation: ProductionResult,
    forceId: string | undefined,
  ): AssistantGrounding {
    const target = calculation.targets[0];
    if (target === undefined) {
      throw new Error("Deterministic calculation returned no target");
    }
    const targetKey = `${target.kind}:${target.id}`;
    const selectedRecipeId =
      calculation.assumptions.recipe_selections[targetKey] ?? target.id;
    const recipe =
      calculation.recipes.find(
        ({ recipe_id }) => recipe_id === selectedRecipeId,
      ) ?? calculation.recipes[0];
    const evidenceText =
      recipe === undefined
        ? this.#language === "zh-CN"
          ? `目标 ${target.id} 为 ${formatNumber(target.per_minute)}/min；确定性求解器没有返回目标配方。`
          : `The ${target.id} target is ${formatNumber(target.per_minute)}/min; the deterministic solver returned no target recipe.`
        : this.#language === "zh-CN"
          ? `${target.id} ${formatNumber(target.per_minute)}/min：${recipe.recipe_id} 需要 ${formatNumber(recipe.machines.exact)} 台 ${recipe.machine_id}，向上取整为 ${recipe.machines.rounded_up} 台。`
          : `${target.id} at ${formatNumber(target.per_minute)}/min requires ${formatNumber(recipe.machines.exact)} ${recipe.machine_id} for ${recipe.recipe_id}, rounded up to ${recipe.machines.rounded_up}.`;
    const output: Record<string, unknown> = {
      target: {
        kind: target.kind,
        id: target.id,
        per_minute: target.per_minute,
      },
      ...(recipe === undefined
        ? {}
        : {
            target_recipe: {
              recipe_id: recipe.recipe_id,
              machine_id: recipe.machine_id,
              machines_exact: recipe.machines.exact,
              machines_rounded_up: recipe.machines.rounded_up,
            },
          }),
    };
    const arguments_: Record<string, string | number> = {
      ...(forceId === undefined ? {} : { force_id: forceId }),
      target_kind: target.kind,
      target_id: target.id,
      rate_per_minute: target.per_minute,
    };
    const missingData =
      recipe === undefined
        ? [
            this.#language === "zh-CN"
              ? "目标配方缺失，无法给出可执行的建造数量。"
              : "The target recipe is missing, so no build count can be recommended.",
          ]
        : [];
    const actions =
      recipe === undefined
        ? []
        : [
            {
              text:
                this.#language === "zh-CN"
                  ? `按满负载上限准备 ${recipe.machines.rounded_up} 台 ${recipe.machine_id}；若允许非满负载，精确需求为 ${formatNumber(recipe.machines.exact)} 台。`
                  : `Plan for ${recipe.machines.rounded_up} ${recipe.machine_id} at full-load capacity; the exact fractional requirement is ${formatNumber(recipe.machines.exact)}.`,
              evidence_id: "C1",
            },
          ];

    return {
      intent,
      calls: [
        {
          id: "tool-1",
          name: "calculate_production_ratio",
          status: "ok",
          arguments: arguments_,
          output,
        },
      ],
      evidence: [
        {
          id: "C1",
          category: "calculation",
          text: evidenceText,
        },
      ],
      actions,
      assumptions: [
        this.#language === "zh-CN"
          ? "配方、机器、插件和科技加成来自当前已同步的 force；未指定机器或插件时由确定性求解器选择。"
          : "Recipes, machines, modules, and technology bonuses come from the synchronized force; the deterministic solver selects unspecified machines and modules.",
        calculation.assumptions.rounding,
      ],
      missingData,
      localInference:
        this.#language === "zh-CN"
          ? "机器数量直接采用确定性计算结果，不由模型估算。"
          : "Machine counts come directly from the deterministic calculation, not a model estimate.",
      alerts: [],
      calculation,
    };
  }

  #runAdvisor(
    intent: Exclude<AssistantIntent, "calculation">,
    question: string,
    requestedForceId: string | undefined,
  ): AssistantGrounding {
    const dynamicForces = this.#stateStore.dynamicState?.payload.forces ?? [];
    const dynamicForce =
      requestedForceId === undefined
        ? dynamicForces[0]
        : dynamicForces.find(({ id }) => id === requestedForceId);
    const forceId = dynamicForce?.id ?? requestedForceId;
    const availableAlerts = this.#advisor.activeAlerts.filter(
      (alert) => forceId === undefined || alert.force_id === forceId,
    );
    const alerts = selectAlerts(intent, question, availableAlerts).slice(0, 3);
    const evidence: GroundingEvidence[] = alerts.map((alert, index) => ({
      id: `A${index + 1}`,
      category: "fact" as const,
      text: alert.evidence,
    }));
    if (dynamicForce !== undefined) {
      evidence.push(...synchronizedStateEvidence(this.#language, dynamicForce));
    }
    const actions = alerts.map((alert, index) => ({
      text: alert.recommendation,
      evidence_id: `A${index + 1}`,
    }));
    const missingData: string[] = [];

    if (dynamicForce === undefined) {
      missingData.push(
        this.#language === "zh-CN"
          ? "尚未收到该 force 的动态快照，不能声称读取了当前工厂状态。"
          : "No dynamic snapshot is available for this force, so current factory state cannot be claimed.",
      );
    } else if (this.#stateStore.dynamicState?.payload.truncated === true) {
      missingData.push(
        this.#language === "zh-CN"
          ? "最新动态快照已裁剪，未出现的产物流不能视为 0。"
          : "The latest dynamic snapshot was truncated; omitted flows cannot be treated as zero.",
      );
    }

    if (alerts.length === 0) {
      missingData.push(
        missingAdvisorEvidence(
          this.#language,
          intent,
          question,
          dynamicForce !== undefined,
        ),
      );
    } else if (intent === "diagnosis") {
      missingData.push(diagnosisLimitation(this.#language, question));
    }

    return {
      intent,
      calls: [
        {
          id: "tool-1",
          name: "read_advisor_alerts",
          status: dynamicForce === undefined ? "error" : "ok",
          arguments: {
            ...(forceId === undefined ? {} : { force_id: forceId }),
            limit: 3,
          },
          ...(dynamicForce === undefined
            ? {
                error_code: "STATE_UNAVAILABLE",
                error_message: missingData[0] ?? "Dynamic state is unavailable",
              }
            : {
                output: {
                  alerts: alerts.map((alert, index) => ({
                    evidence_id: `A${index + 1}`,
                    rule_id: alert.rule_id,
                    severity: alert.severity,
                    evidence: alert.evidence,
                    recommendation: alert.recommendation,
                  })),
                  synchronized_snapshot: {
                    evidence_ids: ["S1", "S2", "S3"],
                    truncated:
                      this.#stateStore.dynamicState?.payload.truncated === true,
                  },
                },
              }),
        },
      ],
      evidence,
      actions,
      assumptions: [
        this.#language === "zh-CN"
          ? "瓶颈按严重度、首次触发时间和规则 ID 排序，最多返回 3 项。"
          : "Bottlenecks are ordered by severity, first-seen time, and rule ID, with a maximum of three.",
      ],
      missingData,
      localInference: localAdvisorInference(
        this.#language,
        intent,
        alerts.length,
        dynamicForce !== undefined,
      ),
      alerts,
    };
  }
}

export function toAssistantToolModelContext(
  grounding: AssistantGrounding,
): AssistantToolModelContext {
  return {
    contract_version: 1,
    policy: "read-only",
    intent: grounding.intent,
    calls: grounding.calls,
    evidence: grounding.evidence,
    assumptions: grounding.assumptions,
    missing_data: grounding.missingData,
  };
}

function orderProgressionCalls(
  intent: AssistantIntent,
  baseCalls: AssistantToolCall[],
  guideCall: Omit<AssistantToolCall, "id">,
): AssistantToolCall[] {
  const ordered =
    intent === "planning"
      ? [guideCall, ...baseCalls]
      : [...baseCalls, guideCall];
  return ordered.map((call, index) => ({ ...call, id: `tool-${index + 1}` }));
}

function progressionCall(
  result: ProgressionResult,
  language: AssistantLanguage,
): Omit<AssistantToolCall, "id"> {
  const { plan } = result;
  return {
    name: "read_progression_guide",
    status: result.stateAvailable ? "ok" : "error",
    arguments: {
      ...(result.forceId === undefined ? {} : { force_id: result.forceId }),
      max_steps: MAX_PROGRESSION_STEPS,
    },
    ...(result.stateAvailable
      ? {}
      : {
          error_code: "STATE_UNAVAILABLE",
          error_message:
            language === "zh-CN"
              ? "没有同步状态，只能给出通用阶段说明。"
              : "No synchronized state is available; only a general stage overview can be given.",
        }),
    output: {
      guide_version: plan.guide_version,
      guide_revision: plan.guide_revision,
      guide_factorio_version: plan.factorio_version,
      stage: {
        id: plan.stage.id,
        order: plan.stage.order,
        total: plan.stage.total,
        basis: plan.stage.basis,
        complete: plan.stage.complete,
        uncertain: plan.stage.uncertain,
        title: plan.stage.title[language],
      },
      next_stage_id: plan.next_stage?.id ?? null,
      steps: plan.steps.map((step) => ({
        order: step.order,
        origin: step.origin,
        rule_id: step.rule_id,
        objective: step.objective[language],
      })),
      data_gap_rule_ids: plan.data_gaps.map(({ rule_id }) => rule_id),
      sources: plan.sources.map(({ id, url, accessed }) => ({ id, url, accessed })),
    },
  };
}

function stageEvidenceText(
  language: AssistantLanguage,
  plan: ProgressionPlan,
): string {
  const stage = plan.stage;
  if (stage.basis === "general") {
    return language === "zh-CN"
      ? `内置流程指南 ${plan.guide_version}（Factorio ${plan.factorio_version} 原版）共 ${stage.total} 个阶段；没有同步状态时按第 ${stage.order} 阶段“${stage.title["zh-CN"]}”给出通用说明，目标是${stage.goal["zh-CN"]}`
      : `Built-in progression guide ${plan.guide_version} (Factorio ${plan.factorio_version} base game) has ${stage.total} stages; without synchronized state it describes stage ${stage.order}, ${stage.title.en}, whose goal is: ${stage.goal.en}`;
  }
  const basis =
    stage.matched_technologies.length === 0
      ? language === "zh-CN"
        ? "尚无阶段门槛科技"
        : "no stage gate technology yet"
      : stage.matched_technologies.join(", ");
  if (stage.uncertain) {
    return language === "zh-CN"
      ? `内置流程指南 ${plan.guide_version}（Factorio ${plan.factorio_version} 原版）按已同步科技（${basis}）判定至少处于第 ${stage.order}/${stage.total} 阶段“${stage.title["zh-CN"]}”；静态状态被裁剪，部分阶段门槛无法确认，实际进度可能更靠后。下一目标：${plan.next_goal["zh-CN"]}`
      : `Built-in progression guide ${plan.guide_version} (Factorio ${plan.factorio_version} base game) places this force at stage ${stage.order}/${stage.total} or later, ${stage.title.en}, from the synchronized technologies (${basis}); the static state was truncated so some stage gates are unconfirmed and real progress may be further along. Next goal: ${plan.next_goal.en}`;
  }
  return language === "zh-CN"
    ? `内置流程指南 ${plan.guide_version}（Factorio ${plan.factorio_version} 原版）按已研究科技（${basis}）判定当前处于第 ${stage.order}/${stage.total} 阶段“${stage.title["zh-CN"]}”；下一目标：${plan.next_goal["zh-CN"]}`
    : `Built-in progression guide ${plan.guide_version} (Factorio ${plan.factorio_version} base game) places this force in stage ${stage.order}/${stage.total}, ${stage.title.en}, based on researched technologies (${basis}); next goal: ${plan.next_goal.en}`;
}

function ruleEvidenceText(
  language: AssistantLanguage,
  step: ProgressionStep,
): string {
  return language === "zh-CN"
    ? `指南规则 ${step.rule_id}：${step.rationale["zh-CN"]}（验证信号：${step.verification["zh-CN"]}）`
    : `Guide rule ${step.rule_id}: ${step.rationale.en} (verification: ${step.verification.en})`;
}

function guideAssumption(
  language: AssistantLanguage,
  plan: ProgressionPlan,
): string {
  return language === "zh-CN"
    ? `流程建议来自仓库内置的 Factorio 2.0 原版指南 ${plan.guide_version}（修订 ${plan.guide_revision}，对应 ${plan.factorio_version}），运行时不联网；它描述的是通用原版流程，不包含本存档的地图布局、库存、皮带或单机状态。`
    : `Progression advice comes from the repository's built-in Factorio 2.0 base-game guide ${plan.guide_version} (revision ${plan.guide_revision}, targeting ${plan.factorio_version}) with no runtime network access; it describes the generic vanilla route and knows nothing about this save's map layout, inventory, belts, or individual machines.`;
}

function progressionInference(
  language: AssistantLanguage,
  plan: ProgressionPlan,
  alertCount: number,
): string {
  if (language === "zh-CN") {
    if (plan.stage.basis === "general") {
      return "没有同步状态，只能按内置指南给出通用阶段顺序，不能声称了解当前工厂。";
    }
    return alertCount === 0
      ? "阶段判定来自已研究科技与指南规则匹配，步骤顺序由规则顺序决定，不是模型自行排序。"
      : "活动瓶颈排在通用流程步骤之前：先按规则证据修复当前产线，再推进阶段目标。";
  }
  if (plan.stage.basis === "general") {
    return "Without synchronized state only the generic stage order from the built-in guide can be given; the current factory is unknown.";
  }
  return alertCount === 0
    ? "The stage comes from researched technologies matched against guide rules, and the step order follows the rule order rather than a model ranking."
    : "Active bottlenecks are ordered ahead of generic stage steps: repair the current line from rule evidence first, then advance the stage goal.";
}

export function formatGroundedAnswer(
  language: AssistantLanguage,
  grounding: AssistantGrounding,
  modelInference?: string,
): string {
  const lines: string[] = [];
  const calculations = grounding.evidence.filter(
    ({ category }) => category === "calculation",
  );
  const facts = grounding.evidence.filter(
    ({ category }) => category === "fact",
  );
  const guide = grounding.evidence.filter(
    ({ category }) => category === "guide",
  );

  appendSection(
    lines,
    language === "zh-CN" ? "[计算结果]" : "[Calculation]",
    calculations.map(({ id, text }) => `[${id}] ${text}`),
  );
  appendSection(
    lines,
    language === "zh-CN" ? "[事实]" : "[Facts]",
    facts.map(({ id, text }) => `[${id}] ${text}`),
  );
  appendSection(
    lines,
    language === "zh-CN" ? "[流程指南]" : "[Progression guide]",
    guide.map(({ id, text }) => `[${id}] ${text}`),
  );
  appendSection(
    lines,
    language === "zh-CN" ? "[推断]" : "[Inference]",
    [modelInference ?? grounding.localInference],
  );
  appendSection(
    lines,
    language === "zh-CN" ? "[缺失数据]" : "[Missing data]",
    grounding.missingData,
  );
  appendSection(
    lines,
    language === "zh-CN" ? "[假设]" : "[Assumptions]",
    grounding.assumptions,
  );

  if (grounding.actions.length > 0) {
    lines.push(language === "zh-CN" ? "[行动]" : "[Actions]");
    for (const [index, action] of grounding.actions.slice(0, 3).entries()) {
      lines.push(
        `${index + 1}. ${action.text} ` +
          (language === "zh-CN"
            ? `（证据：[${action.evidence_id}]）`
            : `(evidence: [${action.evidence_id}])`),
      );
    }
  }

  return lines.join("\n");
}

function classifyAssistantIntent(question: string): AssistantIntent {
  const normalized = question.toLowerCase();
  const asksForMachines =
    /(?:多少|几).{0,12}(?:机器|机台)|(?:机器|机台).{0,12}(?:多少|几)|how many machines|machines? (?:do|would|are) .*need|production ratio|生产比例/u.test(
      normalized,
    );
  const perMinute = /每\s*分钟|\/\s*min(?:ute)?|per\s+minute/u.test(
    normalized,
  );
  if (asksForMachines && perMinute) {
    return "calculation";
  }
  if (/(?:依据|证据|数据来源|based on what|what data|evidence)/u.test(normalized)) {
    return "evidence";
  }
  if (
    /(?:最大的?.{0,4}(?:三个|3个|3 个)?.{0,4}瓶颈|前三.{0,3}瓶颈|top\s*3.*bottleneck|biggest.*bottleneck)/u.test(
      normalized,
    )
  ) {
    return "bottlenecks";
  }
  if (/(?:为什么|停了|停止|故障|why|stopped|not working)/u.test(normalized)) {
    return "diagnosis";
  }
  if (
    /(?:下一步|接下来|下面.{0,3}该|该做什么|做什么好|该建什么|建什么好|扩建|该扩|规划|路线|流程|阶段|通关|next step|what.*next|should i (?:do|build|expand)|what to build|what to expand|road ?map|progression)/u.test(
      normalized,
    )
  ) {
    return "planning";
  }
  if (/(?:研究什么|科技|research next|what.*research)/u.test(normalized)) {
    return "research";
  }
  return "general";
}

function parseRatePerMinute(question: string): number | undefined {
  const normalized = question.toLowerCase();
  const marker = /每\s*分钟|\/\s*min(?:ute)?|per\s+minute/u.exec(normalized);
  if (marker === null) {
    return undefined;
  }
  const beforeMarker = normalized.slice(0, marker.index);
  const beforeValues = [...beforeMarker.matchAll(/\d+(?:\.\d+)?/g)];
  const before = beforeValues.at(-1)?.[0];
  const after = normalized
    .slice(marker.index + marker[0].length)
    .match(/\d+(?:\.\d+)?/)?.[0];
  const value = Number(before ?? after);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function calculationArguments(
  parsed: ParsedCalculation,
): Record<string, string | number> {
  return {
    force_id: parsed.forceId,
    target_kind: parsed.targetKind,
    target_id: parsed.targetId,
    rate_per_minute: parsed.ratePerMinute,
  };
}

function selectAlerts(
  intent: Exclude<AssistantIntent, "calculation">,
  question: string,
  alerts: AdvisorAlert[],
): AdvisorAlert[] {
  if (intent === "research") {
    return alerts.filter(({ rule_id }) => RESEARCH_RULES.has(rule_id));
  }
  if (
    intent === "diagnosis" &&
    /(?:油|炼油|石油|润滑|oil|refin|petroleum|lubricant)/u.test(
      question.toLowerCase(),
    )
  ) {
    return alerts.filter(({ rule_id }) => OIL_RULES.has(rule_id));
  }
  return alerts;
}

function synchronizedStateEvidence(
  language: AssistantLanguage,
  force: DynamicForceSummary,
): GroundingEvidence[] {
  const power = force.power;
  const powerText =
    language === "zh-CN"
      ? `电力网络 ${power.network_count} 个；发电 ${formatPower(power.generated_watts)}；用电 ${formatPower(power.consumed_watts)}；满足率 ${formatNumber(power.satisfaction_ratio * 100)}%。`
      : `Power networks: ${power.network_count}; generation: ${formatPower(power.generated_watts)}; consumption: ${formatPower(power.consumed_watts)}; satisfaction: ${formatNumber(power.satisfaction_ratio * 100)}%.`;
  const researchText =
    force.research === null
      ? language === "zh-CN"
        ? "当前没有进行中的研究。"
        : "No research is currently active."
      : language === "zh-CN"
        ? `当前研究 ${force.research.technology_id}；进度 ${formatNumber(force.research.progress * 100)}%。`
        : `Current research: ${force.research.technology_id}; progress: ${formatNumber(force.research.progress * 100)}%.`;

  return [
    { id: "S1", category: "fact", text: powerText },
    { id: "S2", category: "fact", text: researchText },
    productionFlowEvidence(language, force),
  ];
}

function productionFlowEvidence(
  language: AssistantLanguage,
  force: DynamicForceSummary,
): GroundingEvidence {
  const flows = [
    ...force.items.map((metric) => ({ kind: "item" as const, ...metric })),
    ...force.fluids.map((metric) => ({ kind: "fluid" as const, ...metric })),
  ]
    .map((flow) => ({
      ...flow,
      deficit: flow.consumed_per_minute_1m - flow.produced_per_minute_1m,
      throughput:
        flow.consumed_per_minute_1m + flow.produced_per_minute_1m,
    }))
    .filter(({ throughput }) => throughput > 0);
  const deficits = flows
    .filter(({ deficit }) => deficit > 0)
    .sort(
      (left, right) =>
        right.deficit - left.deficit ||
        right.throughput - left.throughput ||
        left.id.localeCompare(right.id),
    );
  const candidates = (deficits.length > 0
    ? deficits
    : flows.sort(
        (left, right) =>
          right.throughput - left.throughput ||
          left.id.localeCompare(right.id),
      )
  ).slice(0, 3);

  if (candidates.length === 0) {
    return {
      id: "S3",
      category: "fact",
      text:
        language === "zh-CN"
          ? "当前动态快照没有非零生产或消耗流量。"
          : "The current dynamic snapshot contains no nonzero production or consumption flow.",
    };
  }

  const entries = candidates.map((candidate) => {
    const kind =
      language === "zh-CN"
        ? candidate.kind === "item"
          ? "物品"
          : "流体"
        : candidate.kind;
    const base =
      language === "zh-CN"
        ? `${kind} ${candidate.id}（产出 ${formatNumber(candidate.produced_per_minute_1m)}/min，消耗 ${formatNumber(candidate.consumed_per_minute_1m)}/min`
        : `${kind} ${candidate.id} (produced ${formatNumber(candidate.produced_per_minute_1m)}/min, consumed ${formatNumber(candidate.consumed_per_minute_1m)}/min`;
    if (deficits.length === 0) {
      return `${base}${language === "zh-CN" ? "）" : ")"}`;
    }
    return language === "zh-CN"
      ? `${base}，净缺口 ${formatNumber(candidate.deficit)}/min）`
      : `${base}, net deficit ${formatNumber(candidate.deficit)}/min)`;
  });
  const text =
    language === "zh-CN"
      ? deficits.length > 0
        ? `1 分钟净缺口候选：${entries.join("；")}。`
        : `1 分钟样本未发现正净缺口；高吞吐项：${entries.join("；")}。`
      : deficits.length > 0
        ? `One-minute net-deficit candidates: ${entries.join("; ")}.`
        : `The one-minute sample has no positive net deficit; high-throughput flows: ${entries.join("; ")}.`;

  return { id: "S3", category: "fact", text };
}

function missingAdvisorEvidence(
  language: AssistantLanguage,
  intent: Exclude<AssistantIntent, "calculation">,
  question: string,
  hasDynamicState: boolean,
): string {
  const oilQuestion =
    intent === "diagnosis" &&
    /(?:油|炼油|石油|润滑|oil|refin|petroleum|lubricant)/u.test(
      question.toLowerCase(),
    );
  if (language === "zh-CN") {
    if (oilQuestion) {
      return "当前规则没有触发与炼油相关的证据，且未采集单机/管道状态；无法确定高级炼油停顿的具体原因。";
    }
    if (intent === "research") {
      return "当前没有触发科研建议规则；需要更多科研包供需或目标信息后才能排序科技。";
    }
    if (hasDynamicState) {
      return "当前没有持续性规则告警；[S3] 只按 force 级 1 分钟聚合净流量排序，不含库存、皮带和单机停机原因。";
    }
    return "当前本地规则没有活动告警，不能据此虚构瓶颈。";
  }
  if (oilQuestion) {
    return "No oil-related rule is active and per-machine or pipe state is not collected, so the exact refinery stop cannot be determined.";
  }
  if (intent === "research") {
    return "No research recommendation rule is active; more science supply or goal information is needed to rank technologies.";
  }
  if (hasDynamicState) {
    return "No persistent advisor rule is active; [S3] ranks only force-level one-minute aggregate net flow and does not include inventory, belts, or per-machine stop causes.";
  }
  return "No local rule is active, so a bottleneck cannot be invented from this data.";
}

function diagnosisLimitation(
  language: AssistantLanguage,
  question: string,
): string {
  const oilQuestion =
    /(?:油|炼油|石油|润滑|oil|refin|petroleum|lubricant)/u.test(
      question.toLowerCase(),
    );
  if (language === "zh-CN") {
    return oilQuestion
      ? "采集数据是 force 级聚合流量，不含单台炼油厂的配方、管道、输入库存或输出堵塞；下列信号只能缩小原因范围。"
      : "采集数据是 force 级聚合流量，不含单台机器的配方、输入库存或输出堵塞；下列信号只能缩小原因范围。";
  }
  return oilQuestion
    ? "Collected data is force-level aggregate flow and does not include each refinery recipe, pipe, input inventory, or blocked output; these signals only narrow the cause."
    : "Collected data is force-level aggregate flow and does not include each machine recipe, input inventory, or blocked output; these signals only narrow the cause.";
}

function localAdvisorInference(
  language: AssistantLanguage,
  intent: Exclude<AssistantIntent, "calculation">,
  alertCount: number,
  hasDynamicState: boolean,
): string {
  if (language === "zh-CN") {
    if (alertCount === 0) {
      return hasDynamicState
        ? "电力、科研和生产净流量来自最新同步快照；[S3] 给出扩建候选，但不能单独证明具体机器根因。"
        : "当前为本地模式（确定性规则）；没有足够证据形成状态结论。";
    }
    if (intent === "diagnosis") {
      return "这些规则信号给出可能原因范围，但不能证明某一台机器或管道就是根因。";
    }
    if (intent === "research") {
      return "研究顺序来自已触发的确定性规则，不是模型自行选择。";
    }
    return "优先级来自确定性规则的严重度与触发证据。";
  }
  if (alertCount === 0) {
    return hasDynamicState
      ? "Power, research, and production net flow come from the latest synchronized snapshot; [S3] supplies expansion candidates but does not prove a specific machine-level root cause."
      : "Local rule mode has insufficient evidence for a state conclusion.";
  }
  if (intent === "diagnosis") {
    return "These rule signals narrow possible causes but do not prove that one machine or pipe is the root cause.";
  }
  if (intent === "research") {
    return "Research ordering comes from active deterministic rules, not a model-selected guess.";
  }
  return "Priority comes from deterministic rule severity and triggering evidence.";
}

function appendSection(lines: string[], heading: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }
  lines.push(heading);
  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1_000) / 1_000);
}

function formatPower(value: number): string {
  if (value >= 1_000_000_000) {
    return `${formatNumber(value / 1_000_000_000)} GW`;
  }
  if (value >= 1_000_000) {
    return `${formatNumber(value / 1_000_000)} MW`;
  }
  if (value >= 1_000) {
    return `${formatNumber(value / 1_000)} kW`;
  }
  return `${formatNumber(value)} W`;
}
