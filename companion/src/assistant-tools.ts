import type { ProductionResult } from "@factorio-ai-assistant/calculator";
import type {
  AdvisorAlert,
  ResourceKind,
} from "@factorio-ai-assistant/protocol";

import type { AdvisorEngine } from "./advisor.js";
import {
  CalculationService,
  CalculationServiceError,
} from "./calculation-service.js";
import type { AssistantLanguage } from "./config.js";
import type { CompanionStateStore } from "./state-store.js";

export type AssistantIntent =
  | "calculation"
  | "diagnosis"
  | "research"
  | "bottlenecks"
  | "evidence"
  | "general";

export type AssistantToolName =
  | "calculate_production_ratio"
  | "read_advisor_alerts";

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
  category: "fact" | "calculation";
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
  readonly #language: AssistantLanguage;

  public constructor(
    stateStore: CompanionStateStore,
    advisor: AdvisorEngine,
    language: AssistantLanguage,
  ) {
    this.#stateStore = stateStore;
    this.#advisor = advisor;
    this.#calculation = new CalculationService(stateStore);
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
    return this.#runAdvisor(intent, question, requestedForceId);
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
    const evidence = alerts.map((alert, index) => ({
      id: `A${index + 1}`,
      category: "fact" as const,
      text: alert.evidence,
    }));
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
      missingData.push(missingAdvisorEvidence(this.#language, intent, question));
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
      localInference: localAdvisorInference(this.#language, intent, alerts.length),
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
  if (/(?:研究什么|科技|research next|what.*research)/u.test(normalized)) {
    return "research";
  }
  if (/(?:为什么|停了|停止|故障|why|stopped|not working)/u.test(normalized)) {
    return "diagnosis";
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

function missingAdvisorEvidence(
  language: AssistantLanguage,
  intent: Exclude<AssistantIntent, "calculation">,
  question: string,
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
    return "当前本地规则没有活动告警，不能据此虚构瓶颈。";
  }
  if (oilQuestion) {
    return "No oil-related rule is active and per-machine or pipe state is not collected, so the exact refinery stop cannot be determined.";
  }
  if (intent === "research") {
    return "No research recommendation rule is active; more science supply or goal information is needed to rank technologies.";
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
): string {
  if (language === "zh-CN") {
    if (alertCount === 0) {
      return "当前为本地模式（确定性规则）；没有足够证据形成状态结论。";
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
    return "Local rule mode has insufficient evidence for a state conclusion.";
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
