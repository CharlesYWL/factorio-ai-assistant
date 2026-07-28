import {
  ADVISOR_RULE_IDS,
  DEFAULT_ADVISOR_CONFIG,
  type AdvisorAlert,
  type AdvisorConfig,
  type AdvisorEventType,
  type AdvisorRuleId,
  type AdvisorSeverity,
  type DynamicForceSummary,
  type DynamicSnapshotPacket,
  type FlowMetric,
  type StaticForceDescriptor,
} from "@factorio-ai-assistant/protocol";

const KEY_MATERIAL_IDS = [
  "iron-plate",
  "copper-plate",
  "steel-plate",
  "electronic-circuit",
  "advanced-circuit",
] as const;
const ZERO_FLOW: FlowMetric = {
  id: "",
  produced_per_minute_1m: 0,
  consumed_per_minute_1m: 0,
  produced_per_minute_10m: 0,
  consumed_per_minute_10m: 0,
};

export interface AdvisorStaticState {
  truncated: boolean;
  forces: Array<
    Pick<StaticForceDescriptor, "id" | "researched_technologies">
  >;
}

export interface AdvisorEvent {
  type: AdvisorEventType;
  proactive: boolean;
  alert: AdvisorAlert;
}

interface RuleObservation {
  severity: AdvisorSeverity;
  evidence: string;
  recommendation: string;
  durationTicks: number;
}

interface EvaluationContext {
  force: DynamicForceSummary;
  dynamicTruncated: boolean;
  staticForce: AdvisorStaticState["forces"][number] | undefined;
  staticTruncated: boolean;
  config: AdvisorConfig;
}

interface RuleDefinition {
  id: AdvisorRuleId;
  evaluate(context: EvaluationContext): RuleObservation | false | undefined;
}

interface RuleTracker {
  pendingSince: number | undefined;
  recoveringSince: number | undefined;
  active: AdvisorAlert | undefined;
  lastNotified: number | undefined;
}

const RULES: readonly RuleDefinition[] = [
  {
    id: "research-idle",
    evaluate: evaluateResearchIdle,
  },
  {
    id: "power-low",
    evaluate: evaluatePowerLow,
  },
  {
    id: "lubricant-zero",
    evaluate: evaluateLubricantZero,
  },
  {
    id: "oil-imbalance",
    evaluate: evaluateOilImbalance,
  },
  {
    id: "robotics-stalled",
    evaluate: evaluateRoboticsStalled,
  },
  {
    id: "material-deficit",
    evaluate: evaluateMaterialDeficit,
  },
  {
    id: "production-decline",
    evaluate: evaluateProductionDecline,
  },
];

export class AdvisorEngine {
  readonly #trackers = new Map<string, RuleTracker>();
  #config: AdvisorConfig;
  #lastGlobalNotification: number | undefined;
  #lastTick: number | undefined;
  #lastSequence: number | undefined;

  public constructor(config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG) {
    this.#config = copyConfig(config);
  }

