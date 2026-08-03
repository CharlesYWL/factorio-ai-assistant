import {
  MAX_HIGHLIGHT_MARKERS,
  MAX_MARKER_TEXT_LENGTH,
  type AreaSnapshotPacket,
  type HighlightMarker,
  type SearchFilter,
  type SearchResponsePacket,
} from "@factorio-ai-assistant/protocol";

import type { LocalizedNameLookup } from "./localization.js";
import type { StaticState } from "./state-store.js";

/** Guards against a vague query pulling the whole catalog back into the prompt. */
const MAX_SEARCH_RESULTS = 12;
/** Enough for a full production chain, without letting one call undo the saving. */
const MAX_RECIPE_LOOKUPS = 16;
/** Shortest query allowed, so a stray character does not match everything. */
const MIN_QUERY_LENGTH = 2;

/**
 * A recipe in compact form: ingredients and products as `[id, amount]` pairs
 * rather than verbose objects, which keeps a looked-up chain small.
 */
export interface ToolRecipe {
  /** `[recipe_id, crafting_seconds, category]`. */
  r: [string, number, string];
  i: Array<[string, number]>;
  o: Array<[string, number]>;
  /** Display names for every id above, so the model can echo player wording. */
  names: Record<string, string>;
}

export interface CatalogEntry {
  id: string;
  /** In-game display name, omitted when it equals the identifier. */
  name?: string;
}

export interface ToolMachine {
  id: string;
  name?: string;
  speed: number;
  categories: string[];
}

/**
 * What the model sees up front: every craftable recipe by identifier and display
 * name, plus the machines that can run them.
 *
 * Ingredients and products are deliberately absent. The full catalog with
 * ingredients costs roughly 32 KB on a vanilla-sized save — 87% of the whole
 * context budget — while the names alone are a small fraction of that. The model
 * still sees the complete list, so it can map a nickname such as 黄瓶 onto this
 * save's actual item, then call `get_recipe` for the few it needs.
 */
export interface RecipeCatalog {
  format: string;
  recipes: CatalogEntry[];
  machines: ToolMachine[];
  truncated: boolean;
}

export function buildRecipeCatalog(
  staticState: StaticState | undefined,
  names: LocalizedNameLookup,
  forceId?: string,
): RecipeCatalog | undefined {
  const recipes = craftableRecipes(staticState, forceId);
  if (staticState === undefined || recipes.length === 0) {
    return undefined;
  }

  return {
    format:
      "recipes lists every recipe this force can craft, as id and in-game name. " +
      "Ingredients, products and crafting time are NOT included here: call " +
      "get_recipe for the ones you need. Match the player's wording, including " +
      "nicknames, against these names. A machine can run a recipe when its " +
      "categories include that recipe's category.",
    recipes: recipes
      .map((recipe) => ({
        id: recipe.id,
        ...named(names.lookup("recipe", recipe.id), recipe.id),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    machines: staticState.machines
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((machine) => ({
        id: machine.id,
        ...named(names.lookup("machine", machine.id), machine.id),
        speed: machine.crafting_speed,
        categories: machine.crafting_categories,
      })),
    truncated: false,
  };
}

/** Trims the catalog when even the name list will not fit. */
export function shrinkRecipeCatalog(
  value: RecipeCatalog,
): RecipeCatalog | undefined {
  if (value.recipes.length <= 1) {
    return undefined;
  }
  return {
    ...value,
    recipes: value.recipes.slice(0, value.recipes.length >> 1),
    truncated: true,
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const RECIPE_TOOLS: readonly ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_recipe",
      description:
        "Return ingredients, products and crafting time for recipes, by " +
        "identifier. Use the identifiers listed in the catalog. Ask for every " +
        "recipe in the chain at once rather than one call per step.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: `Recipe identifiers, at most ${MAX_RECIPE_LOOKUPS}.`,
          },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_recipes",
      description:
        "Find recipes whose identifier or in-game display name contains the " +
        "query. Use this when the player's wording does not match a catalog " +
        "entry exactly, then call get_recipe for the match.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Substring to look for, e.g. 科研 or circuit.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "highlight_entities",
      description:
        "Draw markers in the player's world and on their map, so the answer " +
        "can point at a place instead of describing coordinates in prose. " +
        "Mark an existing machine with its `unit` from selected_area, or mark " +
        "a bare map position with `x` and `y` — the latter is how you propose " +
        "where to build something. Say in the answer that they are marked.",
      parameters: {
        type: "object",
        properties: {
          markers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                unit: {
                  type: "number",
                  description:
                    "An entity's `unit` value from selected_area. Use this " +
                    "for existing machines. Omit when marking a position.",
                },
                x: {
                  type: "number",
                  description: "Map x, when marking a position rather than an entity.",
                },
                y: {
                  type: "number",
                  description: "Map y, when marking a position rather than an entity.",
                },
                text: {
                  type: "string",
                  description: "Short label, e.g. 缺石油气 or 建议在此开矿.",
                },
                severity: {
                  type: "string",
                  enum: ["problem", "warning", "info"],
                },
              },
              required: ["text", "severity"],
            },
            description: `At most ${MAX_HIGHLIGHT_MARKERS} markers.`,
          },
        },
        required: ["markers"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_machines",
      description:
        "Scan the whole map for machines matching a filter, grouped into the " +
        "production lines they form. Use this when the player asks where " +
        "something is built, or to find every machine in a given state. " +
        "Results carry a position and a `unit`, so you can then mark them. " +
        "Filters combine: leaving one out means it does not narrow anything.",
      parameters: {
        type: "object",
        properties: {
          recipe: {
            type: "string",
            description:
              "Recipe identifier the machine is set to, e.g. artillery-shell.",
          },
          status: {
            type: "string",
            description:
              "Factorio status name, e.g. no_ingredients, full_output, working.",
          },
          id: {
            type: "string",
            description: "Entity prototype name, e.g. electric-furnace.",
          },
          type: {
            type: "string",
            description:
              "Entity type, e.g. assembling-machine, furnace, mining-drill.",
          },
          has_modules: {
            type: "boolean",
            description:
              "true finds machines that have modules, false finds ones without.",
          },
        },
      },
    },
  },
];

