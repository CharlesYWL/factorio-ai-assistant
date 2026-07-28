import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVISOR_RULE_IDS,
  DEFAULT_ADVISOR_CONFIG,
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION,
  type AdvisorConfig,
  type AdvisorRuleId,
  type DynamicForceSummary,
  type DynamicSnapshotPacket,
  type FlowMetric,
} from "@factorio-ai-assistant/protocol";

import {
  AdvisorEngine,
  type AdvisorEvent,
  type AdvisorStaticState,
} from "./advisor.js";

const DURATION = 10;
const RECOVERY = 10;
const START = 100;

interface RuleScenario {
  id: AdvisorRuleId;
  positive(): DynamicForceSummary;
  negative(): DynamicForceSummary;
  staticState: AdvisorStaticState;
}

const completeStaticState: AdvisorStaticState = {
  truncated: false,
  forces: [
    {
      id: "player",
      researched_technologies: [],
    },
  ],
};
const advancedOilStaticState: AdvisorStaticState = {
  truncated: false,
  forces: [
    {
      id: "player",
      researched_technologies: ["advanced-oil-processing"],
    },
  ],
};

const scenarios: RuleScenario[] = [
  {
    id: "research-idle",
    positive: () => force({ research: null }),
    negative: () => force(),
    staticState: completeStaticState,
  },
  {
    id: "power-low",
    positive: () =>
      force({
        power: {
          network_count: 1,
          generated_watts: 80_000_000,
          consumed_watts: 100_000_000,
          satisfaction_ratio: 0.8,
        },
      }),
    negative: () => force(),
    staticState: completeStaticState,
  },
  {
    id: "lubricant-zero",
    positive: () => force(),
    negative: () =>
      force({
        fluids: [flow("lubricant", 60, 0, 55, 0)],
      }),
    staticState: advancedOilStaticState,
  },
  {
    id: "oil-imbalance",
    positive: () =>
      force({
        fluids: [
          flow("heavy-oil", 160, 10, 150, 20),
          flow("light-oil", 20, 20, 20, 20),
          flow("petroleum-gas", 20, 100, 25, 95),
        ],
      }),
    negative: () =>
      force({
        fluids: [
          flow("heavy-oil", 80, 70, 80, 70),
          flow("light-oil", 70, 70, 70, 70),
          flow("petroleum-gas", 100, 80, 100, 80),
        ],
      }),
    staticState: completeStaticState,
  },
  {
    id: "robotics-stalled",
    positive: () =>
      force({
        items: [flow("chemical-science-pack", 20, 10, 20, 10)],
      }),
    negative: () =>
      force({
        items: [flow("chemical-science-pack", 5, 5, 10, 5)],
      }),
    staticState: completeStaticState,
  },
  {
    id: "material-deficit",
    positive: () =>
      force({
        items: [flow("iron-plate", 50, 100, 50, 100)],
      }),
    negative: () =>
      force({
        items: [flow("iron-plate", 100, 100, 100, 100)],
      }),
    staticState: completeStaticState,
  },
  {
    id: "production-decline",
    positive: () =>
      force({
        fluids: [flow("crude-oil", 20, 0, 100, 0)],
      }),
    negative: () =>
      force({
        fluids: [flow("crude-oil", 100, 0, 100, 0)],
      }),
    staticState: completeStaticState,
  },
];