  public get config(): AdvisorConfig {
    return copyConfig(this.#config);
  }

  public get activeAlerts(): AdvisorAlert[] {
    return [...this.#trackers.values()]
      .flatMap((tracker) => (tracker.active === undefined ? [] : [copyAlert(tracker.active)]))
      .sort(compareAlerts);
  }

  public configure(config: AdvisorConfig): void {
    this.#config = copyConfig(config);
  }

  public evaluate(
    packet: DynamicSnapshotPacket,
    staticState?: AdvisorStaticState,
  ): AdvisorEvent[] {
    if (this.#isDuplicate(packet)) {
      return [];
    }

    if (this.#isNewTimeline(packet)) {
      this.reset();
    } else if (this.#isStale(packet)) {
      return [];
    }

    this.#lastTick = packet.tick;
    this.#lastSequence = packet.payload.sample_sequence;

    const events: AdvisorEvent[] = [];
    const presentForces = new Set<string>();
    const staticForces = new Map(
      staticState?.forces.map((force) => [force.id, force]) ?? [],
    );
    const mutedRules = new Set(this.#config.muted_rules);

    for (const force of packet.payload.forces) {
      presentForces.add(force.id);

      for (const rule of RULES) {
        const key = alertId(rule.id, force.id);

        if (mutedRules.has(rule.id)) {
          this.#closeImmediately(key, events);
          continue;
        }

        const observation = rule.evaluate({
          force,
          dynamicTruncated: packet.payload.truncated,
          staticForce: staticForces.get(force.id),
          staticTruncated: staticState?.truncated ?? true,
          config: this.#config,
        });
        this.#applyObservation(key, rule.id, force.id, observation, packet.tick, events);
      }
    }

    if (!packet.payload.truncated) {
      for (const [key, tracker] of this.#trackers) {
        const forceId = tracker.active?.force_id ?? forceIdFromAlertId(key);
        if (!presentForces.has(forceId)) {
          this.#applyObservation(
            key,
            ruleIdFromAlertId(key),
            forceId,
            false,
            packet.tick,
            events,
          );
        }
      }
    }

    this.#scheduleNotification(packet.tick, events);
    return events;
  }

  public reset(): void {
    this.#trackers.clear();
    this.#lastGlobalNotification = undefined;
    this.#lastTick = undefined;
    this.#lastSequence = undefined;
  }

  #applyObservation(
    key: string,
    ruleId: AdvisorRuleId,
    forceId: string,
    observation: RuleObservation | false | undefined,
    tick: number,
    events: AdvisorEvent[],
  ): void {
    const tracker = this.#trackers.get(key) ?? createTracker();
    this.#trackers.set(key, tracker);

    if (observation === undefined) {
      if (tracker.active === undefined) {
        tracker.pendingSince = undefined;
      }
      return;
    }

    if (observation === false) {
      tracker.pendingSince = undefined;

      if (tracker.active === undefined) {
        tracker.recoveringSince = undefined;
        return;
      }

      tracker.recoveringSince ??= tick;
      if (tick - tracker.recoveringSince < this.#config.recovery_ticks) {
        return;
      }

      events.push({
        type: "closed",
        proactive: false,
        alert: copyAlert(tracker.active),
      });
      tracker.active = undefined;
      tracker.recoveringSince = undefined;
      return;
    }

    tracker.recoveringSince = undefined;

    if (tracker.active !== undefined) {
      tracker.active = {
        ...tracker.active,
        severity: observation.severity,
        evidence: observation.evidence,
        recommendation: observation.recommendation,
        last_seen: tick,
      };
      return;
    }

    tracker.pendingSince ??= tick;

    if (tick - tracker.pendingSince < observation.durationTicks) {
      return;
    }

    tracker.active = {
      id: key,
      rule_id: ruleId,
      force_id: forceId,
      severity: observation.severity,
      evidence: observation.evidence,
      recommendation: observation.recommendation,
      first_seen: tracker.pendingSince,
      last_seen: tick,
    };
    tracker.pendingSince = undefined;
    events.push({
      type: "opened",
      proactive: false,
      alert: copyAlert(tracker.active),
    });
  }

  #closeImmediately(key: string, events: AdvisorEvent[]): void {
    const tracker = this.#trackers.get(key);
    if (tracker === undefined) {
      return;
    }

    tracker.pendingSince = undefined;
    tracker.recoveringSince = undefined;

    if (tracker.active !== undefined) {
      events.push({
        type: "closed",
        proactive: false,
        alert: copyAlert(tracker.active),
      });
      tracker.active = undefined;
    }
  }

  #scheduleNotification(tick: number, events: AdvisorEvent[]): void {
    if (this.#config.quiet_mode) {
      return;
    }

