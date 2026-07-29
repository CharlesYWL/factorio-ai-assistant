import type {
  AdvisorAlert,
  AreaSnapshotPacket,
  AssistantHistoryTurn,
  DynamicForceSummary,
} from "@factorio-ai-assistant/protocol";

import { IDENTIFIER_NAMES, type LocalizedNameLookup } from "./localization.js";
import { buildRecipeContext, type RecipeContext } from "./recipe-context.js";
import type { StaticState } from "./state-store.js";

const MAX_FLOWS = 20;
const MAX_ALERTS = 3;
const MAX_TECHNOLOGIES = 128;

export interface ContextSources {
  staticState?: StaticState;
  dynamicForce?: DynamicForceSummary;
  alerts?: AdvisorAlert[];
  names?: LocalizedNameLookup;
  history?: readonly AssistantHistoryTurn[];
  forceId?: string;
  /** What the player last framed with the inspector tool. */
  areaSelection?: AreaSnapshotPacket;
}

export type CompactModelContext = Record<string, unknown>;

/**
 * Assembles what the model needs to answer, then trims to fit the byte budget.
 *
 * The Companion deliberately does not interpret the question: it does not
 * classify intent, parse rates, or resolve which product is the "target". It
 * only supplies the recipe subgraph for whatever products the question names,
 * plus current factory state, and lets the model do the reasoning. This matters
 * because recipes come from the player's actual save, which mods may have
 * changed, so the data must be authoritative even though the reasoning is not.
 */
export function buildCompactContext(
  question: string,
  sources: ContextSources,
  budgetBytes: number,
): CompactModelContext {
  const names = sources.names ?? IDENTIFIER_NAMES;
  const context: CompactModelContext = {
    context_schema_version: 2,
    data_quality: {
      recipes_available: sources.staticState !== undefined,
      recipes_truncated: sources.staticState?.truncated ?? false,
      live_state_available: sources.dynamicForce !== undefined,
    },
  };

  const recipeContext = buildRecipeContext(
    question,
    sources.staticState,
    names,
    sources.forceId,
  );

  // Recipes first: they are the one thing the model cannot know on its own,
  // because this save's recipes may differ from vanilla.
  if (recipeContext !== undefined) {
    fit(context, "recipes", recipeContext, budgetBytes, (value) =>
      shrinkRecipeContext(value as RecipeContext),
    );
  }

  const force = sources.dynamicForce;

  // The selection is what the question is usually about, so it outranks the
  // global flow series: a player who framed 48 furnaces wants those furnaces.
  if (sources.areaSelection !== undefined) {
    fit(
      context,
      "selected_area",
      compactSelection(sources.areaSelection, names),
      budgetBytes,
      (value) => shrinkSelection(value as CompactSelection),
    );
  }

  if (force !== undefined) {
    fit(context, "force_id", force.id, budgetBytes);
    fit(
      context,
      "power",
      {
        generated_watts: force.power.generated_watts,
        consumed_watts: force.power.consumed_watts,
        satisfaction_ratio: force.power.satisfaction_ratio,
      },
      budgetBytes,
    );
    fit(
      context,
      "current_research",
      force.research === null
        ? null
        : {
            id: force.research.technology_id,
            name: names.lookup("technology", force.research.technology_id),
            progress: force.research.progress,
          },
      budgetBytes,
    );
    fit(
      context,
      "production_per_minute",
      topFlows(force, names),
      budgetBytes,
      (value) => {
        const flows = value as unknown[];
        return flows.length <= 1 ? undefined : flows.slice(0, flows.length - 1);
      },
    );
  }

  const alerts = (sources.alerts ?? []).slice(0, MAX_ALERTS).map((alert) => ({
    rule_id: alert.rule_id,
    severity: alert.severity,
    evidence: alert.evidence,
  }));
  if (alerts.length > 0) {
    fit(context, "active_alerts", alerts, budgetBytes, (value) => {
      const list = value as unknown[];
      return list.length <= 1 ? undefined : list.slice(0, list.length - 1);
    });
  }

  const staticForce = staticForceOf(sources);
  if (staticForce !== undefined) {
    fit(
      context,
      "researched_technologies",
      staticForce.researched_technologies.slice(0, MAX_TECHNOLOGIES),
      budgetBytes,
      (value) => {
        const list = value as unknown[];
        return list.length <= 8 ? undefined : list.slice(0, list.length >> 1);
      },
    );
  }

  if (sources.history !== undefined && sources.history.length > 0) {
    // Newest turn is the one a follow-up refers to, so drop the oldest first.
    fit(context, "recent_turns", [...sources.history], budgetBytes, (value) => {
      const turns = value as unknown[];
      return turns.length <= 1 ? undefined : turns.slice(1);
    });
  }

  return context;
}

/**
 * Sets `key` if it fits, otherwise repeatedly shrinks it until it does. A field
 * with no shrink strategy is simply dropped when it does not fit.
 */
function fit(
  context: CompactModelContext,
  key: string,
  value: unknown,
  budgetBytes: number,
  shrink?: (value: unknown) => unknown,
): void {
  let candidate = value;
  while (candidate !== undefined) {
    context[key] = candidate;
    if (encodedLength(context) <= budgetBytes) {
      return;
    }
    delete context[key];
    if (shrink === undefined) {
      return;
    }
    candidate = shrink(candidate);
  }
}

