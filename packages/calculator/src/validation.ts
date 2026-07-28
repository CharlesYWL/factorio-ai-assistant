import type {
  MachineDescriptor,
  ModuleDescriptor,
  ModuleEffectsDescriptor,
  RecipeComponent,
  RecipeDescriptor,
  RecipeProductivityBonusDescriptor,
} from "@factorio-ai-assistant/protocol";

import {
  ProductionError,
  type ProductionCatalog,
  type ProductionRequest,
  type RateTarget,
} from "./types.js";

export function parseProductionCatalog(value: unknown): ProductionCatalog {
  const record = readRecord(value, "catalog");
  const bonuses =
    record.recipe_productivity_bonuses === undefined
      ? undefined
      : readArray(
          record.recipe_productivity_bonuses,
          "catalog.recipe_productivity_bonuses",
          readProductivityBonus,
        );

  return {
    recipes: readArray(record.recipes, "catalog.recipes", readRecipe),
    machines: readArray(record.machines, "catalog.machines", readMachine),
    modules: readArray(record.modules, "catalog.modules", readModule),
    ...(bonuses === undefined ? {} : { recipe_productivity_bonuses: bonuses }),
  };
}

export function parseProductionRequest(value: unknown): ProductionRequest {
  const record = readRecord(value, "request");
  const byproductPolicy =
    record.byproduct_policy === undefined
      ? undefined
      : readEnum(record.byproduct_policy, "request.byproduct_policy", [
          "surplus",
          "balanced",
        ] as const);
  const availableRecipeIds = readOptionalStringArray(
    record.available_recipe_ids,
    "request.available_recipe_ids",
  );
  const recipeChoices = readOptionalStringMap(
    record.recipe_choices,
    "request.recipe_choices",
  );
  const allowedMachineIds = readOptionalStringArray(
    record.allowed_machine_ids,
    "request.allowed_machine_ids",
  );
  const machineChoices = readOptionalStringMap(
    record.machine_choices,
    "request.machine_choices",
  );
  const moduleLoadouts = readOptionalStringArrayMap(
    record.module_loadouts,
    "request.module_loadouts",
  );
  const technologyProductivityBonuses = readOptionalNumberMap(
    record.technology_productivity_bonuses,
    "request.technology_productivity_bonuses",
  );
  const sourceResources = readOptionalStringArray(
    record.source_resources,
    "request.source_resources",
  );
  const byproductHandlers = readOptionalStringMap(
    record.byproduct_handlers,
    "request.byproduct_handlers",
  );
  const beltSpeeds = readOptionalNumberMap(
    record.belt_speeds,
    "request.belt_speeds",
  );

  return {
    targets: readArray(record.targets, "request.targets", readTarget),
    ...(availableRecipeIds === undefined
      ? {}
      : { available_recipe_ids: availableRecipeIds }),
    ...(recipeChoices === undefined ? {} : { recipe_choices: recipeChoices }),
    ...(allowedMachineIds === undefined
      ? {}
      : { allowed_machine_ids: allowedMachineIds }),
    ...(machineChoices === undefined
      ? {}
      : { machine_choices: machineChoices }),
    ...(moduleLoadouts === undefined
      ? {}
      : { module_loadouts: moduleLoadouts }),
    ...(technologyProductivityBonuses === undefined
      ? {}
      : { technology_productivity_bonuses: technologyProductivityBonuses }),
    ...(sourceResources === undefined
      ? {}
      : { source_resources: sourceResources }),
    ...(byproductPolicy === undefined
      ? {}
      : { byproduct_policy: byproductPolicy }),
    ...(byproductHandlers === undefined
      ? {}
      : { byproduct_handlers: byproductHandlers }),
    ...(beltSpeeds === undefined ? {} : { belt_speeds: beltSpeeds }),
  };
}

function readRecipe(value: unknown, path: string): RecipeDescriptor {
  const record = readRecord(value, path);
  return {
    id: readString(record.id, `${path}.id`),
    category: readString(record.category, `${path}.category`),
    energy_seconds: readNumber(record.energy_seconds, `${path}.energy_seconds`),
    ingredients: readArray(
      record.ingredients,
      `${path}.ingredients`,
      readComponent,
    ),
    products: readArray(record.products, `${path}.products`, readComponent),
    allowed_effects: readStringArray(
      record.allowed_effects,
      `${path}.allowed_effects`,
    ),
    allowed_module_categories: readStringArray(
      record.allowed_module_categories,
      `${path}.allowed_module_categories`,
    ),
    maximum_productivity: readNumber(
      record.maximum_productivity,
      `${path}.maximum_productivity`,
    ),
  };
}

