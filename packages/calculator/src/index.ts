import type {
  MachineDescriptor,
  ModuleDescriptor,
  RecipeComponent,
  RecipeDescriptor,
} from "@factorio-ai-assistant/protocol";

import { Rational } from "./rational.js";
import {
  ProductionError,
  type BeltRequirement,
  type ByproductPolicy,
  type ItemBandwidth,
  type ProductionAssumptions,
  type ProductionCatalog,
  type ProductionRequest,
  type ProductionResult,
  type RateValue,
  type RecipeStep,
  type ResourceFlow,
  type ResourceRate,
  type ResourceReference,
} from "./types.js";

export * from "./types.js";
export { parseProductionCatalog, parseProductionRequest } from "./validation.js";

const DEFAULT_BELT_SPEEDS: Readonly<Record<string, number>> = {
  "transport-belt": 15,
  "fast-transport-belt": 30,
  "express-transport-belt": 45,
};

interface RecipeConfiguration {
  recipe: RecipeDescriptor;
  machine: MachineDescriptor;
  modules: ModuleDescriptor[];
  speedBonus: Rational;
  moduleProductivityBonus: Rational;
  technologyProductivityBonus: Rational;
  effectiveProductivityBonus: Rational;
  effectiveCraftingSpeed: Rational;
}

interface ExactFlow {
  produced: Rational;
  consumed: Rational;
}