for (const scenario of scenarios) {
  void test(`${scenario.id}: persistent positive evidence opens an alert`, () => {
    const engine = new AdvisorEngine(configFor(scenario.id));

    assert.deepEqual(
      engine.evaluate(snapshot(START, scenario.positive()), scenario.staticState),
      [],
    );
    assert.deepEqual(
      engine.evaluate(
        snapshot(START + DURATION - 1, scenario.positive()),
        scenario.staticState,
      ),
      [],
    );

    const events = engine.evaluate(
      snapshot(START + DURATION, scenario.positive()),
      scenario.staticState,
    );
    const opened = onlyEvent(events, "opened", scenario.id);
    assert.equal(opened.alert.first_seen, START);
    assert.equal(opened.alert.last_seen, START + DURATION);
    assert.ok(opened.alert.evidence.length > 0);
    assert.ok(opened.alert.recommendation.length > 0);
    assert.equal(engine.activeAlerts.length, 1);
  });

  void test(`${scenario.id}: negative evidence never opens an alert`, () => {
    const engine = new AdvisorEngine(configFor(scenario.id));

    engine.evaluate(snapshot(START, scenario.negative()), scenario.staticState);
    const events = engine.evaluate(
      snapshot(START + DURATION + 1, scenario.negative()),
      scenario.staticState,
    );

    assert.deepEqual(events, []);
    assert.deepEqual(engine.activeAlerts, []);
  });

  void test(`${scenario.id}: jitter resets the pending duration`, () => {
    const engine = new AdvisorEngine(configFor(scenario.id));

    engine.evaluate(snapshot(START, scenario.positive()), scenario.staticState);
    engine.evaluate(
      snapshot(START + DURATION - 1, scenario.negative()),
      scenario.staticState,
    );
    engine.evaluate(
      snapshot(START + DURATION, scenario.positive()),
      scenario.staticState,
    );
    const early = engine.evaluate(
      snapshot(START + DURATION * 2 - 1, scenario.positive()),
      scenario.staticState,
    );
    const onTime = engine.evaluate(
      snapshot(START + DURATION * 2, scenario.positive()),
      scenario.staticState,
    );

    assert.deepEqual(early, []);
    assert.equal(onlyEvent(onTime, "opened", scenario.id).alert.first_seen, 110);
  });

  void test(`${scenario.id}: recovery is debounced and recurrence reopens`, () => {
    const engine = new AdvisorEngine(configFor(scenario.id));
    engine.evaluate(snapshot(START, scenario.positive()), scenario.staticState);
    engine.evaluate(
      snapshot(START + DURATION, scenario.positive()),
      scenario.staticState,
    );

    engine.evaluate(
      snapshot(START + DURATION + 1, scenario.negative()),
      scenario.staticState,
    );
    const jitter = engine.evaluate(
      snapshot(START + DURATION + RECOVERY - 1, scenario.positive()),
      scenario.staticState,
    );
    assert.equal(jitter.some((event) => event.type === "closed"), false);
    assert.equal(engine.activeAlerts.length, 1);

    engine.evaluate(
      snapshot(START + DURATION + RECOVERY, scenario.negative()),
      scenario.staticState,
    );
    const closed = engine.evaluate(
      snapshot(START + DURATION + RECOVERY * 2, scenario.negative()),
      scenario.staticState,
    );
    onlyEvent(closed, "closed", scenario.id);
    assert.deepEqual(engine.activeAlerts, []);

    const recurrenceStart = START + DURATION + RECOVERY * 2 + 1;
    engine.evaluate(
      snapshot(recurrenceStart, scenario.positive()),
      scenario.staticState,
    );
    const reopened = engine.evaluate(
      snapshot(recurrenceStart + DURATION, scenario.positive()),
      scenario.staticState,
    );
    assert.equal(
      onlyEvent(reopened, "opened", scenario.id).alert.first_seen,
      recurrenceStart,
    );
  });
}

void test("continuous low power keeps its duration across severity changes and stale packets", () => {
  const engine = new AdvisorEngine(configFor("power-low"));
  const warning = scenarios.find((scenario) => scenario.id === "power-low");
  assert.ok(warning !== undefined);
  const critical = force({
    power: {
      network_count: 1,
      generated_watts: 40,
      consumed_watts: 100,
      satisfaction_ratio: 0.4,
    },
  });

  engine.evaluate(snapshot(START, warning.positive()), completeStaticState);
  engine.evaluate(snapshot(START + 5, critical), completeStaticState);
  assert.deepEqual(
    engine.evaluate(snapshot(START + 4, warning.negative()), completeStaticState),
    [],
  );
  const opened = engine.evaluate(
    snapshot(START + DURATION, critical),
    completeStaticState,
  );

  assert.equal(onlyEvent(opened, "opened", "power-low").alert.first_seen, START);
  assert.equal(engine.activeAlerts[0]?.severity, "critical");
});

