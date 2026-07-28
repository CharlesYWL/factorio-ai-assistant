import type { ProductionResult } from "@factorio-ai-assistant/calculator";
import type {
  AdvisorAlert,
  DynamicForceSummary,
  FlowMetric,
} from "@factorio-ai-assistant/protocol";

import type { StaticState } from "./state-store.js";
import type { AssistantToolModelContext } from "./assistant-tools.js";

const MAX_TECHNOLOGIES = 64;
const MAX_FLOWS = 16;
const MAX_ALERTS = 3;
const MAX_CALCULATION_RECIPES = 32;

export interface ContextSources {
  staticState?: StaticState;
  dynamicForce?: DynamicForceSummary;
  alerts?: AdvisorAlert[];
  calculation?: ProductionResult;
  toolContext?: AssistantToolModelContext;
}

export type CompactModelContext = Record<string, unknown>;

export function buildCompactContext(
  question: string,
  sources: ContextSources,
  budgetBytes: number,
): CompactModelContext {
  const intent = classifyQuestion(question);
  const context: CompactModelContext = {
    context_schema_version: 1,
    quality: {
      static_available: sources.staticState !== undefined,
      static_truncated: sources.staticState?.truncated ?? false,
      dynamic_available: sources.dynamicForce !== undefined,
    },
  };
  const omitted: Record<string, number> = {};
  const force = sources.dynamicForce;

  if (sources.toolContext !== undefined) {
    appendToolContext(context, sources.toolContext, budgetBytes, omitted);
  }

  if (force !== undefined) {
    if (!trySet(context, "force_id", force.id, budgetBytes)) {
      omitted.force_id = 1;
    }
    if (
      !trySet(
        context,
        "current_research",
        force.research === null
          ? null
          : {
              technology_id: force.research.technology_id,
              progress: force.research.progress,
            },
        budgetBytes,
      )
    ) {
      omitted.current_research = 1;
    }
    if (intent.production || intent.advice) {
      if (!trySet(context, "power", { ...force.power }, budgetBytes)) {
        omitted.power = 1;
      }
      appendFlows(
        context,
        "production",
        selectFlows(question, force.items, force.fluids),
        budgetBytes,
        omitted,
      );
    }
  }

  if (intent.technology) {
    const staticForce = sources.staticState?.forces.find(
      ({ id }) => id === force?.id,
    );
    if (staticForce !== undefined) {
      const technologies = prioritizeIdentifiers(
        question,
        staticForce.researched_technologies,
      );
      if (
        !trySet(
          context,
          "researched_technology_count",
          staticForce.researched_technologies.length,
          budgetBytes,
        )
      ) {
        omitted.researched_technology_count = 1;
      }
      appendValues(
        context,
        "researched_technologies",
        technologies.slice(0, MAX_TECHNOLOGIES),
        budgetBytes,
        omitted,
      );
      if (technologies.length > MAX_TECHNOLOGIES) {
        omitted.researched_technologies =
          (omitted.researched_technologies ?? 0) +
          technologies.length -
          MAX_TECHNOLOGIES;
      }
    }
  }

  if (
    sources.toolContext === undefined &&
    (intent.advice || sources.alerts !== undefined)
  ) {
    const alerts = [...(sources.alerts ?? [])]
      .sort(compareAlerts)
      .slice(0, MAX_ALERTS)
      .map((alert) => ({
        id: alert.id,
        severity: alert.severity,
        evidence: alert.evidence,
        recommendation: alert.recommendation,
      }));
    appendValues(context, "active_alerts", alerts, budgetBytes, omitted);
    if ((sources.alerts?.length ?? 0) > MAX_ALERTS) {
        omitted.active_alerts =
          (omitted.active_alerts ?? 0) +
          (sources.alerts?.length ?? 0) -
          MAX_ALERTS;
    }
  }

  if (
    sources.toolContext === undefined &&
    sources.calculation !== undefined
  ) {
    appendCalculation(context, sources.calculation, budgetBytes, omitted);
  }

  if (Object.keys(omitted).length > 0) {
    const withOmitted = { ...context, omitted };
    if (encodedLength(withOmitted) <= budgetBytes) {
      context.omitted = omitted;
    }
  }

  if (encodedLength(context) > budgetBytes) {
    throw new Error(
      `Context minimum exceeds budget of ${budgetBytes} bytes`,
    );
  }
  return context;
}