export function calculateProduction(
  catalog: ProductionCatalog,
  request: ProductionRequest,
): ProductionResult {
  validateInputs(catalog, request);

  const recipeById = uniqueById(catalog.recipes, "recipe");
  const machineById = uniqueById(catalog.machines, "machine");
  const moduleById = uniqueById(catalog.modules, "module");
  const recipesByProduct = indexRecipesByProduct(catalog.recipes);
  const availableRecipes =
    request.available_recipe_ids === undefined
      ? undefined
      : new Set(request.available_recipe_ids);
  const allowedMachines =
    request.allowed_machine_ids === undefined
      ? undefined
      : new Set(request.allowed_machine_ids);
  const sourceResources = new Set(request.source_resources ?? []);
  const targetRates = aggregateTargets(request);
  const targetKeys = new Set(targetRates.keys());
  for (const key of Object.keys(request.byproduct_handlers ?? {})) {
    if (targetKeys.has(key)) {
      throw new ProductionError(
        "INVALID_INPUT",
        `Target ${key} cannot also have a byproduct handler`,
        { resource: key },
      );
    }
  }
  const activeRecipes = new Map<string, RecipeDescriptor>();
  const recipeSelections = new Map<string, string>();

  const selectProducer = (
    key: string,
    target: boolean,
  ): RecipeDescriptor | undefined => {
    const explicitRecipeId = request.recipe_choices?.[key];
    if (explicitRecipeId !== undefined) {
      const explicitRecipe = recipeById.get(explicitRecipeId);
      if (
        explicitRecipe === undefined ||
        !recipeProduces(explicitRecipe, key) ||
        (availableRecipes !== undefined && !availableRecipes.has(explicitRecipeId))
      ) {
        throw new ProductionError(
          "UNAVAILABLE_RECIPE",
          `Recipe ${explicitRecipeId} cannot produce ${key} in this request`,
          { resource: key, recipe_id: explicitRecipeId },
        );
      }
      recipeSelections.set(key, explicitRecipe.id);
      return explicitRecipe;
    }

    const candidates = (recipesByProduct.get(key) ?? []).filter(
      (recipe) => availableRecipes === undefined || availableRecipes.has(recipe.id),
    );
    if (candidates.length === 0) {
      if (target) {
        throw new ProductionError(
          "TARGET_UNREACHABLE",
          `No available recipe produces target ${key}`,
          { resource: key },
        );
      }
      return undefined;
    }
    // Unbarrelling recipes "produce" a fluid only by consuming a barrel that
    // nothing but the matching barrelling recipe makes, so they are storage
    // round-trips rather than production routes. They are filtered only to
    // break a tie: a genuine single-candidate result is never changed.
    const productionCandidates =
      candidates.length > 1
        ? candidates.filter(
            (recipe) =>
              !isRepackagingRecipe(
                recipe,
                key,
                recipesByProduct,
                availableRecipes,
                sourceResources,
              ),
          )
        : candidates;
    const effectiveCandidates =
      productionCandidates.length === 0 ? candidates : productionCandidates;
    if (effectiveCandidates.length > 1) {
      throw new ProductionError(
        "AMBIGUOUS_RECIPE",
        `Multiple recipes produce ${key}; choose one explicitly`,
        {
          resource: key,
          recipe_ids: effectiveCandidates.map((recipe) => recipe.id).sort(),
        },
      );
    }

    const selected = effectiveCandidates[0];
    if (selected === undefined) {
      throw new Error("Recipe candidate disappeared");
    }
    recipeSelections.set(key, selected.id);
    return selected;
  };

  for (const key of targetKeys) {
    const recipe = selectProducer(key, true);
    if (recipe === undefined) {
      throw new Error("Target producer selection returned no recipe");
    }
    activeRecipes.set(recipe.id, recipe);
  }

  let changed = true;
  while (changed) {
    changed = false;
    let activeProductKeys = collectProductKeys(activeRecipes.values());

    for (const [key, handlerId] of Object.entries(
      request.byproduct_handlers ?? {},
    )) {
      if (!activeProductKeys.has(key) || activeRecipes.has(handlerId)) {
        continue;
      }

      const handler = recipeById.get(handlerId);
      if (
        handler === undefined ||
        (availableRecipes !== undefined && !availableRecipes.has(handlerId))
      ) {
        throw new ProductionError(
          "UNAVAILABLE_RECIPE",
          `Byproduct handler ${handlerId} is not available`,
          { resource: key, recipe_id: handlerId },
        );
      }
      if (!recipeConsumes(handler, key)) {
        throw new ProductionError(
          "INVALID_INPUT",
          `Byproduct handler ${handlerId} does not consume ${key}`,
          { resource: key, recipe_id: handlerId },
        );
      }

      activeRecipes.set(handler.id, handler);
      changed = true;
    }

    activeProductKeys = collectProductKeys(activeRecipes.values());
    for (const recipe of [...activeRecipes.values()]) {
      for (const ingredient of recipe.ingredients) {
        if (ingredient.amount === 0) {
          continue;
        }
        const key = resourceKey(ingredient);
        if (sourceResources.has(key) || activeProductKeys.has(key)) {
          continue;
        }

        const producer = selectProducer(key, false);
        if (producer === undefined) {
          sourceResources.add(key);
          continue;
        }
        if (!activeRecipes.has(producer.id)) {
          activeRecipes.set(producer.id, producer);
          changed = true;
        }
      }
    }
  }

  const catalogTechnologyBonuses = new Map(
    (catalog.recipe_productivity_bonuses ?? []).map(({ recipe_id, bonus }) => [
      recipe_id,
      bonus,
    ]),
  );
  const activeRecipeList = [...activeRecipes.values()].sort(compareById);
  const configurations = new Map(
    activeRecipeList.map((recipe) => [
      recipe.id,
      configureRecipe(
        recipe,
        request,
        catalog.machines,
        machineById,
        moduleById,
        allowedMachines,
        catalogTechnologyBonuses,
      ),
    ]),
  );

  const balancedResources = collectBalancedResources(
    targetKeys,
    sourceResources,
    recipeSelections,
    request.byproduct_handlers ?? {},
    activeRecipes,
  );
  const matrix = balancedResources.map((key) => [
    ...activeRecipeList.map((recipe) =>
      netAmountPerCraft(
        recipe,
        key,
        requireConfiguration(configurations, recipe.id),
      ),
    ),
    targetRates.get(key) ?? Rational.ZERO,
  ]);
  const craftRates = solveUniqueFlow(
    matrix,
    activeRecipeList,
    hasDependencyCycle(activeRecipeList, recipeSelections),
  );
  const exactFlows = calculateFlows(
    activeRecipeList,
    configurations,
    craftRates,
  );

  const byproductPolicy = request.byproduct_policy ?? "surplus";
  const byproducts = collectNetRates(
    exactFlows,
    (key, flow) =>
      !targetKeys.has(key) && flow.produced.compare(flow.consumed) > 0,
    "positive",
  );
  if (byproductPolicy === "balanced" && byproducts.length > 0) {
    throw new ProductionError(
      "UNHANDLED_BYPRODUCT",
      `Balanced mode leaves ${byproducts.map(resourceKey).join(", ")} as surplus`,
      { byproducts },
    );
  }

  const beltSpeeds = {
    ...DEFAULT_BELT_SPEEDS,
    ...(request.belt_speeds ?? {}),
  };
  const flows = [...exactFlows.entries()]
    .map(([key, flow]) => toResourceFlow(key, flow))
    .sort(compareResources);
  const assumptions = buildAssumptions(
    byproductPolicy,
    sourceResources,
    beltSpeeds,
    recipeSelections,
    configurations,
  );

  return {
    targets: [...targetRates.entries()]
      .map(([key, rate]) => toResourceRate(key, rate))
      .sort(compareResources),
    recipes: activeRecipeList.map((recipe, index) =>
      buildRecipeStep(
        requireConfiguration(configurations, recipe.id),
        craftRates[index] ?? Rational.ZERO,
      ),
    ),
    external_inputs: collectNetRates(
      exactFlows,
      (_key, flow) => flow.consumed.compare(flow.produced) > 0,
      "negative",
    ),
    byproducts,
    fluid_rates: flows.filter((flow) => flow.kind === "fluid"),
    item_bandwidth: buildItemBandwidth(exactFlows, beltSpeeds),
    flows,
    assumptions,
  };
}

