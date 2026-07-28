import {
  planProgression,
  type ProgressionFlow,
  type ProgressionPlan,
  type ProgressionState,
} from "@factorio-ai-assistant/guide";
import type {
  AdvisorAlert,
  DynamicForceSummary,
  ResearchSummary,
} from "@factorio-ai-assistant/protocol";

import type { AdvisorEngine } from "./advisor.js";
import type { CompanionStateStore } from "./state-store.js";

export const MAX_PROGRESSION_STEPS = 3;

export interface ProgressionRequest {
  forceId?: string;
  maxSteps?: number;
  alerts?: readonly AdvisorAlert[];
}

export interface ProgressionResult {
  plan: ProgressionPlan;
  forceId: string | undefined;
  stateAvailable: boolean;
}

/**
 * Adapts the synchronized companion state onto the built-in progression guide. Nothing is
 * inferred from absent data: a snapshot the mod never sent stays `undefined` so the guide
 * engine reports it as a data gap instead of assuming zero or "not researched".
 */
export class ProgressionService {
  readonly #stateStore: CompanionStateStore;
  readonly #advisor: AdvisorEngine;

  public constructor(stateStore: CompanionStateStore, advisor: AdvisorEngine) {
    this.#stateStore = stateStore;
    this.#advisor = advisor;
  }

  public plan(request: ProgressionRequest = {}): ProgressionResult {
    const dynamicPacket = this.#stateStore.dynamicState;
    const dynamicForces = dynamicPacket?.payload.forces ?? [];
    const dynamicForce =
      request.forceId === undefined
        ? dynamicForces[0]
        : dynamicForces.find(({ id }) => id === request.forceId);
    const staticState = this.#stateStore.staticState;
    const forceId = dynamicForce?.id ?? request.forceId ?? staticState?.forces[0]?.id;
    const staticForce =
      forceId === undefined
        ? staticState?.forces[0]
        : staticState?.forces.find(({ id }) => id === forceId);

    const alerts: readonly AdvisorAlert[] =
      request.alerts ??
      this.#advisor.activeAlerts.filter(
        (alert) => forceId === undefined || alert.force_id === forceId,
      );

    const state: ProgressionState = {
      ...(forceId === undefined ? {} : { force_id: forceId }),
      ...(staticForce === undefined
        ? {}
        : { researched_technologies: staticForce.researched_technologies }),
      static_truncated: staticState?.truncated ?? false,
      ...(dynamicForce === undefined
        ? {}
        : { current_research: toCurrentResearch(dynamicForce.research) }),
      ...(dynamicForce === undefined ? {} : { flows: toFlows(dynamicForce) }),
      dynamic_truncated: dynamicPacket?.payload.truncated ?? false,
      alerts,
    };

    return {
      plan: planProgression(state, {
        maxSteps: request.maxSteps ?? MAX_PROGRESSION_STEPS,
      }),
      forceId,
      stateAvailable: staticForce !== undefined || dynamicForce !== undefined,
    };
  }
}

function toCurrentResearch(
  research: ResearchSummary | null,
): ProgressionState["current_research"] {
  return research === null
    ? null
    : { technology_id: research.technology_id, progress: research.progress };
}

function toFlows(force: DynamicForceSummary): ProgressionFlow[] {
  return [
    ...force.items.map((flow) => ({ ...flow, kind: "item" as const })),
    ...force.fluids.map((flow) => ({ ...flow, kind: "fluid" as const })),
  ];
}