function appendToolContext(
  context: CompactModelContext,
  toolContext: AssistantToolModelContext,
  budgetBytes: number,
  omitted: Record<string, number>,
): void {
  if (
    trySet(
      context,
      "deterministic_tools",
      {
        contract_version: toolContext.contract_version,
        policy: toolContext.policy,
        intent: toolContext.intent,
        calls: [],
        evidence: [],
        assumptions: [],
        missing_data: [],
      },
      budgetBytes,
    )
  ) {
    appendNestedValues(
      context,
      "deterministic_tools",
      "calls",
      toolContext.calls,
      budgetBytes,
      omitted,
    );
    appendNestedValues(
      context,
      "deterministic_tools",
      "evidence",
      toolContext.evidence,
      budgetBytes,
      omitted,
    );
    appendNestedValues(
      context,
      "deterministic_tools",
      "assumptions",
      toolContext.assumptions,
      budgetBytes,
      omitted,
    );
    appendNestedValues(
      context,
      "deterministic_tools",
      "missing_data",
      toolContext.missing_data,
      budgetBytes,
      omitted,
    );
    return;
  }

  omitted.deterministic_tools = 1;
}

function appendFlows(
  context: CompactModelContext,
  key: string,
  flows: Array<FlowMetric & { kind: "item" | "fluid" }>,
  budgetBytes: number,
  omitted: Record<string, number>,
): void {
  const values = flows.slice(0, MAX_FLOWS).map((flow) => ({
    kind: flow.kind,
    id: flow.id,
    produced_per_minute_1m: flow.produced_per_minute_1m,
    consumed_per_minute_1m: flow.consumed_per_minute_1m,
    produced_per_minute_10m: flow.produced_per_minute_10m,
    consumed_per_minute_10m: flow.consumed_per_minute_10m,
  }));
  appendValues(context, key, values, budgetBytes, omitted);
  if (flows.length > MAX_FLOWS) {
    omitted[key] = (omitted[key] ?? 0) + flows.length - MAX_FLOWS;
  }
}

function appendCalculation(
  context: CompactModelContext,
  calculation: ProductionResult,
  budgetBytes: number,
  omitted: Record<string, number>,
): void {
  const compact: Record<string, unknown> = {
    targets: calculation.targets.map((target) => ({
      kind: target.kind,
      id: target.id,
      per_minute: target.per_minute,
    })),
    assumptions: {
      byproduct_policy: calculation.assumptions.byproduct_policy,
      rounding: calculation.assumptions.rounding,
      source_resources: calculation.assumptions.source_resources,
    },
  };
  if (!trySet(context, "deterministic_calculation", compact, budgetBytes)) {
    omitted.deterministic_calculation = 1;
    return;
  }

  const recipes = calculation.recipes
    .slice(0, MAX_CALCULATION_RECIPES)
    .map((recipe) => ({
      recipe_id: recipe.recipe_id,
      machine_id: recipe.machine_id,
      machine_count_exact: recipe.machines.exact,
      machine_count_rounded_up: recipe.machines.rounded_up,
      module_ids: recipe.module_ids,
      technology_productivity_bonus: recipe.technology_productivity_bonus,
    }));
  appendNestedValues(
    context,
    "deterministic_calculation",
    "recipes",
    recipes,
    budgetBytes,
    omitted,
  );
  if (calculation.recipes.length > MAX_CALCULATION_RECIPES) {
    omitted.calculation_recipes =
      (omitted.calculation_recipes ?? 0) +
      calculation.recipes.length - MAX_CALCULATION_RECIPES;
  }

  appendNestedValues(
    context,
    "deterministic_calculation",
    "external_inputs",
    calculation.external_inputs.map((input) => ({
      kind: input.kind,
      id: input.id,
      per_minute: input.per_minute,
    })),
    budgetBytes,
    omitted,
  );
}

