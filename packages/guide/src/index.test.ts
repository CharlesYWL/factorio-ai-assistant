import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GUIDE_FACTORIO_VERSION,
  GUIDE_VERSION,
  VANILLA_PROGRESSION_GUIDE,
  evaluateGuideCondition,
  planProgression,
  type ProgressionState,
  type StepOrigin,
} from "./index.js";

interface StageFixtureCase {
  id: string;
  expected_stage_id: string;
  expected_stage_order: number;
  expected_basis: "state" | "general";
  expected_first_rule_id?: string;
  expected_step_origins?: StepOrigin[];
  expected_gap_rule_ids?: string[];
  state: ProgressionState;
}

interface StageFixture {
  schema_version: 1;
  guide_version: string;
  factorio_version: string;
  cases: StageFixtureCase[];
}

const fixture = await readStageFixture();

void test("ships one stage fixture per guide stage from bootstrap to rocket", () => {
  const stageIds = new Set(fixture.cases.map(({ expected_stage_id }) => expected_stage_id));
  assert.ok(fixture.cases.length >= 8, "at least eight stage fixtures are required");
  assert.equal(stageIds.size, VANILLA_PROGRESSION_GUIDE.stages.length);
  for (const stage of VANILLA_PROGRESSION_GUIDE.stages) {
    assert.ok(stageIds.has(stage.id), `missing fixture for stage ${stage.id}`);
  }
  assert.equal(fixture.guide_version, GUIDE_VERSION);
  assert.equal(fixture.factorio_version, GUIDE_FACTORIO_VERSION);
});

void test("infers the stage, ordered steps and data gaps of every fixture", () => {
  for (const fixtureCase of fixture.cases) {
    const plan = planProgression(fixtureCase.state);

    assert.equal(plan.stage.id, fixtureCase.expected_stage_id, fixtureCase.id);
    assert.equal(plan.stage.order, fixtureCase.expected_stage_order, fixtureCase.id);
    assert.equal(plan.stage.basis, fixtureCase.expected_basis, fixtureCase.id);
    assert.equal(plan.stage.total, VANILLA_PROGRESSION_GUIDE.stages.length, fixtureCase.id);
    assert.deepEqual(
      plan.steps.map(({ order }) => order),
      plan.steps.map((_step, index) => index + 1),
      fixtureCase.id,
    );

    if (fixtureCase.expected_first_rule_id !== undefined) {
      assert.equal(
        plan.steps[0]?.rule_id,
        fixtureCase.expected_first_rule_id,
        fixtureCase.id,
      );
    }
    if (fixtureCase.expected_step_origins !== undefined) {
      assert.deepEqual(
        plan.steps.map(({ origin }) => origin),
        fixtureCase.expected_step_origins,
        fixtureCase.id,
      );
    }
    for (const ruleId of fixtureCase.expected_gap_rule_ids ?? []) {
      assert.ok(
        plan.data_gaps.some((gap) => gap.rule_id === ruleId),
        `${fixtureCase.id} must report the ${ruleId} data gap`,
      );
    }
  }
});

void test("orders active bottlenecks ahead of generic guide steps", () => {
  const fixtureCase = requireCase("bottleneck-first-with-active-alerts");
  const plan = planProgression(fixtureCase.state);

  assert.equal(plan.steps[0]?.origin, "bottleneck");
  assert.equal(plan.steps[0]?.alert_severity, "critical");
  assert.equal(plan.steps[1]?.alert_severity, "warning");
  assert.ok(plan.steps.some(({ origin }) => origin === "guide"));
  assert.match(plan.steps[0]?.objective["zh-CN"] ?? "", /先处理当前瓶颈/u);
});

