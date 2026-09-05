// How long food keeps — and the one rule that makes it safe to say so.
//
// The pantry only ever learns a real expiry date when somebody states one: the person says "the tofu
// expires Friday", or a package carries a date. That is almost never, which leaves the planner's best
// pass — schedule what is about to go off, on the last day it is still good — with almost nothing to
// work on.
//
// This table fills that in, and the whole design is about what it must NOT do. An estimate is
// **derived, never stored**: no event ever carries a table's number, exactly as no event ever carries
// `stale`. The fold computes it at read time from the day the food entered the pantry, and every
// layer above carries `expiry_source` so that "you said Friday" and "the table says about four days"
// stay two different sentences all the way to what Alexa+ says out loud. The moment an estimate can
// be mistaken for a date somebody gave, the feature is worse than not having it.
//
// The lookup mirrors the substitution table: exact first, then wider, and the level it matched is
// part of the answer.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "../recipes.ts";

export type ShelfLifeEntry = {
  /** null on a role-level row: the general answer for "a vegetable, in the fridge". */
  ingredient: string | null;
  /** Only meaningful on a role-level row; null on an ingredient row and on the catch-all. */
  role?: string | null;
  /** null on the catch-all row that answers for any location. */
  location: string | null;
  days: number;
  note: string | null;
};

export type ShelfLifeTable = {
  version: number;
  updated_on: string;
  author: string;
  locations: string[];
  /** Things the table answers for that no recipe cooks with — `leftovers`, chiefly. */
  extra_ingredients?: Record<string, string>;
  entries: ShelfLifeEntry[];
};

/** A cooked dish in the pantry. `leftover-vegan-gnocchi` is a portion of something, not an
 *  ingredient, and the shelf-life table answers for all of them with one row. */
export const LEFTOVER_PREFIX = "leftover-";

export function isLeftover(ingredientId: string): boolean {
  return ingredientId.startsWith(LEFTOVER_PREFIX);
}

/** The recipe a leftover came from. */
export function recipeOfLeftover(ingredientId: string): string {
  return ingredientId.slice(LEFTOVER_PREFIX.length);
}

export type ShelfLifeMatch =
  | "ingredient+location"
  | "ingredient"
  | "role+location"
  | "role"
  | "location";

export type ShelfLifeAnswer = { days: number; note: string | null; match: ShelfLifeMatch };

/** Given an ingredient and where it is kept, how long it keeps — or nothing. */
export type ShelfLife = (ingredientId: string, location: string) => ShelfLifeAnswer | null;

export function shelfLifeFile(): string {
  return process.env.SHELF_LIFE_FILE ?? join(dataDir(), "shelf_life.json");
}

export function loadShelfLife(file: string = shelfLifeFile()): ShelfLifeTable {
  const raw = JSON.parse(readFileSync(file, "utf8")) as ShelfLifeTable;
  // Sorted so that two files with the same rows in a different order answer identically.
  const entries = [...raw.entries].sort(
    (a, b) =>
      (a.ingredient ?? "").localeCompare(b.ingredient ?? "") ||
      (a.role ?? "").localeCompare(b.role ?? "") ||
      (a.location ?? "").localeCompare(b.location ?? ""),
  );
  return { ...raw, entries };
}

function keyOf(ingredient: string | null, role: string | null, location: string | null): string {
  return `${ingredient ?? "*"}|${role ?? "*"}|${location ?? "*"}`;
}

/**
 * Build the lookup.
 *
 * `roleOf` comes from the recipe corpus — the role an ingredient plays most often — so the role-level
 * rows can answer for an ingredient nobody has written a row for. A location we do not recognise
 * ("other:the cabin") falls through to the ingredient's own any-location row and then to the
 * catch-all, which is the honest behaviour: we know how long a lemon keeps, we do not know how cold
 * the cabin is.
 */
export function buildShelfLife(table: ShelfLifeTable, roleOf: (id: string) => string | null): ShelfLife {
  const index = new Map<string, ShelfLifeEntry>();
  for (const e of table.entries) index.set(keyOf(e.ingredient, e.role ?? null, e.location), e);

  return (ingredientId: string, location: string): ShelfLifeAnswer | null => {
    // Every leftover keeps the same way, so they share one row rather than needing one each.
    const lookupId = isLeftover(ingredientId) ? "leftovers" : ingredientId;
    const role = roleOf(lookupId);
    const chain: [string, ShelfLifeMatch][] = [
      [keyOf(lookupId, null, location), "ingredient+location"],
      [keyOf(lookupId, null, null), "ingredient"],
      ...(role === null ? [] : ([
        [keyOf(null, role, location), "role+location"],
        [keyOf(null, role, null), "role"],
      ] as [string, ShelfLifeMatch][])),
      [keyOf(null, null, location), "location"],
    ];
    for (const [key, match] of chain) {
      const hit = index.get(key);
      if (hit) return { days: hit.days, note: hit.note, match };
    }
    return null;
  };
}

/** The role an ingredient plays most often across a corpus. Ties broken alphabetically, so the map
 *  is the same on every machine. */
export function rolesFromRecipes(recipes: { ingredients: { id: string; role: string }[] }[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const r of recipes) {
    for (const i of r.ingredients) {
      const byRole = counts.get(i.id) ?? new Map<string, number>();
      byRole.set(i.role, (byRole.get(i.role) ?? 0) + 1);
      counts.set(i.id, byRole);
    }
  }
  const out = new Map<string, string>();
  for (const [id, byRole] of counts) {
    const best = [...byRole.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.set(id, best[0]);
  }
  return out;
}