void test("global cooldown emits at most one proactive alert and later serves unseen alerts", () => {
  const config = configFor("power-low");
  config.muted_rules = ADVISOR_RULE_IDS.filter(
    (id) => id !== "power-low" && id !== "research-idle",
  );
  const engine = new AdvisorEngine(config);
  const unhealthy = force({
    research: null,
    power: {
      network_count: 1,
      generated_watts: 80,
      consumed_watts: 100,
      satisfaction_ratio: 0.8,
    },
  });

  engine.evaluate(snapshot(START, unhealthy), completeStaticState);
  const opened = engine.evaluate(
    snapshot(START + DURATION, unhealthy),
    completeStaticState,
  );
  assert.equal(opened.filter((event) => event.proactive).length, 1);
  assert.equal(
    engine
      .evaluate(snapshot(START + 99, unhealthy), completeStaticState)
      .filter((event) => event.proactive).length,
    0,
  );

  const later = engine.evaluate(
    snapshot(START + 100 + DURATION, unhealthy),
    completeStaticState,
  );
  const reminder = onlyEvent(later, "reminder", "research-idle");
  assert.equal(reminder.proactive, true);
});

void test("critical power can bypass the global slot but still honors per-alert cooldown", () => {
  const config = configFor("power-low");
  config.muted_rules = ADVISOR_RULE_IDS.filter(
    (id) => id !== "power-low" && id !== "research-idle",
  );
  const engine = new AdvisorEngine(config);
  const idle = force({ research: null });
  const idleAndCritical = force({
    research: null,
    power: {
      network_count: 1,
      generated_watts: 40,
      consumed_watts: 100,
      satisfaction_ratio: 0.4,
    },
  });

  engine.evaluate(snapshot(START, idle), completeStaticState);
  const idleOpened = engine.evaluate(
    snapshot(START + DURATION, idle),
    completeStaticState,
  );
  assert.equal(onlyEvent(idleOpened, "opened", "research-idle").proactive, true);

  engine.evaluate(
    snapshot(START + DURATION + 1, idleAndCritical),
    completeStaticState,
  );
  const criticalOpened = engine.evaluate(
    snapshot(START + DURATION * 2 + 1, idleAndCritical),
    completeStaticState,
  );
  assert.equal(onlyEvent(criticalOpened, "opened", "power-low").proactive, true);
  assert.equal(
    engine
      .evaluate(
        snapshot(START + DURATION * 2 + 2, idleAndCritical),
        completeStaticState,
      )
      .some((event) => event.proactive),
    false,
  );
});

void test("quiet mode retains active alerts without proactive events", () => {
  const config = configFor("research-idle");
  config.quiet_mode = true;
  const engine = new AdvisorEngine(config);
  const idle = force({ research: null });

  engine.evaluate(snapshot(START, idle), completeStaticState);
  const opened = engine.evaluate(
    snapshot(START + DURATION, idle),
    completeStaticState,
  );
  assert.equal(onlyEvent(opened, "opened", "research-idle").proactive, false);
  assert.equal(engine.activeAlerts.length, 1);
  assert.deepEqual(
    engine.evaluate(snapshot(START + 1_000, idle), completeStaticState),
    [],
  );
});

void test("muting an active rule closes it immediately", () => {
  const config = configFor("research-idle");
  const engine = new AdvisorEngine(config);
  const idle = force({ research: null });
  engine.evaluate(snapshot(START, idle), completeStaticState);
  engine.evaluate(
    snapshot(START + DURATION, idle),
    completeStaticState,
  );

  engine.configure({
    ...config,
    muted_rules: ["research-idle"],
  });
  const events = engine.evaluate(
    snapshot(START + DURATION + 1, idle),
    completeStaticState,
  );
  onlyEvent(events, "closed", "research-idle");
  assert.deepEqual(engine.activeAlerts, []);
});