void test("falls back to a general stage clarification without synchronized state", () => {
  const plan = planProgression();

  assert.equal(plan.stage.basis, "general");
  assert.equal(plan.stage.order, 1);
  assert.deepEqual(plan.stage.matched_technologies, []);
  assert.equal(plan.stage_overview.length, VANILLA_PROGRESSION_GUIDE.stages.length);
  assert.ok(plan.steps.length > 0);
  assert.ok(
    plan.data_gaps.some(({ rule_id }) => rule_id === "state:researched_technologies"),
  );
  assert.ok(plan.data_gaps.some(({ rule_id }) => rule_id === "state:flows"));
});

void test("never treats truncated records as missing technologies or zero flow", () => {
  const truncated: ProgressionState = {
    researched_technologies: ["automation", "automation-science-pack"],
    static_truncated: true,
    dynamic_truncated: true,
    flows: [],
  };

  assert.equal(
    evaluateGuideCondition(
      { kind: "technology_missing", technology_id: "steel-processing" },
      truncated,
    ),
    "unknown",
  );
  assert.equal(
    evaluateGuideCondition(
      {
        kind: "flow_produced_below",
        resource_kind: "item",
        resource_id: "iron-plate",
        window: "10m",
        per_minute: 30,
      },
      truncated,
    ),
    "unknown",
  );
  assert.equal(
    evaluateGuideCondition(
      { kind: "technology_researched", technology_id: "automation" },
      truncated,
    ),
    "met",
  );
});

void test("treats an absent flow as zero only when the snapshot is complete", () => {
  const complete: ProgressionState = { flows: [] };

  assert.equal(
    evaluateGuideCondition(
      {
        kind: "flow_produced_below",
        resource_kind: "item",
        resource_id: "iron-plate",
        window: "10m",
        per_minute: 30,
      },
      complete,
    ),
    "met",
  );
  assert.equal(
    evaluateGuideCondition(
      {
        kind: "flow_produced_at_least",
        resource_kind: "item",
        resource_id: "iron-plate",
        window: "10m",
        per_minute: 1,
      },
      complete,
    ),
    "unmet",
  );
});

void test("reports rules blocked by unknown state as data gaps instead of steps", () => {
  const plan = planProgression({
    researched_technologies: ["automation", "automation-science-pack"],
    static_truncated: true,
    current_research: null,
  });

  assert.ok(plan.steps.every(({ rule_id }) => !rule_id.startsWith("guide-2-3")));
  assert.ok(plan.data_gaps.some(({ rule_id }) => rule_id === "guide-2-3-steel-processing"));
});

void test("marks a completed stage and names the next stage goal", () => {
  const plan = planProgression({
    researched_technologies: [
      "automation",
      "automation-science-pack",
      "logistic-science-pack",
      "steel-processing",
      "logistics",
    ],
    flows: [],
  });

  assert.equal(plan.stage.id, "smelting-logistics-military");
  assert.equal(plan.next_stage?.id, "oil-chemical-blue");
  assert.equal(plan.stage.uncertain, false);
});

void test("reports the stage as a lower bound when a gate cannot be decided", () => {
  const plan = planProgression({
    researched_technologies: ["automation", "automation-science-pack"],
    static_truncated: true,
    flows: [],
  });

  assert.equal(plan.stage.id, "automation-red-green");
  assert.equal(plan.stage.uncertain, true);
  assert.ok(
    plan.data_gaps.some(({ rule_id }) => rule_id === "state:stage_undecidable"),
  );
});

void test("matches the highest entered stage even when an earlier gate is skipped", () => {
  const plan = planProgression({
    researched_technologies: [
      "automation",
      "automation-science-pack",
      "logistic-science-pack",
      "steel-processing",
      "oil-processing",
      "chemical-science-pack",
      "modules",
      "productivity-module",
      "advanced-material-processing-2",
      "railway",
      "production-science-pack",
    ],
    flows: [],
  });

  assert.equal(plan.stage.id, "utility-science");
  assert.equal(plan.stage.order, 7);
  assert.equal(plan.stage.uncertain, false);
});