function validateInputs(
  catalog: ProductionCatalog,
  request: ProductionRequest,
): void {
  if (request.targets.length === 0) {
    throw new ProductionError("INVALID_INPUT", "At least one target is required");
  }
  for (const target of request.targets) {
    validateResource(target);
    assertPositiveFinite(target.rate, `target ${resourceKey(target)} rate`);
  }
  for (const recipe of catalog.recipes) {
    assertNonEmpty(recipe.id, "recipe id");
    assertNonEmpty(recipe.category, `recipe ${recipe.id} category`);
    assertPositiveFinite(recipe.energy_seconds, `recipe ${recipe.id} energy_seconds`);
    assertNonNegativeFinite(
      recipe.maximum_productivity,
      `recipe ${recipe.id} maximum_productivity`,
    );
    for (const component of [...recipe.ingredients, ...recipe.products]) {
      validateResource(component);
      assertNonNegativeFinite(
        component.amount,
        `recipe ${recipe.id} component ${resourceKey(component)} amount`,
      );
      if (component.ignored_by_productivity !== undefined) {
        assertNonNegativeFinite(
          component.ignored_by_productivity,
          `recipe ${recipe.id} ignored_by_productivity`,
        );
      }
    }
  }
  for (const machine of catalog.machines) {
    assertNonEmpty(machine.id, "machine id");
    assertPositiveFinite(machine.crafting_speed, `machine ${machine.id} speed`);
    if (!Number.isSafeInteger(machine.module_slots) || machine.module_slots < 0) {
      throw new ProductionError(
        "INVALID_INPUT",
        `Machine ${machine.id} has invalid module_slots`,
      );
    }
  }
  for (const module of catalog.modules) {
    assertNonEmpty(module.id, "module id");
    assertNonEmpty(module.category, `module ${module.id} category`);
    for (const [effect, value] of Object.entries(module.effects)) {
      if (!Number.isFinite(value)) {
        throw new ProductionError(
          "INVALID_INPUT",
          `Module ${module.id} effect ${effect} must be finite`,
        );
      }
    }
  }
  for (const key of request.source_resources ?? []) {
    parseResourceKey(key);
  }
  for (const [beltId, speed] of Object.entries(request.belt_speeds ?? {})) {
    assertNonEmpty(beltId, "belt id");
    assertPositiveFinite(speed, `belt ${beltId} speed`);
  }
  for (const [recipeId, bonus] of Object.entries(
    request.technology_productivity_bonuses ?? {},
  )) {
    assertNonEmpty(recipeId, "technology productivity recipe id");
    assertFinite(bonus, `recipe ${recipeId} technology productivity`);
  }
}