interface CompactSelection {
  area: string;
  entity_count: number;
  omitted_entities: number;
  truncated: boolean;
  /** Individually reported machines, grouped by prototype for readability. */
  machines: Array<Record<string, unknown>>;
  /** Everything counted rather than listed, such as belts. */
  other: Array<Record<string, unknown>>;
}

/**
 * Shapes a selection for the model. Status and recipe travel per machine
 * because "why is this one stalled" is exactly the question this feature
 * exists to answer; belts and inserters are counts only.
 */
function compactSelection(
  selection: AreaSnapshotPacket,
  names: LocalizedNameLookup,
): CompactSelection {
  const { payload } = selection;
  const label = (id: string): string | undefined => {
    const name = names.lookup("item", id) ?? names.lookup("machine", id);
    return name === id ? undefined : name;
  };

  return {
    area: `(${round(payload.area.x1)},${round(payload.area.y1)}) to (${round(payload.area.x2)},${round(payload.area.y2)})`,
    entity_count: payload.entities.length,
    omitted_entities: payload.omitted_entities,
    truncated: payload.truncated,
    machines: payload.entities.map((entity) => ({
      id: entity.id,
      ...(label(entity.id) === undefined ? {} : { name: label(entity.id) }),
      at: [entity.x, entity.y],
      ...(entity.recipe === undefined ? {} : { recipe: entity.recipe }),
      ...(entity.status === undefined ? {} : { status: entity.status }),
      ...(entity.modules === undefined ? {} : { modules: entity.modules }),
      ...(entity.contents === undefined ? {} : { contents: entity.contents }),
      ...(entity.fluids === undefined ? {} : { fluids: entity.fluids }),
    })),
    other: payload.groups.map((group) => ({
      id: group.id,
      ...(label(group.id) === undefined ? {} : { name: label(group.id) }),
      count: group.count,
    })),
  };
}

/** Sheds per-machine detail before dropping machines outright. */
function shrinkSelection(
  value: CompactSelection,
): CompactSelection | undefined {
  const hasDetail = value.machines.some(
    (machine) => "contents" in machine || "fluids" in machine,
  );
  if (hasDetail) {
    return {
      ...value,
      machines: value.machines.map((machine) =>
        Object.fromEntries(
          Object.entries(machine).filter(
            ([key]) => key !== "contents" && key !== "fluids",
          ),
        ),
      ),
      truncated: true,
    };
  }
  if (value.machines.length <= 1) {
    return undefined;
  }
  return {
    ...value,
    machines: value.machines.slice(0, value.machines.length >> 1),
    truncated: true,
  };
}

/** Drops the least relevant recipes; the ranking put the relevant chain first. */
function shrinkRecipeContext(value: RecipeContext): RecipeContext | undefined {
  if (value.recipes.length <= 1) {
    return undefined;
  }
  const kept = value.recipes.slice(0, Math.max(1, value.recipes.length >> 1));
  // Names only pay for themselves while the id they describe is still present.
  const usedIds = new Set<string>();
  for (const recipe of kept) {
    usedIds.add(recipe.r[0]);
    for (const [id] of [...recipe.i, ...recipe.o]) {
      usedIds.add(id);
    }
  }
  for (const machine of value.machines) {
    usedIds.add(machine.id);
  }

  return {
    ...value,
    recipes: kept,
    names: Object.fromEntries(
      Object.entries(value.names).filter(([id]) => usedIds.has(id)),
    ),
    truncated: true,
  };
}

function topFlows(
  force: DynamicForceSummary,
  names: LocalizedNameLookup,
): Array<Record<string, unknown>> {
  return [
    ...force.items.map((flow) => ({ ...flow, kind: "item" as const })),
    ...force.fluids.map((flow) => ({ ...flow, kind: "fluid" as const })),
  ]
    .filter(
      (flow) =>
        flow.produced_per_minute_1m > 0 || flow.consumed_per_minute_1m > 0,
    )
    .sort(
      (left, right) =>
        deficit(right) - deficit(left) ||
        throughput(right) - throughput(left) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, MAX_FLOWS)
    .map((flow) => {
      const name = names.lookup(flow.kind, flow.id);
      return {
        id: flow.id,
        ...(name === undefined || name === flow.id ? {} : { name }),
        produced: round(flow.produced_per_minute_1m),
        consumed: round(flow.consumed_per_minute_1m),
      };
    });
}

function deficit(flow: {
  produced_per_minute_1m: number;
  consumed_per_minute_1m: number;
}): number {
  return flow.consumed_per_minute_1m - flow.produced_per_minute_1m;
}

function throughput(flow: {
  produced_per_minute_1m: number;
  consumed_per_minute_1m: number;
}): number {
  return flow.produced_per_minute_1m + flow.consumed_per_minute_1m;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function staticForceOf(
  sources: ContextSources,
): StaticState["forces"][number] | undefined {
  const forces = sources.staticState?.forces ?? [];
  const wanted = sources.forceId ?? sources.dynamicForce?.id;
  return wanted === undefined
    ? forces[0]
    : forces.find(({ id }) => id === wanted) ?? forces[0];
}

function encodedLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}