void test("truncated missing series do not falsely recover an active alert", () => {
  const engine = new AdvisorEngine(configFor("lubricant-zero"));
  const noLubricant = force();
  engine.evaluate(snapshot(START, noLubricant), advancedOilStaticState);
  engine.evaluate(
    snapshot(START + DURATION, noLubricant),
    advancedOilStaticState,
  );

  engine.evaluate(
    snapshot(START + DURATION + 1, noLubricant, true),
    advancedOilStaticState,
  );
  engine.evaluate(
    snapshot(START + DURATION + RECOVERY + 1, noLubricant, true),
    advancedOilStaticState,
  );
  assert.equal(engine.activeAlerts.length, 1);

  const healthy = scenarios.find((scenario) => scenario.id === "lubricant-zero");
  assert.ok(healthy !== undefined);
  engine.evaluate(
    snapshot(START + DURATION + RECOVERY + 2, healthy.negative()),
    advancedOilStaticState,
  );
  const closed = engine.evaluate(
    snapshot(START + DURATION + RECOVERY * 2 + 2, healthy.negative()),
    advancedOilStaticState,
  );
  onlyEvent(closed, "closed", "lubricant-zero");
});

function configFor(activeRule: AdvisorRuleId): AdvisorConfig {
  return {
    ...DEFAULT_ADVISOR_CONFIG,
    muted_rules: ADVISOR_RULE_IDS.filter((id) => id !== activeRule),
    notification_cooldown_ticks: 100,
    recovery_ticks: RECOVERY,
    research_idle_ticks: DURATION,
    power_low_ticks: DURATION,
    lubricant_zero_ticks: DURATION,
    oil_imbalance_ticks: DURATION,
    science_stable_ticks: DURATION,
    material_deficit_ticks: DURATION,
    crude_decline_ticks: DURATION,
    production_stop_ticks: DURATION,
  };
}

function snapshot(
  tick: number,
  dynamicForce: DynamicForceSummary,
  truncated = false,
): DynamicSnapshotPacket {
  return {
    protocol_version: PROTOCOL_VERSION,
    schema_version: STATE_SCHEMA_VERSION,
    message_id: `dynamic-${tick}`,
    type: "dynamic_snapshot",
    tick,
    payload: {
      sample_interval_ticks: 1,
      sample_sequence: tick,
      truncated,
      omitted_forces: 0,
      omitted_series: truncated ? 1 : 0,
      forces: [dynamicForce],
    },
  };
}

function force(
  overrides: Partial<DynamicForceSummary> = {},
): DynamicForceSummary {
  return {
    id: "player",
    research: {
      technology_id: "automation",
      progress: 0.5,
    },
    items: [],
    fluids: [],
    power: {
      network_count: 1,
      generated_watts: 100,
      consumed_watts: 100,
      satisfaction_ratio: 1,
    },
    ...overrides,
  };
}

function flow(
  id: string,
  produced1m: number,
  consumed1m: number,
  produced10m: number,
  consumed10m: number,
): FlowMetric {
  return {
    id,
    produced_per_minute_1m: produced1m,
    consumed_per_minute_1m: consumed1m,
    produced_per_minute_10m: produced10m,
    consumed_per_minute_10m: consumed10m,
  };
}

function onlyEvent(
  events: AdvisorEvent[],
  type: AdvisorEvent["type"],
  ruleId: AdvisorRuleId,
): AdvisorEvent {
  const matches = events.filter(
    (event) => event.type === type && event.alert.rule_id === ruleId,
  );
  assert.equal(matches.length, 1);
  const match = matches[0];
  assert.ok(match !== undefined);
  return match;
}