function configureRecipe(
  recipe: RecipeDescriptor,
  request: ProductionRequest,
  machines: MachineDescriptor[],
  machineById: Map<string, MachineDescriptor>,
  moduleById: Map<string, ModuleDescriptor>,
  allowedMachines: Set<string> | undefined,
  catalogTechnologyBonuses: Map<string, number>,
): RecipeConfiguration {
  const explicitMachineId = request.machine_choices?.[recipe.id];
  let machine: MachineDescriptor | undefined;

  if (explicitMachineId !== undefined) {
    const candidate = machineById.get(explicitMachineId);
    if (
      candidate !== undefined &&
      candidate.crafting_categories.includes(recipe.category) &&
      (allowedMachines === undefined || allowedMachines.has(candidate.id))
    ) {
      machine = candidate;
    }
  } else {
    machine = machines
      .filter(
        (candidate) =>
          candidate.crafting_categories.includes(recipe.category) &&
          (allowedMachines === undefined || allowedMachines.has(candidate.id)),
      )
      .sort(
        (left, right) =>
          right.crafting_speed - left.crafting_speed ||
          left.id.localeCompare(right.id),
      )[0];
  }

  if (machine === undefined) {
    throw new ProductionError(
      "NO_COMPATIBLE_MACHINE",
      `No allowed machine can craft ${recipe.id} (${recipe.category})`,
      {
        recipe_id: recipe.id,
        category: recipe.category,
        ...(explicitMachineId === undefined
          ? {}
          : { machine_id: explicitMachineId }),
      },
    );
  }

  const moduleIds = request.module_loadouts?.[recipe.id] ?? [];
  if (moduleIds.length > machine.module_slots) {
    throw new ProductionError(
      "MODULE_LIMIT_EXCEEDED",
      `${recipe.id} assigns ${moduleIds.length} modules to ${machine.module_slots} slots`,
      {
        recipe_id: recipe.id,
        machine_id: machine.id,
        module_slots: machine.module_slots,
        module_count: moduleIds.length,
      },
    );
  }

  const modules = moduleIds.map((moduleId) => {
    const module = moduleById.get(moduleId);
    if (module === undefined) {
      throw new ProductionError(
        "INVALID_MODULE",
        `Unknown module ${moduleId}`,
        { recipe_id: recipe.id, module_id: moduleId },
      );
    }
    validateModuleAllowed(recipe, machine, module);
    return module;
  });
  const speedBonus = sumEffects(modules, "speed");
  const moduleProductivityBonus = sumEffects(modules, "productivity");
  const requestBonus = request.technology_productivity_bonuses?.[recipe.id];
  const technologyProductivityBonus = Rational.from(
    requestBonus ?? catalogTechnologyBonuses.get(recipe.id) ?? 0,
  );
  const effectiveProductivityBonus = moduleProductivityBonus
    .add(technologyProductivityBonus)
    .min(Rational.from(recipe.maximum_productivity))
    .max(Rational.ZERO);
  const speedMultiplier = Rational.ONE.add(speedBonus).max(Rational.from(0.2));

  return {
    recipe,
    machine,
    modules,
    speedBonus,
    moduleProductivityBonus,
    technologyProductivityBonus,
    effectiveProductivityBonus,
    effectiveCraftingSpeed: Rational.from(machine.crafting_speed).multiply(
      speedMultiplier,
    ),
  };
}

function validateModuleAllowed(
  recipe: RecipeDescriptor,
  machine: MachineDescriptor,
  module: ModuleDescriptor,
): void {
  if (
    !allows(machine.allowed_module_categories, module.category) ||
    !allows(recipe.allowed_module_categories, module.category)
  ) {
    throw new ProductionError(
      "MODULE_NOT_ALLOWED",
      `Module ${module.id} category ${module.category} is not allowed for ${recipe.id}`,
      {
        recipe_id: recipe.id,
        machine_id: machine.id,
        module_id: module.id,
      },
    );
  }

  for (const effect of ["speed", "productivity"] as const) {
    const value = module.effects[effect] ?? 0;
    if (
      value !== 0 &&
      (!allows(machine.allowed_effects, effect) ||
        !allows(recipe.allowed_effects, effect))
    ) {
      throw new ProductionError(
        "MODULE_NOT_ALLOWED",
        `Module ${module.id} effect ${effect} is not allowed for ${recipe.id}`,
        {
          recipe_id: recipe.id,
          machine_id: machine.id,
          module_id: module.id,
          effect,
        },
      );
    }
  }
}

function allows(allowed: string[], value: string): boolean {
  return allowed.length === 0 || allowed.includes(value);
}

function sumEffects(
  modules: ModuleDescriptor[],
  effect: "speed" | "productivity",
): Rational {
  return modules.reduce(
    (total, module) => total.add(Rational.from(module.effects[effect] ?? 0)),
    Rational.ZERO,
  );
}