void test("does not recommend purple science before productivity-module is researched", () => {
  const withoutProductivityModule = [
    "automation",
    "automation-science-pack",
    "logistic-science-pack",
    "steel-processing",
    "oil-processing",
    "advanced-circuit",
    "chemical-science-pack",
    "robotics",
    "modules",
    "processing-unit",
    "railway",
    "advanced-material-processing-2",
  ];
  const blocked = planProgression({
    researched_technologies: withoutProductivityModule,
    flows: [],
  });

  assert.equal(blocked.stage.id, "robotics-modules-scale");
  assert.ok(
    blocked.steps.some(({ rule_id }) => rule_id === "guide-5-2-modules"),
    "the modules rule must stay active until productivity-module is researched",
  );
  assert.ok(
    blocked.steps.every(
      ({ rule_id }) => rule_id !== "guide-6-2-production-science-pack",
    ),
  );

  const unblocked = planProgression({
    researched_technologies: [...withoutProductivityModule, "productivity-module"],
    flows: [],
  });
  assert.equal(unblocked.stage.id, "production-science");
  assert.ok(
    unblocked.steps.some(
      ({ rule_id }) => rule_id === "guide-6-2-production-science-pack",
    ),
  );
});

void test("keeps every rule id, source reference and stage order well formed", () => {
  const sourceIds = new Set(VANILLA_PROGRESSION_GUIDE.sources.map(({ id }) => id));
  const ruleIds = new Set<string>();
  let expectedOrder = 1;

  for (const stage of VANILLA_PROGRESSION_GUIDE.stages) {
    assert.equal(stage.order, expectedOrder, `stage ${stage.id} order`);
    expectedOrder += 1;
    for (const id of stage.source_ids) {
      assert.ok(sourceIds.has(id), `stage ${stage.id} cites unknown source ${id}`);
    }
    for (const rule of stage.rules) {
      assert.equal(ruleIds.has(rule.id), false, `duplicate rule id ${rule.id}`);
      ruleIds.add(rule.id);
      assert.ok(rule.preconditions.length > 0, `${rule.id} needs preconditions`);
      assert.ok(
        rule.verification_signals.length > 0,
        `${rule.id} needs verification signals`,
      );
      assert.ok(rule.source_ids.length > 0, `${rule.id} needs a source`);
      for (const id of rule.source_ids) {
        assert.ok(sourceIds.has(id), `${rule.id} cites unknown source ${id}`);
      }
      for (const language of ["zh-CN", "en"] as const) {
        assert.ok(rule.objective[language].length > 0, `${rule.id} objective ${language}`);
        assert.ok(rule.rationale[language].length > 0, `${rule.id} rationale ${language}`);
        assert.ok(
          rule.verification[language].length > 0,
          `${rule.id} verification ${language}`,
        );
      }
    }
  }

  for (const stage of VANILLA_PROGRESSION_GUIDE.stages) {
    for (const rule of stage.rules) {
      for (const nextId of rule.next_rule_ids) {
        assert.ok(ruleIds.has(nextId), `${rule.id} points at unknown rule ${nextId}`);
      }
    }
  }
});

void test("cites every source with a URL, access date and version scope", () => {
  for (const source of VANILLA_PROGRESSION_GUIDE.sources) {
    assert.match(source.url, /^https:\/\//u);
    assert.match(source.accessed, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(source.applies_to.includes("2.0"), `${source.id} must scope its version`);
  }
});

void test("limits the plan to the requested number of steps", () => {
  const fixtureCase = requireCase("bottleneck-first-with-active-alerts");
  const plan = planProgression(fixtureCase.state, { maxSteps: 1 });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.origin, "bottleneck");
});

async function readStageFixture(): Promise<StageFixture> {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/progression-stages.json", import.meta.url),
      "utf8",
    ),
  ) as StageFixture;
}

function requireCase(id: string): StageFixtureCase {
  const fixtureCase = fixture.cases.find((entry) => entry.id === id);
  if (fixtureCase === undefined) {
    throw new Error(`Missing stage fixture ${id}`);
  }
  return fixtureCase;
}
