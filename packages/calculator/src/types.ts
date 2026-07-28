import type {
  MachineDescriptor,
  ModuleDescriptor,
  RecipeDescriptor,
  RecipeProductivityBonusDescriptor,
} from "@factorio-ai-assistant/protocol";

export type ResourceKind = "item" | "fluid";
export type RateUnit = "second" | "minute";
export type ByproductPolicy = "surplus" | "balanced";

export interface ResourceReference {
  kind: ResourceKind;
  id: string;
}

export interface RateTarget extends ResourceReference {
  rate: number;
  unit?: RateUnit;
}

export interface ProductionCatalog {
  recipes: RecipeDescriptor[];
  machines: MachineDescriptor[];
  modules: ModuleDescriptor[];
  recipe_productivity_bonuses?: RecipeProductivityBonusDescriptor[];
}

export interface ProductionRequest {
  targets: RateTarget[];
  available_recipe_ids?: string[];
  recipe_choices?: Record<string, string>;
  allowed_machine_ids?: string[];
  machine_choices?: Record<string, string>;
  module_loadouts?: Record<string, string[]>;
  technology_productivity_bonuses?: Record<string, number>;
  source_resources?: string[];
  byproduct_policy?: ByproductPolicy;
  byproduct_handlers?: Record<string, string>;
  belt_speeds?: Record<string, number>;
}

export type ProductionErrorCode =
  | "INVALID_INPUT"
  | "TARGET_UNREACHABLE"
  | "AMBIGUOUS_RECIPE"
  | "UNAVAILABLE_RECIPE"
  | "NO_COMPATIBLE_MACHINE"
  | "INVALID_MODULE"
  | "MODULE_LIMIT_EXCEEDED"
  | "MODULE_NOT_ALLOWED"
  | "CYCLIC_RECIPE_GRAPH"
  | "UNSATISFIABLE_FLOW"
  | "UNHANDLED_BYPRODUCT";

export class ProductionError extends Error {
  public readonly code: ProductionErrorCode;
  public readonly details: Record<string, unknown>;

  public constructor(
    code: ProductionErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProductionError";
    this.code = code;
    this.details = details;
  }
}

export interface RateValue {
  per_second: number;
  per_minute: number;
  per_second_fraction: string;
}

export interface ResourceRate extends ResourceReference, RateValue {}

export interface ResourceFlow extends ResourceReference {
  produced_per_second: number;
  consumed_per_second: number;
  net_per_second: number;
}

export interface MachineCount {
  exact: number;
  exact_fraction: string;
  rounded_up: number;
}

export interface RecipeStep {
  recipe_id: string;
  category: string;
  machine_id: string;
  machine_crafting_speed: number;
  effective_crafting_speed: number;
  module_ids: string[];
  module_speed_bonus: number;
  module_productivity_bonus: number;
  technology_productivity_bonus: number;
  effective_productivity_bonus: number;
  crafts: RateValue;
  machines: MachineCount;
  ingredients: ResourceRate[];
  products: ResourceRate[];
}

export interface BeltRequirement {
  belt_id: string;
  belt_speed_per_second: number;
  exact: number;
  exact_fraction: string;
  rounded_up: number;
}

export interface ItemBandwidth extends ResourceReference {
  kind: "item";
  throughput_per_second: number;
  belts: BeltRequirement[];
}

export interface ProductionAssumptions {
  byproduct_policy: ByproductPolicy;
  rounding: string;
  source_resources: string[];
  belt_speeds: Record<string, number>;
  recipe_selections: Record<string, string>;
  machine_selections: Record<string, string>;
  module_loadouts: Record<string, string[]>;
  technology_productivity_bonuses: Record<string, number>;
}

export interface ProductionResult {
  targets: ResourceRate[];
  recipes: RecipeStep[];
  external_inputs: ResourceRate[];
  byproducts: ResourceRate[];
  fluid_rates: ResourceFlow[];
  item_bandwidth: ItemBandwidth[];
  flows: ResourceFlow[];
  assumptions: ProductionAssumptions;
}