function collectBalancedResources(
  targetKeys: Set<string>,
  sourceResources: Set<string>,
  recipeSelections: Map<string, string>,
  byproductHandlers: Record<string, string>,
  activeRecipes: Map<string, RecipeDescriptor>,
): string[] {
  const balanced = new Set(targetKeys);

  for (const key of recipeSelections.keys()) {
    if (!sourceResources.has(key)) {
      balanced.add(key);
    }
  }
  const activeProductKeys = collectProductKeys(activeRecipes.values());
  for (const [key, handlerId] of Object.entries(byproductHandlers)) {
    if (activeProductKeys.has(key) && activeRecipes.has(handlerId)) {
      balanced.add(key);
    }
  }

  return [...balanced].sort();
}

function netAmountPerCraft(
  recipe: RecipeDescriptor,
  key: string,
  configuration: RecipeConfiguration,
): Rational {
  const produced = recipe.products
    .filter((product) => resourceKey(product) === key)
    .reduce(
      (total, product) =>
        total.add(
          effectiveProductAmount(
            product,
            configuration.effectiveProductivityBonus,
          ),
        ),
      Rational.ZERO,
    );
  const consumed = recipe.ingredients
    .filter((ingredient) => resourceKey(ingredient) === key)
    .reduce(
      (total, ingredient) => total.add(Rational.from(ingredient.amount)),
      Rational.ZERO,
    );
  return produced.subtract(consumed);
}

function effectiveProductAmount(
  product: RecipeComponent,
  productivityBonus: Rational,
): Rational {
  const amount = Rational.from(product.amount);
  const ignored = Rational.from(product.ignored_by_productivity ?? 0);
  const affected = amount.subtract(ignored).max(Rational.ZERO);
  return amount.add(affected.multiply(productivityBonus));
}

function solveUniqueFlow(
  input: Rational[][],
  recipes: RecipeDescriptor[],
  dependencyCycle: boolean,
): Rational[] {
  const columnCount = recipes.length;
  const matrix = input.map((row) => [...row]);
  const pivotRows = new Array<number>(columnCount).fill(-1);
  let nextPivotRow = 0;

  for (
    let column = 0;
    column < columnCount && nextPivotRow < matrix.length;
    column += 1
  ) {
    const selectedRow = matrix.findIndex(
      (row, index) =>
        index >= nextPivotRow && !(row[column] ?? Rational.ZERO).isZero(),
    );
    if (selectedRow < 0) {
      continue;
    }

    [matrix[nextPivotRow], matrix[selectedRow]] = [
      matrix[selectedRow] ?? [],
      matrix[nextPivotRow] ?? [],
    ];
    const pivotRow = matrix[nextPivotRow];
    const pivot = pivotRow?.[column];
    if (pivotRow === undefined || pivot === undefined) {
      throw new Error("Flow matrix pivot is missing");
    }
    for (let index = column; index <= columnCount; index += 1) {
      pivotRow[index] = (pivotRow[index] ?? Rational.ZERO).divide(pivot);
    }

    for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
      if (rowIndex === nextPivotRow) {
        continue;
      }
      const row = matrix[rowIndex];
      const factor = row?.[column] ?? Rational.ZERO;
      if (row === undefined || factor.isZero()) {
        continue;
      }
      for (let index = column; index <= columnCount; index += 1) {
        row[index] = (row[index] ?? Rational.ZERO).subtract(
          factor.multiply(pivotRow[index] ?? Rational.ZERO),
        );
      }
    }

    pivotRows[column] = nextPivotRow;
    nextPivotRow += 1;
  }

  for (const row of matrix) {
    const allZero = row
      .slice(0, columnCount)
      .every((value) => value.isZero());
    if (allZero && !(row[columnCount] ?? Rational.ZERO).isZero()) {
      if (dependencyCycle) {
        throw new ProductionError(
          "CYCLIC_RECIPE_GRAPH",
          "Recipe dependency cycle cannot produce the requested net output",
          { recipe_ids: recipes.map((recipe) => recipe.id) },
        );
      }
      throw new ProductionError(
        "UNSATISFIABLE_FLOW",
        "Selected recipes cannot satisfy the requested target and coproduct balances",
      );
    }
  }

  if (pivotRows.some((row) => row < 0)) {
    if (!dependencyCycle) {
      throw new ProductionError(
        "UNSATISFIABLE_FLOW",
        "Selected recipes leave an underdetermined production flow",
        {
          recipe_ids: recipes.map((recipe) => recipe.id),
        },
      );
    }
    throw new ProductionError(
      "CYCLIC_RECIPE_GRAPH",
      "Recipe graph has an unresolved cycle or underdetermined flow",
      {
        recipe_ids: recipes.map((recipe) => recipe.id),
      },
    );
  }

  return pivotRows.map((rowIndex, column) => {
    const value = matrix[rowIndex]?.[columnCount] ?? Rational.ZERO;
    if (value.isNegative()) {
      throw new ProductionError(
        "UNSATISFIABLE_FLOW",
        `Selected recipes require a negative craft rate for ${recipes[column]?.id ?? "unknown"}`,
        {
          recipe_id: recipes[column]?.id,
          craft_rate: value.toFraction(),
        },
      );
    }
    return value;
  });
}