function appendNestedValues(
  context: CompactModelContext,
  parentKey: string,
  key: string,
  values: unknown[],
  budgetBytes: number,
  omitted: Record<string, number>,
): void {
  const parent = context[parentKey] as Record<string, unknown>;
  parent[key] = [];
  const target = parent[key] as unknown[];
  for (const value of values) {
    target.push(value);
    if (encodedLength(context) > budgetBytes) {
      target.pop();
      omitted[key] = (omitted[key] ?? 0) + 1;
    }
  }
  if (target.length === 0) {
    delete parent[key];
  }
}

function appendValues(
  context: CompactModelContext,
  key: string,
  values: unknown[],
  budgetBytes: number,
  omitted: Record<string, number>,
): void {
  context[key] = [];
  const target = context[key] as unknown[];
  for (const value of values) {
    target.push(value);
    if (encodedLength(context) > budgetBytes) {
      target.pop();
      omitted[key] = (omitted[key] ?? 0) + 1;
    }
  }
  if (target.length === 0) {
    delete context[key];
  }
}

function trySet(
  context: CompactModelContext,
  key: string,
  value: unknown,
  budgetBytes: number,
): boolean {
  context[key] = value;
  if (encodedLength(context) <= budgetBytes) {
    return true;
  }
  delete context[key];
  return false;
}

function classifyQuestion(question: string): {
  technology: boolean;
  production: boolean;
  advice: boolean;
} {
  const normalized = question.toLowerCase();
  const technology =
    /(?:research|technology|science|研究|科技|蓝瓶|紫瓶|黄瓶)/u.test(normalized);
  const production =
    /(?:production|factory|ratio|machine|power|oil|bottleneck|生产|产线|比例|机器|电力|石油|瓶颈|缺|停)/u.test(
      normalized,
    );
  const advice =
    /(?:why|next|should|problem|alert|为什么|下一步|建议|问题|告警|依据)/u.test(
      normalized,
    );
  return {
    technology,
    production: production || (!technology && !advice),
    advice: advice || (!technology && !production),
  };
}

function selectFlows(
  question: string,
  items: FlowMetric[],
  fluids: FlowMetric[],
): Array<FlowMetric & { kind: "item" | "fluid" }> {
  const normalized = question.toLowerCase();
  return [
    ...items.map((flow) => ({ ...flow, kind: "item" as const })),
    ...fluids.map((flow) => ({ ...flow, kind: "fluid" as const })),
  ].sort((left, right) => {
    const leftMentioned = normalized.includes(left.id.toLowerCase()) ? 1 : 0;
    const rightMentioned = normalized.includes(right.id.toLowerCase()) ? 1 : 0;
    return (
      rightMentioned - leftMentioned ||
      flowPriority(right) - flowPriority(left) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
    );
  });
}

function flowPriority(flow: FlowMetric): number {
  const deficit = Math.max(
    0,
    flow.consumed_per_minute_10m - flow.produced_per_minute_10m,
  );
  return (
    deficit * 10 +
    flow.produced_per_minute_1m +
    flow.consumed_per_minute_1m +
    flow.produced_per_minute_10m +
    flow.consumed_per_minute_10m
  );
}

function prioritizeIdentifiers(question: string, values: string[]): string[] {
  const normalized = question.toLowerCase();
  return [...values].sort((left, right) => {
    const leftMentioned = normalized.includes(left.toLowerCase()) ? 1 : 0;
    const rightMentioned = normalized.includes(right.toLowerCase()) ? 1 : 0;
    return rightMentioned - leftMentioned || left.localeCompare(right);
  });
}

function compareAlerts(left: AdvisorAlert, right: AdvisorAlert): number {
  const rank = { critical: 0, warning: 1, info: 2 };
  return (
    rank[left.severity] - rank[right.severity] ||
    left.first_seen - right.first_seen ||
    left.id.localeCompare(right.id)
  );
}

function encodedLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