    const candidates = [...this.#trackers.entries()]
      .flatMap(([key, tracker]) => {
        if (
          tracker.active === undefined ||
          (tracker.lastNotified !== undefined &&
            tick - tracker.lastNotified < this.#config.notification_cooldown_ticks)
        ) {
          return [];
        }

        return [{ key, tracker, alert: tracker.active }];
      })
      .sort((left, right) => {
        if (left.tracker.lastNotified === undefined) {
          return right.tracker.lastNotified === undefined
            ? compareAlerts(left.alert, right.alert)
            : -1;
        }
        if (right.tracker.lastNotified === undefined) {
          return 1;
        }
        return (
          left.tracker.lastNotified - right.tracker.lastNotified ||
          compareAlerts(left.alert, right.alert)
        );
      });

    const globalSlotAvailable =
      this.#lastGlobalNotification === undefined ||
      tick - this.#lastGlobalNotification >=
        this.#config.notification_cooldown_ticks;
    const selected = candidates.find(
      ({ alert }) =>
        globalSlotAvailable ||
        (this.#config.critical_power_bypass &&
          alert.rule_id === "power-low" &&
          alert.severity === "critical"),
    );

    if (selected === undefined) {
      return;
    }

    selected.tracker.lastNotified = tick;
    this.#lastGlobalNotification = tick;

    const openedEvent = events.find(
      (event) => event.type === "opened" && event.alert.id === selected.key,
    );
    if (openedEvent !== undefined) {
      openedEvent.proactive = true;
      return;
    }

    events.push({
      type: "reminder",
      proactive: true,
      alert: copyAlert(selected.alert),
    });
  }

  #isDuplicate(packet: DynamicSnapshotPacket): boolean {
    return (
      packet.tick === this.#lastTick &&
      packet.payload.sample_sequence === this.#lastSequence
    );
  }

  #isNewTimeline(packet: DynamicSnapshotPacket): boolean {
    if (this.#lastTick === undefined || this.#lastSequence === undefined) {
      return false;
    }

    return (
      packet.tick + packet.payload.sample_interval_ticks * 2 < this.#lastTick &&
      packet.payload.sample_sequence + 2 < this.#lastSequence
    );
  }

  #isStale(packet: DynamicSnapshotPacket): boolean {
    return (
      (this.#lastTick !== undefined && packet.tick <= this.#lastTick) ||
      (this.#lastSequence !== undefined &&
        packet.payload.sample_sequence <= this.#lastSequence)
    );
  }
}

function evaluateResearchIdle(context: EvaluationContext): RuleObservation | false {
  if (context.force.research !== null) {
    return false;
  }

  return {
    severity: "info",
    evidence: "No technology is currently being researched.",
    recommendation: "Queue the next technology or verify science-pack supply.",
    durationTicks: context.config.research_idle_ticks,
  };
}

function evaluatePowerLow(context: EvaluationContext): RuleObservation | false {
  const { power } = context.force;
  if (
    power.consumed_watts === 0 ||
    power.satisfaction_ratio >= context.config.power_satisfaction_threshold
  ) {
    return false;
  }

  return {
    severity:
      power.satisfaction_ratio <= context.config.critical_power_threshold
        ? "critical"
        : "warning",
    evidence:
      `Power satisfaction is ${formatPercent(power.satisfaction_ratio)} ` +
      `(${formatWatts(power.generated_watts)} generated, ` +
      `${formatWatts(power.consumed_watts)} consumed).`,
    recommendation:
      "Add generation or fuel, isolate nonessential loads, and inspect overloaded networks.",
    durationTicks: context.config.power_low_ticks,
  };
}

function evaluateLubricantZero(
  context: EvaluationContext,
): RuleObservation | false | undefined {
  const researched = researchedTechnology(context, "advanced-oil-processing");
  if (researched !== true) {
    return researched;
  }

  const lubricant = findFlow(context.force.fluids, "lubricant");
  if (lubricant === undefined && context.dynamicTruncated) {
    return undefined;
  }

  const flow = lubricant ?? ZERO_FLOW;
  if (
    flow.produced_per_minute_1m > 0 ||
    flow.produced_per_minute_10m > 0
  ) {
    return false;
  }

  return {
    severity: "warning",
    evidence:
      "Advanced oil processing is researched, but lubricant production is " +
      `${formatRate(flow.produced_per_minute_1m)} (1m) and ` +
      `${formatRate(flow.produced_per_minute_10m)} (10m).`,
    recommendation:
      "Route heavy oil to a chemical plant making lubricant and verify output storage.",
    durationTicks: context.config.lubricant_zero_ticks,
  };
}

