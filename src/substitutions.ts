// Substitutions: a table somebody wrote, not a model that guesses.
//
// The whole argument of this file is negative. Alexa+ is a capable cook in the abstract and will
// happily invent a swap; what it cannot do is know that aquafaba stops binding the moment it warms,
// or that red lentils turn a stew into a purée in twenty minutes. So the server never asks it to:
// `substitute` is an exact lookup in data/substitutions.json, and everything it returns — the ratio,
// what changes, what breaks — was written by a cook and versioned as data.
//
// The lookup key is (ingredient, role, technique), because "what can I use instead of oil" has no
// answer until you know what the oil was doing. Frying, emulsifying and baking take different
// answers from the same row of the pantry. The fallback chain widens the question one step at a
// time and reports how specific the answer it found actually is, so the narrator can say
// "for frying, specifically" or "generally, for a fat" rather than implying more than was found.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "./recipes.ts";

/** [numerator, denominator]: numerator parts of the alternative for denominator parts of the
 *  original. Integers, never floats — a ratio is a proportion, and 2/3 is not 0.6666666666666666.
 *  null when the swap is not proportional at all (a tablespoon of onion flakes for a whole onion),
 *  in which case the amount lives in the note, stated in words. */
export type Ratio = readonly [number, number] | null;

export type Alternative = {
  ingredient: string;
  ratio: Ratio;
  /** What it does and how to use it. Always present. */
  note: string;
  /** What goes wrong, or null when nothing does. Never a hedge — only real failure modes. */
  warning: string | null;
};

export type SubstitutionEntry = {
  /** null on a role-level entry: the general answer for "a fat, for frying". */
  ingredient: string | null;
  role: string;
  technique: string | null;
  alternatives: Alternative[];
  /** What to do when none of the alternatives is at hand. An empty `alternatives` plus this is a
   *  complete answer — "leave the bay leaf out" is the right advice, not a missing row. */
  if_missing: string;
};

/** The vocabularies the recipe data contract uses (docs/RECIPE_SCHEMA.md). Repeated here so the
 *  tool's input schema and the table's validator draw on the same list. */
export const ROLES = [
  "protein", "fat", "acid", "binder", "umami", "aromatic", "vegetable", "fruit", "grain",
  "starch", "sweetener", "liquid", "leavening", "spice", "herb", "garnish", "thickener",
] as const;

export const TECHNIQUES = [
  "emulsify", "brown", "bind-cold", "bind-hot", "leaven", "thicken", "ferment", "marinate",
  "simmer", "fry", "bake", "raw", "whip", "sweeten", "season", "dissolve", "none",
] as const;

export type Role = (typeof ROLES)[number];
export type Technique = (typeof TECHNIQUES)[number];

export type SubstitutionTable = {
  version: number;
  updated_on: string;
  author: string;
  /** Ingredients the table names that no recipe uses yet, with a display name. */
  extra_ingredients: Record<string, string>;
  entries: SubstitutionEntry[];
};

/** How specific the answer is. The narrator should qualify a wider match, not present it as an
 *  answer about this ingredient in this dish. */
export type MatchLevel = "ingredient+role+technique" | "ingredient+role" | "ingredient" | "role+technique" | "role";

export type SubstitutionContext = {
  ingredient: string;
  role: string;
  technique: string | null;
  match: MatchLevel;
  alternatives: Alternative[];
  if_missing: string;
};

export function substitutionsFile(): string {
  return process.env.SUBSTITUTIONS_FILE ?? join(dataDir(), "substitutions.json");
}

export function loadSubstitutions(file: string = substitutionsFile()): SubstitutionTable {
  const raw = JSON.parse(readFileSync(file, "utf8")) as SubstitutionTable;
  // Sorted here rather than trusted from the file: two tables with the same rows in a different
  // order must answer identically, or the "same input, same answer" claim is only about one file.
  const entries = [...raw.entries].sort(
    (a, b) =>
      (a.ingredient ?? "").localeCompare(b.ingredient ?? "") ||
      a.role.localeCompare(b.role) ||
      (a.technique ?? "").localeCompare(b.technique ?? ""),
  );
  return { ...raw, entries };
}

function keyOf(ingredient: string | null, role: string | null, technique: string | null): string {
  return `${ingredient ?? "*"}|${role ?? "*"}|${technique ?? "*"}`;
}