function readComponent(value: unknown, path: string): RecipeComponent {
  const record = readRecord(value, path);
  const kind = readEnum(record.kind, `${path}.kind`, ["item", "fluid"] as const);
  const ignoredByProductivity = readOptionalNumber(
    record.ignored_by_productivity,
    `${path}.ignored_by_productivity`,
  );
  const temperature = readOptionalNumber(record.temperature, `${path}.temperature`);
  const minimumTemperature = readOptionalNumber(
    record.minimum_temperature,
    `${path}.minimum_temperature`,
  );
  const maximumTemperature = readOptionalNumber(
    record.maximum_temperature,
    `${path}.maximum_temperature`,
  );

  return {
    kind,
    id: readString(record.id, `${path}.id`),
    amount: readNumber(record.amount, `${path}.amount`),
    ...(ignoredByProductivity === undefined
      ? {}
      : { ignored_by_productivity: ignoredByProductivity }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(minimumTemperature === undefined
      ? {}
      : { minimum_temperature: minimumTemperature }),
    ...(maximumTemperature === undefined
      ? {}
      : { maximum_temperature: maximumTemperature }),
  };
}

function readMachine(value: unknown, path: string): MachineDescriptor {
  const record = readRecord(value, path);
  return {
    id: readString(record.id, `${path}.id`),
    kind: readString(record.kind, `${path}.kind`),
    crafting_speed: readNumber(record.crafting_speed, `${path}.crafting_speed`),
    crafting_categories: readStringArray(
      record.crafting_categories,
      `${path}.crafting_categories`,
    ),
    module_slots: readInteger(record.module_slots, `${path}.module_slots`),
    allowed_effects: readStringArray(
      record.allowed_effects,
      `${path}.allowed_effects`,
    ),
    allowed_module_categories: readStringArray(
      record.allowed_module_categories,
      `${path}.allowed_module_categories`,
    ),
  };
}

function readModule(value: unknown, path: string): ModuleDescriptor {
  const record = readRecord(value, path);
  const effectsRecord = readRecord(record.effects, `${path}.effects`);
  const effects: ModuleEffectsDescriptor = {};

  for (const effect of [
    "consumption",
    "speed",
    "productivity",
    "pollution",
    "quality",
  ] as const) {
    const parsed = readOptionalNumber(
      effectsRecord[effect],
      `${path}.effects.${effect}`,
    );
    if (parsed !== undefined) {
      effects[effect] = parsed;
    }
  }

  return {
    id: readString(record.id, `${path}.id`),
    category: readString(record.category, `${path}.category`),
    effects,
  };
}

function readProductivityBonus(
  value: unknown,
  path: string,
): RecipeProductivityBonusDescriptor {
  const record = readRecord(value, path);
  return {
    recipe_id: readString(record.recipe_id, `${path}.recipe_id`),
    bonus: readNumber(record.bonus, `${path}.bonus`),
  };
}

function readTarget(value: unknown, path: string): RateTarget {
  const record = readRecord(value, path);
  const unit =
    record.unit === undefined
      ? undefined
      : readEnum(record.unit, `${path}.unit`, ["second", "minute"] as const);
  return {
    kind: readEnum(record.kind, `${path}.kind`, ["item", "fluid"] as const),
    id: readString(record.id, `${path}.id`),
    rate: readNumber(record.rate, `${path}.rate`),
    ...(unit === undefined ? {} : { unit }),
  };
}

function readOptionalStringArray(
  value: unknown,
  path: string,
): string[] | undefined {
  return value === undefined ? undefined : readStringArray(value, path);
}

function readOptionalStringMap(
  value: unknown,
  path: string,
): Record<string, string> | undefined {
  return value === undefined ? undefined : readStringMap(value, path);
}

function readOptionalStringArrayMap(
  value: unknown,
  path: string,
): Record<string, string[]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = readRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([entryKey, entryValue]) => [
      entryKey,
      readStringArray(entryValue, `${path}.${entryKey}`),
    ]),
  );
}

function readOptionalNumberMap(
  value: unknown,
  path: string,
): Record<string, number> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = readRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([entryKey, entryValue]) => [
      entryKey,
      readNumber(entryValue, `${path}.${entryKey}`),
    ]),
  );
}

function readStringMap(value: unknown, path: string): Record<string, string> {
  const record = readRecord(value, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, entryValue]) => [
      key,
      readString(entryValue, `${path}.${key}`),
    ]),
  );
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray<T>(
  value: unknown,
  path: string,
  readItem: (item: unknown, itemPath: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw invalid(`${path} must be an array`);
  }
  return value.map((item, index) => readItem(item, `${path}[${index}]`));
}

function readStringArray(value: unknown, path: string): string[] {
  return readArray(value, path, readString);
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${path} must be a non-empty string`);
  }
  return value;
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${path} must be a finite number`);
  }
  return value;
}

function readOptionalNumber(
  value: unknown,
  path: string,
): number | undefined {
  return value === undefined ? undefined : readNumber(value, path);
}

function readInteger(value: unknown, path: string): number {
  const parsed = readNumber(value, path);
  if (!Number.isSafeInteger(parsed)) {
    throw invalid(`${path} must be a safe integer`);
  }
  return parsed;
}

function readEnum<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: Values,
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalid(`${path} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function invalid(message: string): ProductionError {
  return new ProductionError("INVALID_INPUT", message);
}