export interface ToolContext {
  staticState: StaticState | undefined;
  names: LocalizedNameLookup;
  forceId?: string;
  /** The selection the question is about, needed to validate marker targets. */
  areaSelection?: AreaSnapshotPacket;
  /** Collects markers the model asked for, drained after the answer. */
  markers?: HighlightMarker[];
  /** Asks the Mod to scan the map; absent when the game is not connected. */
  search?: (
    forceId: string,
    filter: SearchFilter,
  ) => Promise<SearchResponsePacket | undefined>;
}

/**
 * Runs one tool call. Errors are returned as data rather than thrown: the model
 * has to see what went wrong to correct itself on the next turn.
 */
export async function executeRecipeTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments === "" ? "{}" : rawArguments);
  } catch {
    return { error: "arguments must be valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "arguments must be a JSON object" };
  }
  const args = parsed as Record<string, unknown>;

  if (name === "get_recipe") {
    return getRecipe(args, context);
  }
  if (name === "search_recipes") {
    return searchRecipes(args, context);
  }
  if (name === "highlight_entities") {
    return highlightEntities(args, context);
  }
  if (name === "find_machines") {
    return findMachines(args, context);
  }
  return { error: `unknown tool ${name}` };
}

/**
 * Asks the Mod to scan the map. Unlike the other tools this leaves the process:
 * the Companion only knows what the Mod has pushed, and where a machine sits is
 * not part of that.
 */
async function findMachines(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<unknown> {
  const search = context.search;
  if (search === undefined) {
    return {
      error: "The game is not connected, so the map cannot be scanned.",
    };
  }

  const filter: SearchFilter = {};
  const stringField = (key: "recipe" | "status" | "id" | "type"): void => {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      filter[key] = value.trim();
    }
  };
  stringField("recipe");
  stringField("status");
  stringField("id");
  stringField("type");
  if (typeof args["has_modules"] === "boolean") {
    filter.has_modules = args["has_modules"];
  }

  if (Object.keys(filter).length === 0) {
    return {
      error:
        "Give at least one filter: recipe, status, id, type or has_modules. " +
        "An unfiltered scan would return the whole factory.",
    };
  }

  const response = await search(context.forceId ?? "player", filter);
  if (response === undefined) {
    return { error: "The map scan did not come back in time." };
  }

  const { clusters, total_matches: total, truncated } = response.payload;
  if (clusters.length === 0) {
    return {
      matches: 0,
      hint:
        "Nothing matched. Check the recipe identifier against the catalog, " +
        "or widen the filter.",
    };
  }

  return {
    matches: total,
    truncated,
    lines: clusters.map((cluster) => ({
      at: [cluster.x, cluster.y],
      count: cluster.count,
      ids: cluster.ids,
      ...(cluster.statuses.length === 0 ? {} : { statuses: cluster.statuses }),
      ...(cluster.unit === undefined ? {} : { unit: cluster.unit }),
    })),
  };
}

/**
 * Records markers for the Mod to draw.
 *
 * A marker names either an entity (`unit`) or a map position (`x`/`y`). Unit
 * targets are checked against the current selection, because a model that
 * invents a unit number would produce markers pointing at nothing. Positions
 * cannot be validated that way and are taken at face value: that is what makes
 * "put a mining outpost here" or "add a pump here" expressible at all.
 */
