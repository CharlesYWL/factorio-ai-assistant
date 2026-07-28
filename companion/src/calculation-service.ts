import {
  calculateProduction,
  ProductionError,
  type ProductionRequest,
  type ProductionResult,
} from "@factorio-ai-assistant/calculator";
import type {
  CalculationRequestPacket,
  CalculationResultSummary,
} from "@factorio-ai-assistant/protocol";

import type { CompanionStateStore, StaticState } from "./state-store.js";

const MAX_SUMMARY_ITEMS = 16;
const DEFAULT_SOURCE_RESOURCES = [
  "item:coal",
  "item:copper-ore",
  "item:iron-ore",
  "item:stone",
  "item:uranium-ore",
  "item:wood",
  "fluid:crude-oil",
  "fluid:petroleum-gas",
  "fluid:water",
];

export class CalculationServiceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "CalculationServiceError";
    this.code = code;
  }
}

export class CalculationService {
  readonly #stateStore: CompanionStateStore;

  public constructor(stateStore: CompanionStateStore) {
    this.#stateStore = stateStore;
  }

  public calculate(
    input: CalculationRequestPacket["payload"],
  ): CalculationResultSummary {
    return summarize(this.calculateDetailed(input));
  }

  public calculateDetailed(
    input: CalculationRequestPacket["payload"],
  ): ProductionResult {
    const staticState = this.#stateStore.staticState;
    if (staticState === undefined) {
      throw new CalculationServiceError(
        "STATE_UNAVAILABLE",
        "Static game data has not finished synchronizing",
      );
    }
    if (staticState.truncated) {
      throw new CalculationServiceError(
        "STATE_TRUNCATED",
        "Static game data was truncated; an exact calculation is not safe",
      );
    }

    const force = staticState.forces.find(({ id }) => id === input.force_id);
    if (force === undefined) {
      throw new CalculationServiceError(
        "FORCE_NOT_FOUND",
        `Force ${input.force_id} is not available in synchronized state`,
      );
    }

    const baseRequest: ProductionRequest = {
      targets: [
        {
          kind: input.target_kind,
          id: input.target_id,
          rate: input.rate_per_minute,
          unit: "minute",
        },
      ],
      available_recipe_ids: force.available_recipes,
      byproduct_policy: "surplus",
      source_resources: DEFAULT_SOURCE_RESOURCES,
    };
    const catalog = createCatalog(staticState, force.recipe_productivity_bonuses);
    const baseResult = runCalculation(catalog, baseRequest);

    let result = baseResult;
    if (input.machine_id !== undefined || input.module_ids.length > 0) {
      const targetKey = `${input.target_kind}:${input.target_id}`;
      const targetRecipeId =
        baseResult.assumptions.recipe_selections[targetKey];
      if (targetRecipeId === undefined) {
        throw new Error(`Calculation did not select a recipe for ${targetKey}`);
      }

      result = runCalculation(catalog, {
        ...baseRequest,
        ...(input.machine_id === undefined
          ? {}
          : { machine_choices: { [targetRecipeId]: input.machine_id } }),
        ...(input.module_ids.length === 0
          ? {}
          : { module_loadouts: { [targetRecipeId]: input.module_ids } }),
      });
    }

    return result;
  }
}

function createCatalog(
  state: StaticState,
  recipeProductivityBonuses: StaticState["forces"][number]["recipe_productivity_bonuses"],
) {
  return {
    recipes: state.recipes,
    machines: state.machines,
    modules: state.modules,
    recipe_productivity_bonuses: recipeProductivityBonuses,
  };
}

function runCalculation(
  catalog: ReturnType<typeof createCatalog>,
  request: ProductionRequest,
): ProductionResult {
  try {
    return calculateProduction(catalog, request);
  } catch (error: unknown) {
    if (error instanceof ProductionError) {
      throw new CalculationServiceError(error.code, error.message);
    }
    throw error;
  }
}

function summarize(result: ProductionResult): CalculationResultSummary {
  const target = result.targets[0];
  if (target === undefined) {
    throw new Error("Calculation returned no target");
  }

  const truncated =
    result.recipes.length > MAX_SUMMARY_ITEMS ||
    result.external_inputs.length > MAX_SUMMARY_ITEMS ||
    result.byproducts.length > MAX_SUMMARY_ITEMS;

  return {
    target: {
      kind: target.kind,
      id: target.id,
      per_minute: target.per_minute,
    },
    recipes: result.recipes.slice(0, MAX_SUMMARY_ITEMS).map((recipe) => ({
      recipe_id: recipe.recipe_id,
      machine_id: recipe.machine_id,
      machines_exact: recipe.machines.exact,
      machines_rounded_up: recipe.machines.rounded_up,
      module_ids: [...recipe.module_ids],
    })),
    external_inputs: result.external_inputs
      .slice(0, MAX_SUMMARY_ITEMS)
      .map((resource) => ({
        kind: resource.kind,
        id: resource.id,
        per_minute: resource.per_minute,
      })),
    byproducts: result.byproducts
      .slice(0, MAX_SUMMARY_ITEMS)
      .map((resource) => ({
        kind: resource.kind,
        id: resource.id,
        per_minute: resource.per_minute,
      })),
    rounding: result.assumptions.rounding,
    truncated,
  };
}
