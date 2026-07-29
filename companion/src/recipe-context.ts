import type { LocalizedNameLookup } from "./localization.js";
import type { StaticState } from "./state-store.js";

/** How far upstream to follow ingredients when ranking by relevance. */
const MAX_EXPANSION_DEPTH = 12;
/** Shortest name allowed to match, so single characters do not match noise. */
const MIN_NAME_MATCH_LENGTH = 2;

/**
 * A recipe in compact form. Verbose JSON objects cost roughly 600 bytes each,
 * which puts a 200-recipe catalog well past any workable budget, so ingredients
 * and products are `[id, amount]` pairs and display names live once in a shared
 * dictionary rather than being repeated on every occurrence.
 */
export interface ContextRecipe {
  /** `[recipe_id, seconds, category]`. */
  r: [string, number, string];
  /** Ingredients as `[id, amount]`. */
  i: Array<[string, number]>;
  /** Products as `[id, amount]`. */
  o: Array<[string, number]>;
}

export interface ContextMachine {
  id: string;
  name?: string;
  speed: number;
  categories: string[];
}

export interface RecipeContext {
  /** How to read the compact recipe rows. */
  format: string;
  recipes: ContextRecipe[];
  machines: ContextMachine[];
  /** `id -> in-game display name`, for every id appearing above. */
  names: Record<string, string>;
  /** True when the byte budget forced recipes to be dropped. */
  truncated: boolean;
}

/**
 * Hands the model every recipe this force can currently craft.
 *
 * An earlier version sent only the subgraph for products it could match by
 * name, which failed whenever the player used a colloquial term: this save
 * calls utility science "银金分析包", so "黄瓶" matched nothing and the model
 * was left to guess from vanilla. The model can map the nickname itself as
 * long as it can see the catalog, so the catalog is sent in full.
 *
 * Recipes are ordered by how closely they relate to what the question names, so
 * that if the budget ever forces a trim, the relevant chain survives.
 */
export function buildRecipeContext(
  question: string,
  staticState: StaticState | undefined,
  names: LocalizedNameLookup,
  forceId?: string,
): RecipeContext | undefined {
  if (staticState === undefined || staticState.recipes.length === 0) {
    return undefined;
  }

  const available = availableRecipeIds(staticState, forceId);
  const recipes = staticState.recipes.filter(
    (recipe) => available === undefined || available.has(recipe.id),
  );
  if (recipes.length === 0) {
    return undefined;
  }

  const ranked = rankByRelevance(question, recipes, names);
  const contextRecipes: ContextRecipe[] = ranked.map((recipe) => ({
    r: [recipe.id, recipe.energy_seconds, recipe.category],
    i: recipe.ingredients.map(
      (ingredient) => [ingredient.id, ingredient.amount] as [string, number],
    ),
    o: recipe.products.map(
      (product) => [product.id, product.amount] as [string, number],
    ),
  }));

  const machines: ContextMachine[] = staticState.machines
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((machine) => ({
      id: machine.id,
      ...named(names.lookup("machine", machine.id), machine.id),
      speed: machine.crafting_speed,
      categories: machine.crafting_categories,
    }));

  return {
    format:
      "recipes[].r = [recipe_id, crafting_seconds, category]; .i = ingredients as [id, amount]; .o = products as [id, amount]. A machine can run a recipe when its categories include that recipe's category. names maps id -> in-game display name.",
    recipes: contextRecipes,
    machines,
    names: displayNames(ranked, staticState, names),
    truncated: false,
  };
}

/** One entry per translated id used above, instead of repeating names inline. */
function displayNames(
  recipes: StaticState["recipes"],
  staticState: StaticState,
  names: LocalizedNameLookup,
): Record<string, string> {
  const result: Record<string, string> = {};
  const add = (kind: "item" | "fluid" | "recipe" | "machine", id: string) => {
    if (id in result) {
      return;
    }
    const name = names.lookup(kind, id);
    if (name !== undefined && name !== id) {
      result[id] = name;
    }
  };

  for (const recipe of recipes) {
    add("recipe", recipe.id);
    for (const ingredient of recipe.ingredients) {
      add(ingredient.kind, ingredient.id);
    }
    for (const product of recipe.products) {
      add(product.kind, product.id);
    }
  }
  for (const machine of staticState.machines) {
    add("machine", machine.id);
  }
  return result;
}

/**
 * Orders recipes so the ones the question is about come first: products named
 * in the question, then their upstream chain by depth, then everything else.
 * This only affects ordering — nothing is dropped here.
 */
function rankByRelevance<T extends StaticState["recipes"][number]>(
  question: string,
  recipes: T[],
  names: LocalizedNameLookup,
): T[] {
  const producers = new Map<string, string[]>();
  for (const recipe of recipes) {
    for (const product of recipe.products) {
      if (product.amount <= 0) {
        continue;
      }
      const entries = producers.get(product.id) ?? [];
      entries.push(recipe.id);
      producers.set(product.id, entries);
    }
  }

  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const depth = new Map<string, number>();
  const queue = findMentionedProducts(question, producers, names).map(
    (productId) => ({ productId, depth: 0 }),
  );
  const visited = new Set<string>();

  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined || visited.has(entry.productId)) {
      continue;
    }
    visited.add(entry.productId);
    if (entry.depth > MAX_EXPANSION_DEPTH) {
      continue;
    }
    for (const recipeId of producers.get(entry.productId) ?? []) {
      if (!depth.has(recipeId)) {
        depth.set(recipeId, entry.depth);
      }
      for (const ingredient of byId.get(recipeId)?.ingredients ?? []) {
        if (ingredient.amount > 0 && !visited.has(ingredient.id)) {
          queue.push({ productId: ingredient.id, depth: entry.depth + 1 });
        }
      }
    }
  }

  return [...recipes].sort((left, right) => {
    const leftDepth = depth.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightDepth = depth.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftDepth - rightDepth || left.id.localeCompare(right.id);
  });
}

function named(name: string | undefined, id: string): { name?: string } {
  return name === undefined || name === id ? {} : { name };
}

function availableRecipeIds(
  staticState: StaticState,
  forceId: string | undefined,
): Set<string> | undefined {
  const force =
    forceId === undefined
      ? staticState.forces[0]
      : staticState.forces.find(({ id }) => id === forceId);
  return force === undefined ? undefined : new Set(force.available_recipes);
}

/** Products whose display name or identifier appears verbatim in the question. */
function findMentionedProducts(
  question: string,
  producers: ReadonlyMap<string, readonly string[]>,
  names: LocalizedNameLookup,
): string[] {
  const haystack = question.toLowerCase();
  const candidates: Array<{ productId: string; needle: string }> = [];

  for (const productId of producers.keys()) {
    const identifier = productId.toLowerCase();
    if (
      identifier.length >= MIN_NAME_MATCH_LENGTH &&
      haystack.includes(identifier)
    ) {
      candidates.push({ productId, needle: identifier });
    }
  }

  for (const entry of names.entries()) {
    if (entry.kind !== "item" && entry.kind !== "fluid") {
      continue;
    }
    if (!producers.has(entry.id)) {
      continue;
    }
    const needle = entry.name.toLowerCase().trim();
    if (needle.length < MIN_NAME_MATCH_LENGTH || !haystack.includes(needle)) {
      continue;
    }
    candidates.push({ productId: entry.id, needle });
  }

  candidates.sort((left, right) => right.needle.length - left.needle.length);
  const matched: string[] = [];
  for (const candidate of candidates) {
    if (!matched.includes(candidate.productId)) {
      matched.push(candidate.productId);
    }
  }
  return matched;
}