function evaluateOilImbalance(
  context: EvaluationContext,
): RuleObservation | false | undefined {
  const heavyOil = findFlow(context.force.fluids, "heavy-oil");
  const lightOil = findFlow(context.force.fluids, "light-oil");
  const petroleumGas = findFlow(context.force.fluids, "petroleum-gas");

  if (
    context.dynamicTruncated &&
    (heavyOil === undefined || lightOil === undefined || petroleumGas === undefined)
  ) {
    return undefined;
  }

  const heavySurplus = netSurplus(heavyOil ?? ZERO_FLOW);
  const lightSurplus = netSurplus(lightOil ?? ZERO_FLOW);
  const gasDeficit = netDeficit(petroleumGas ?? ZERO_FLOW);
  const surplus =
    heavySurplus >= lightSurplus
      ? { id: "heavy oil", rate: heavySurplus }
      : { id: "light oil", rate: lightSurplus };

  if (
    surplus.rate < context.config.oil_surplus_min_per_minute ||
    gasDeficit < context.config.petroleum_deficit_min_per_minute
  ) {
    return false;
  }

  return {
    severity: "warning",
    evidence:
      `${surplus.id} net surplus is ${formatRate(surplus.rate)} over 10m, ` +
      `while petroleum gas net deficit is ${formatRate(gasDeficit)}.`,
    recommendation:
      "Balance cracking: convert surplus heavy oil to light oil, then light oil to petroleum gas.",
    durationTicks: context.config.oil_imbalance_ticks,
  };
}

function evaluateRoboticsStalled(
  context: EvaluationContext,
): RuleObservation | false | undefined {
  const constructionRobotics = researchedTechnology(
    context,
    "construction-robotics",
  );
  if (constructionRobotics === true) {
    return false;
  }
  if (constructionRobotics === undefined) {
    return undefined;
  }

  if (
    context.force.research?.technology_id === "robotics" ||
    context.force.research?.technology_id === "construction-robotics"
  ) {
    return false;
  }

  const blueScience = findFlow(context.force.items, "chemical-science-pack");
  if (blueScience === undefined && context.dynamicTruncated) {
    return undefined;
  }

  const flow = blueScience ?? ZERO_FLOW;
  if (
    flow.produced_per_minute_1m < context.config.blue_science_min_per_minute ||
    flow.produced_per_minute_10m < context.config.blue_science_min_per_minute
  ) {
    return false;
  }

  return {
    severity: "info",
    evidence:
      `Chemical science is stable at ${formatRate(flow.produced_per_minute_1m)} ` +
      `(1m) and ${formatRate(flow.produced_per_minute_10m)} (10m), ` +
      "but construction robotics is neither researched nor in progress.",
    recommendation:
      "Consider researching robotics and construction robotics for automated expansion.",
    durationTicks: context.config.science_stable_ticks,
  };
}

function evaluateMaterialDeficit(
  context: EvaluationContext,
): RuleObservation | false | undefined {
  const deficits = KEY_MATERIAL_IDS.flatMap((id) => {
    const flow = findFlow(context.force.items, id);
    if (
      flow === undefined ||
      flow.consumed_per_minute_10m <
        context.config.material_deficit_min_per_minute ||
      flow.consumed_per_minute_10m <=
        flow.produced_per_minute_10m * context.config.material_deficit_ratio
    ) {
      return [];
    }
    return [flow];
  });

  if (deficits.length === 0) {
    return context.dynamicTruncated ? undefined : false;
  }

  const evidence = deficits
    .map(
      (flow) =>
        `${flow.id}: ${formatRate(flow.produced_per_minute_10m)} produced vs ` +
        `${formatRate(flow.consumed_per_minute_10m)} consumed`,
    )
    .join("; ");

  return {
    severity: "warning",
    evidence: `10m key-material deficits: ${evidence}.`,
    recommendation:
      "Increase upstream capacity or reduce downstream draw, starting with the largest deficit.",
    durationTicks: context.config.material_deficit_ticks,
  };
}