function hasDependencyCycle(
  recipes: RecipeDescriptor[],
  recipeSelections: Map<string, string>,
): boolean {
  const activeIds = new Set(recipes.map((recipe) => recipe.id));
  const edges = new Map(
    recipes.map((recipe) => [
      recipe.id,
      new Set(
        recipe.ingredients
          .filter((ingredient) => ingredient.amount > 0)
          .map((ingredient) => recipeSelections.get(resourceKey(ingredient)))
          .filter(
            (recipeId): recipeId is string =>
              recipeId !== undefined && activeIds.has(recipeId),
          ),
      ),
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (recipeId: string): boolean => {
    if (visiting.has(recipeId)) {
      return true;
    }
    if (visited.has(recipeId)) {
      return false;
    }
    visiting.add(recipeId);
    for (const dependency of edges.get(recipeId) ?? []) {
      if (visit(dependency)) {
        return true;
      }
    }
    visiting.delete(recipeId);
    visited.add(recipeId);
    return false;
  };

  return recipes.some((recipe) => visit(recipe.id));
}

function calculateFlows(
  recipes: RecipeDescriptor[],
  configurations: Map<string, RecipeConfiguration>,
  craftRates: Rational[],
): Map<string, ExactFlow> {
  const flows = new Map<string, ExactFlow>();

  recipes.forEach((recipe, index) => {
    const craftRate = craftRates[index] ?? Rational.ZERO;
    const configuration = requireConfiguration(configurations, recipe.id);

    for (const ingredient of recipe.ingredients) {
      addFlow(
        flows,
        resourceKey(ingredient),
        Rational.ZERO,
        Rational.from(ingredient.amount).multiply(craftRate),
      );
    }
    for (const product of recipe.products) {
      addFlow(
        flows,
        resourceKey(product),
        effectiveProductAmount(
          product,
          configuration.effectiveProductivityBonus,
        ).multiply(craftRate),
        Rational.ZERO,
      );
    }
  });

  return flows;
}

function addFlow(
  flows: Map<string, ExactFlow>,
  key: string,
  produced: Rational,
  consumed: Rational,
): void {
  const current = flows.get(key) ?? {
    produced: Rational.ZERO,
    consumed: Rational.ZERO,
  };
  flows.set(key, {
    produced: current.produced.add(produced),
    consumed: current.consumed.add(consumed),
  });
}

function buildRecipeStep(
  configuration: RecipeConfiguration,
  craftRate: Rational,
): RecipeStep {
  const { recipe, machine } = configuration;
  const machineCount = craftRate
    .multiply(Rational.from(recipe.energy_seconds))
    .divide(configuration.effectiveCraftingSpeed);

  return {
    recipe_id: recipe.id,
    category: recipe.category,
    machine_id: machine.id,
    machine_crafting_speed: machine.crafting_speed,
    effective_crafting_speed: configuration.effectiveCraftingSpeed.toNumber(),
    module_ids: configuration.modules.map((module) => module.id),
    module_speed_bonus: configuration.speedBonus.toNumber(),
    module_productivity_bonus:
      configuration.moduleProductivityBonus.toNumber(),
    technology_productivity_bonus:
      configuration.technologyProductivityBonus.toNumber(),
    effective_productivity_bonus:
      configuration.effectiveProductivityBonus.toNumber(),
    crafts: toRateValue(craftRate),
    machines: {
      exact: machineCount.toNumber(),
      exact_fraction: machineCount.toFraction(),
      rounded_up: machineCount.ceil(),
    },
    ingredients: recipe.ingredients
      .map((ingredient) =>
        toResourceRate(
          resourceKey(ingredient),
          Rational.from(ingredient.amount).multiply(craftRate),
        ),
      )
      .sort(compareResources),
    products: recipe.products
      .map((product) =>
        toResourceRate(
          resourceKey(product),
          effectiveProductAmount(
            product,
            configuration.effectiveProductivityBonus,
          ).multiply(craftRate),
        ),
      )
      .sort(compareResources),
  };
}

function buildItemBandwidth(
  flows: Map<string, ExactFlow>,
  beltSpeeds: Record<string, number>,
): ItemBandwidth[] {
  return [...flows.entries()]
    .filter(([key]) => parseResourceKey(key).kind === "item")
    .map(([key, flow]) => {
      const resource = parseResourceKey(key);
      const throughput = flow.produced.max(flow.consumed);
      return {
        kind: "item" as const,
        id: resource.id,
        throughput_per_second: throughput.toNumber(),
        belts: Object.entries(beltSpeeds)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([beltId, speed]) =>
            toBeltRequirement(beltId, speed, throughput),
          ),
      };
    })
    .sort(compareResources);
}

function toBeltRequirement(
  beltId: string,
  speed: number,
  throughput: Rational,
): BeltRequirement {
  const exact = throughput.divide(Rational.from(speed));
  return {
    belt_id: beltId,
    belt_speed_per_second: speed,
    exact: exact.toNumber(),
    exact_fraction: exact.toFraction(),
    rounded_up: exact.ceil(),
  };
}

function buildAssumptions(
  byproductPolicy: ByproductPolicy,
  sourceResources: Set<string>,
  beltSpeeds: Record<string, number>,
  recipeSelections: Map<string, string>,
  configurations: Map<string, RecipeConfiguration>,
): ProductionAssumptions {
  const sortedConfigurations = [...configurations.values()].sort((left, right) =>
    left.recipe.id.localeCompare(right.recipe.id),
  );
  return {
    byproduct_policy: byproductPolicy,
    rounding:
      "All rates use exact rational arithmetic; rounded_up applies only to whole-machine and whole-belt views.",
    source_resources: [...sourceResources].sort(),
    belt_speeds: Object.fromEntries(
      Object.entries(beltSpeeds).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    recipe_selections: Object.fromEntries(
      [...recipeSelections.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    machine_selections: Object.fromEntries(
      sortedConfigurations.map((configuration) => [
        configuration.recipe.id,
        configuration.machine.id,
      ]),
    ),
    module_loadouts: Object.fromEntries(
      sortedConfigurations.map((configuration) => [
        configuration.recipe.id,
        configuration.modules.map((module) => module.id),
      ]),
    ),
    technology_productivity_bonuses: Object.fromEntries(
      sortedConfigurations.map((configuration) => [
        configuration.recipe.id,
        configuration.technologyProductivityBonus.toNumber(),
      ]),
    ),
  };
}

function collectNetRates(
  flows: Map<string, ExactFlow>,
  predicate: (key: string, flow: ExactFlow) => boolean,
  direction: "positive" | "negative",
): ResourceRate[] {
  return [...flows.entries()]
    .filter(([key, flow]) => predicate(key, flow))
    .map(([key, flow]) => {
      const net = flow.produced.subtract(flow.consumed);
      return toResourceRate(key, direction === "positive" ? net : net.negate());
    })
    .sort(compareResources);
}

function toResourceFlow(key: string, flow: ExactFlow): ResourceFlow {
  const resource = parseResourceKey(key);
  return {
    ...resource,
    produced_per_second: flow.produced.toNumber(),
    consumed_per_second: flow.consumed.toNumber(),
    net_per_second: flow.produced.subtract(flow.consumed).toNumber(),
  };
}

function toResourceRate(key: string, rate: Rational): ResourceRate {
  return {
    ...parseResourceKey(key),
    ...toRateValue(rate),
  };
}

function toRateValue(rate: Rational): RateValue {
  return {
    per_second: rate.toNumber(),
    per_minute: rate.multiply(Rational.from(60)).toNumber(),
    per_second_fraction: rate.toFraction(),
  };
}

function aggregateTargets(request: ProductionRequest): Map<string, Rational> {
  const result = new Map<string, Rational>();
  for (const target of request.targets) {
    const key = resourceKey(target);
    const rate = Rational.from(target.rate).divide(
      Rational.from(target.unit === "minute" ? 60 : 1),
    );
    result.set(key, (result.get(key) ?? Rational.ZERO).add(rate));
  }
  return result;
}

/**
 * True when a recipe only recovers `key` from a container that nothing but a
 * recipe consuming `key` can make, as with Factorio's barrelling pair. Such a
 * recipe cannot originate new supply, so it is never a real production route.
 */
function isRepackagingRecipe(
  recipe: RecipeDescriptor,
  key: string,
  recipesByProduct: Map<string, RecipeDescriptor[]>,
  availableRecipes: Set<string> | undefined,
  sourceResources: Set<string>,
): boolean {
  const ingredients = recipe.ingredients.filter(
    (ingredient) => ingredient.amount > 0,
  );
  if (ingredients.length === 0) {
    return false;
  }

  return ingredients.every((ingredient) => {
    const ingredientKey = resourceKey(ingredient);
    if (ingredientKey === key || sourceResources.has(ingredientKey)) {
      return false;
    }
    const producers = (recipesByProduct.get(ingredientKey) ?? []).filter(
      (producer) =>
        producer.id !== recipe.id &&
        (availableRecipes === undefined || availableRecipes.has(producer.id)),
    );
    // An ingredient nothing can make is a dead end, not a round trip.
    if (producers.length === 0) {
      return false;
    }
    return producers.every((producer) =>
      producer.ingredients.some(
        (input) => input.amount > 0 && resourceKey(input) === key,
      ),
    );
  });
}

function indexRecipesByProduct(
  recipes: RecipeDescriptor[],
): Map<string, RecipeDescriptor[]> {
  const result = new Map<string, RecipeDescriptor[]>();
  for (const recipe of recipes) {
    for (const product of recipe.products) {
      if (product.amount === 0) {
        continue;
      }
      const key = resourceKey(product);
      const entries = result.get(key) ?? [];
      entries.push(recipe);
      result.set(key, entries);
    }
  }
  return result;
}

function collectProductKeys(
  recipes: Iterable<RecipeDescriptor>,
): Set<string> {
  const result = new Set<string>();
  for (const recipe of recipes) {
    for (const product of recipe.products) {
      if (product.amount > 0) {
        result.add(resourceKey(product));
      }
    }
  }
  return result;
}

function recipeProduces(recipe: RecipeDescriptor, key: string): boolean {
  return recipe.products.some(
    (product) => product.amount > 0 && resourceKey(product) === key,
  );
}

function recipeConsumes(recipe: RecipeDescriptor, key: string): boolean {
  return recipe.ingredients.some(
    (ingredient) => ingredient.amount > 0 && resourceKey(ingredient) === key,
  );
}

function uniqueById<T extends { id: string }>(
  values: T[],
  kind: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) {
      throw new ProductionError(
        "INVALID_INPUT",
        `Duplicate ${kind} id ${value.id}`,
      );
    }
    result.set(value.id, value);
  }
  return result;
}

function requireConfiguration(
  configurations: Map<string, RecipeConfiguration>,
  recipeId: string,
): RecipeConfiguration {
  const configuration = configurations.get(recipeId);
  if (configuration === undefined) {
    throw new Error(`Missing configuration for recipe ${recipeId}`);
  }
  return configuration;
}

function resourceKey(resource: ResourceReference): string {
  return `${resource.kind}:${resource.id}`;
}

function parseResourceKey(key: string): ResourceReference {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if ((kind !== "item" && kind !== "fluid") || separator <= 0 || id.length === 0) {
    throw new ProductionError(
      "INVALID_INPUT",
      `Resource key ${key} must use item:<id> or fluid:<id>`,
      { resource: key },
    );
  }
  return { kind, id };
}

function validateResource(resource: ResourceReference): void {
  if (resource.kind !== "item" && resource.kind !== "fluid") {
    throw new ProductionError(
      "INVALID_INPUT",
      `Unsupported resource kind ${String(resource.kind)}`,
    );
  }
  assertNonEmpty(resource.id, "resource id");
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new ProductionError("INVALID_INPUT", `${field} must not be empty`);
  }
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProductionError(
      "INVALID_INPUT",
      `${field} must be a positive finite number`,
    );
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ProductionError(
      "INVALID_INPUT",
      `${field} must be a non-negative finite number`,
    );
  }
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new ProductionError(
      "INVALID_INPUT",
      `${field} must be a finite number`,
    );
  }
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function compareResources(
  left: ResourceReference,
  right: ResourceReference,
): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}