function highlightEntities(
  args: Record<string, unknown>,
  context: ToolContext,
): unknown {
  const sink = context.markers;
  if (sink === undefined) {
    return { error: "Highlighting is not available for this request." };
  }

  const raw = args["markers"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "markers must be a non-empty array" };
  }

  const known = new Map(
    (context.areaSelection?.payload.entities ?? []).flatMap((entity) =>
      entity.unit === undefined ? [] : [[entity.unit, entity] as const],
    ),
  );

  const accepted: HighlightMarker[] = [];
  const unknownUnits: number[] = [];
  for (const entry of raw.slice(0, MAX_HIGHLIGHT_MARKERS)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const marker = entry as Record<string, unknown>;
    const text = marker["text"];
    const severity = marker["severity"];
    if (typeof text !== "string" || text.trim().length === 0) {
      continue;
    }
    if (
      severity !== "problem" &&
      severity !== "warning" &&
      severity !== "info"
    ) {
      continue;
    }

    const unit = marker["unit"];
    const x = marker["x"];
    const y = marker["y"];
    const label = text.slice(0, MAX_MARKER_TEXT_LENGTH);

    if (typeof unit === "number") {
      const entity = known.get(unit);
      if (entity === undefined) {
        unknownUnits.push(unit);
        continue;
      }
      accepted.push({
        unit,
        x: entity.x,
        y: entity.y,
        text: label,
        severity,
      });
      continue;
    }

    if (typeof x === "number" && typeof y === "number") {
      accepted.push({ x, y, text: label, severity });
    }
  }

  if (accepted.length === 0) {
    return {
      error:
        "No marker was usable. Give each one either a `unit` from " +
        "selected_area, or an `x` and `y` map position.",
      ...(unknownUnits.length === 0 ? {} : { unknown_units: unknownUnits }),
    };
  }

  // Later calls replace earlier ones, so a corrected set wins.
  sink.length = 0;
  sink.push(...accepted);

  return {
    marked: accepted.length,
    ...(unknownUnits.length === 0
      ? {}
      : {
          skipped_units: unknownUnits,
          hint: "Those unit numbers are not in the selection.",
        }),
  };
}

function getRecipe(
  args: Record<string, unknown>,
  context: ToolContext,
): unknown {
  const ids = args["ids"];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return { error: "ids must be an array of strings" };
  }
  if (ids.length === 0) {
    return { error: "ids must not be empty" };
  }

  const wanted = (ids as string[]).slice(0, MAX_RECIPE_LOOKUPS);
  const available = craftableRecipes(context.staticState, context.forceId);
  const byId = new Map(available.map((recipe) => [recipe.id, recipe]));

  const found: ToolRecipe[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    const recipe = byId.get(id);
    if (recipe === undefined) {
      missing.push(id);
      continue;
    }
    found.push(compactRecipe(recipe, context.names));
  }

  return {
    recipes: found,
    ...(missing.length === 0
      ? {}
      : {
          not_found: missing,
          hint: "Not craftable by this force, or the identifier is wrong. Try search_recipes.",
        }),
    ...(ids.length > MAX_RECIPE_LOOKUPS
      ? { note: `Only the first ${MAX_RECIPE_LOOKUPS} ids were looked up.` }
      : {}),
  };
}

function searchRecipes(
  args: Record<string, unknown>,
  context: ToolContext,
): unknown {
  const query = args["query"];
  if (typeof query !== "string") {
    return { error: "query must be a string" };
  }
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY_LENGTH) {
    return { error: `query must be at least ${MIN_QUERY_LENGTH} characters` };
  }

  const recipes = craftableRecipes(context.staticState, context.forceId);
  const matches: CatalogEntry[] = [];
  for (const recipe of recipes) {
    const name = context.names.lookup("recipe", recipe.id);
    const matched =
      recipe.id.toLowerCase().includes(needle) ||
      (name !== undefined && name.toLowerCase().includes(needle));
    if (!matched) {
      continue;
    }
    matches.push({ id: recipe.id, ...named(name, recipe.id) });
    if (matches.length >= MAX_SEARCH_RESULTS) {
      break;
    }
  }

  return matches.length === 0
    ? {
        matches: [],
        hint: "Nothing matched. Try a shorter or more general query.",
      }
    : { matches };
}

function compactRecipe(
  recipe: StaticState["recipes"][number],
  names: LocalizedNameLookup,
): ToolRecipe {
  const displayNames: Record<string, string> = {};
  const add = (kind: "item" | "fluid" | "recipe", id: string): void => {
    if (id in displayNames) {
      return;
    }
    const name = names.lookup(kind, id);
    if (name !== undefined && name !== id) {
      displayNames[id] = name;
    }
  };

  add("recipe", recipe.id);
  for (const ingredient of recipe.ingredients) {
    add(ingredient.kind, ingredient.id);
  }
  for (const product of recipe.products) {
    add(product.kind, product.id);
  }

  return {
    r: [recipe.id, recipe.energy_seconds, recipe.category],
    i: recipe.ingredients.map(
      (ingredient) => [ingredient.id, ingredient.amount] as [string, number],
    ),
    o: recipe.products.map(
      (product) => [product.id, product.amount] as [string, number],
    ),
    names: displayNames,
  };
}

function craftableRecipes(
  staticState: StaticState | undefined,
  forceId: string | undefined,
): StaticState["recipes"] {
  if (staticState === undefined) {
    return [];
  }
  const force =
    forceId === undefined
      ? staticState.forces[0]
      : staticState.forces.find(({ id }) => id === forceId);
  if (force === undefined) {
    return staticState.recipes;
  }
  const available = new Set(force.available_recipes);
  return staticState.recipes.filter((recipe) => available.has(recipe.id));
}

function named(name: string | undefined, id: string): { name?: string } {
  return name === undefined || name === id ? {} : { name };
}