function evaluateProductionDecline(
  context: EvaluationContext,
): RuleObservation | false | undefined {
  const crudeOil = findFlow(context.force.fluids, "crude-oil");
  const crudeDeclining =
    crudeOil !== undefined &&
    crudeOil.produced_per_minute_10m >=
      context.config.crude_baseline_min_per_minute &&
    crudeOil.produced_per_minute_1m <
      crudeOil.produced_per_minute_10m * context.config.crude_decline_ratio;
  const stoppedMaterials = KEY_MATERIAL_IDS.flatMap((id) => {
    const flow = findFlow(context.force.items, id);
    if (
      flow === undefined ||
      flow.produced_per_minute_10m <
        context.config.key_material_baseline_min_per_minute ||
      flow.produced_per_minute_1m > 0
    ) {
      return [];
    }
    return [flow];
  });

  if (!crudeDeclining && stoppedMaterials.length === 0) {
    return context.dynamicTruncated ? undefined : false;
  }

  const evidence = [
    ...(crudeDeclining && crudeOil !== undefined
      ? [
          `crude oil fell from ${formatRate(crudeOil.produced_per_minute_10m)} ` +
            `(10m) to ${formatRate(crudeOil.produced_per_minute_1m)} (1m)`,
        ]
      : []),
    ...stoppedMaterials.map(
      (flow) =>
        `${flow.id} is at 0/min (1m) after ` +
        `${formatRate(flow.produced_per_minute_10m)} over 10m`,
    ),
  ].join("; ");

  return {
    severity: stoppedMaterials.length > 0 ? "critical" : "warning",
    evidence: `Production decline detected: ${evidence}.`,
    recommendation:
      "Inspect depleted wells, input starvation, blocked outputs, power, and disabled machines.",
    durationTicks:
      stoppedMaterials.length > 0
        ? context.config.production_stop_ticks
        : context.config.crude_decline_ticks,
  };
}

function researchedTechnology(
  context: EvaluationContext,
  technologyId: string,
): boolean | undefined {
  if (context.staticForce?.researched_technologies.includes(technologyId) === true) {
    return true;
  }

  return context.staticTruncated || context.staticForce === undefined
    ? undefined
    : false;
}

function findFlow(flows: FlowMetric[], id: string): FlowMetric | undefined {
  return flows.find((flow) => flow.id === id);
}

function netSurplus(flow: FlowMetric): number {
  return Math.max(
    0,
    flow.produced_per_minute_10m - flow.consumed_per_minute_10m,
  );
}

function netDeficit(flow: FlowMetric): number {
  return Math.max(
    0,
    flow.consumed_per_minute_10m - flow.produced_per_minute_10m,
  );
}

function copyConfig(config: AdvisorConfig): AdvisorConfig {
  return {
    ...config,
    muted_rules: [...config.muted_rules],
  };
}

function createTracker(): RuleTracker {
  return {
    pendingSince: undefined,
    recoveringSince: undefined,
    active: undefined,
    lastNotified: undefined,
  };
}

function copyAlert(alert: AdvisorAlert): AdvisorAlert {
  return { ...alert };
}

function compareAlerts(left: AdvisorAlert, right: AdvisorAlert): number {
  const rank: Record<AdvisorSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  return (
    rank[left.severity] - rank[right.severity] ||
    left.first_seen - right.first_seen ||
    left.id.localeCompare(right.id)
  );
}

function alertId(ruleId: AdvisorRuleId, forceId: string): string {
  return `${ruleId}:${forceId}`;
}

function ruleIdFromAlertId(id: string): AdvisorRuleId {
  const ruleId = id.slice(0, id.indexOf(":"));
  if ((ADVISOR_RULE_IDS as readonly string[]).includes(ruleId)) {
    return ruleId as AdvisorRuleId;
  }
  throw new Error(`Unknown advisor rule in alert id ${id}`);
}

function forceIdFromAlertId(id: string): string {
  return id.slice(id.indexOf(":") + 1);
}

function formatRate(value: number): string {
  return `${round(value)}/min`;
}

function formatPercent(value: number): string {
  return `${round(value * 100)}%`;
}

function formatWatts(value: number): string {
  if (value >= 1_000_000_000) {
    return `${round(value / 1_000_000_000)} GW`;
  }
  if (value >= 1_000_000) {
    return `${round(value / 1_000_000)} MW`;
  }
  if (value >= 1_000) {
    return `${round(value / 1_000)} kW`;
  }
  return `${round(value)} W`;
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}