export type Index = Map<string, SubstitutionEntry>;

export function indexSubstitutions(table: SubstitutionTable): Index {
  const index: Index = new Map();
  for (const e of table.entries) index.set(keyOf(e.ingredient, e.role, e.technique), e);
  return index;
}

export type Query = {
  ingredient: string;
  /** What the ingredient was doing. Without it the answer cannot be narrowed to one context. */
  role?: string | null;
  technique?: string | null;
};

function contextOf(entry: SubstitutionEntry, ingredient: string, match: MatchLevel): SubstitutionContext {
  return {
    ingredient,
    role: entry.role,
    technique: entry.technique,
    match,
    alternatives: entry.alternatives,
    if_missing: entry.if_missing,
  };
}

/**
 * Answer for one ingredient, as one context per way the ingredient is used.
 *
 * With a role and a technique the chain runs exact → (ingredient, role) → (ingredient) →
 * (role, technique) → (role), and the first hit wins: one context, honestly labelled.
 *
 * Without them the question is genuinely ambiguous — "instead of oil" has one answer for frying and
 * another for a mayonnaise — so every context the table holds for that ingredient comes back, in a
 * stable order, and the narrator can offer the one that fits what the person is doing. An empty
 * result means the table says nothing about this ingredient: that is an answer too, and the caller
 * says so rather than inventing one.
 */
export function substitutionsFor(table: SubstitutionTable, index: Index, q: Query): SubstitutionContext[] {
  const ingredient = q.ingredient;
  const role = q.role ?? null;
  const technique = q.technique ?? null;

  if (role !== null && technique !== null) {
    const chain: [string, MatchLevel][] = [
      [keyOf(ingredient, role, technique), "ingredient+role+technique"],
      [keyOf(ingredient, role, null), "ingredient+role"],
      [keyOf(ingredient, null, null), "ingredient"],
      [keyOf(null, role, technique), "role+technique"],
      [keyOf(null, role, null), "role"],
    ];
    for (const [key, match] of chain) {
      const hit = index.get(key);
      if (hit) return [contextOf(hit, ingredient, match)];
    }
    return [];
  }

  if (role !== null) {
    const forRole = table.entries.filter((e) => e.ingredient === ingredient && e.role === role);
    if (forRole.length > 0) return forRole.map((e) => contextOf(e, ingredient, e.technique === null ? "ingredient+role" : "ingredient+role+technique"));
    const general = table.entries.filter((e) => e.ingredient === null && e.role === role);
    return general.map((e) => contextOf(e, ingredient, e.technique === null ? "role" : "role+technique"));
  }

  // Nothing but a name. Every context the table has for it, so the narrator can pick.
  return table.entries
    .filter((e) => e.ingredient === ingredient)
    .map((e) => contextOf(e, ingredient, e.technique === null ? "ingredient+role" : "ingredient+role+technique"));
}

/** A ratio in words, for the narrator. Integers in, plain English out. */
export function ratioText(ratio: Ratio): string {
  if (ratio === null) return "no simple ratio";
  const [num, den] = ratio;
  if (num === den) return "one for one";
  if (den === 1) return `${num} times as much`;
  if (num === 1 && den === 2) return "half as much";
  if (num === 1) return `a ${ordinal(den)} as much`;
  return `${num} parts for every ${den}`;
}

function ordinal(n: number): string {
  const names: Record<number, string> = { 3: "third", 4: "quarter", 5: "fifth", 6: "sixth", 8: "eighth" };
  return names[n] ?? `1/${n}`;
}

/** Every ingredient id the table can name, for the resolver: an id nobody cooks with yet is still
 *  something a person can be out of. */
export function substitutionIds(table: SubstitutionTable): string[] {
  const ids = new Set<string>(Object.keys(table.extra_ingredients));
  for (const e of table.entries) {
    if (e.ingredient !== null) ids.add(e.ingredient);
    for (const a of e.alternatives) ids.add(a.ingredient);
  }
  return [...ids].sort();
}

/** How the table names an ingredient: the display name for anything outside the recipe corpus,
 *  the id spelled out otherwise. */
export function nameOf(table: SubstitutionTable, id: string): string {
  return table.extra_ingredients[id] ?? id.replace(/-/g, " ");
}
