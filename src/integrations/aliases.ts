// Resolving an outside food name to a canonical ingredient id.
//
// A fridge says "Bell Peppers", a barcode database says "Organic Roma Tomatoes", the recipes say
// `bell-pepper` and `tomato`. The mapping is data (data/source_aliases.json) plus a small amount of
// mechanical normalization — never fuzzy matching. A name that does not resolve is reported as
// unmapped, because a wrong ingredient id silently rewrites the weekly plan.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "../recipes.ts";

/** Lowercase, strip accents, collapse every run of non-alphanumerics into one hyphen. */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Mechanical singulars, tried in order after an exact miss. Deliberately dull: "-ies" to "-y",
 *  "-oes"/"-es" to the stem, then a bare trailing "-s". Anything less obvious belongs in the table. */
function singulars(name: string): string[] {
  const out: string[] = [];
  if (name.endsWith("ies") && name.length > 4) out.push(`${name.slice(0, -3)}y`);
  if (name.endsWith("oes") && name.length > 4) out.push(name.slice(0, -2));
  if (name.endsWith("es") && name.length > 3) out.push(name.slice(0, -2));
  if (name.endsWith("s") && !name.endsWith("ss") && name.length > 2) out.push(name.slice(0, -1));
  return out;
}

export type Resolver = (rawName: string) => string | null;

/**
 * Build a resolver from the alias table and the ids the recipe corpus actually uses.
 *
 * Lookup order, first hit wins: the alias table, then the set of known canonical ids, then the same
 * two against each mechanical singular. `known` is what keeps the table small — `tofu` needs no
 * entry because a recipe already uses that id.
 */
export function buildResolver(aliases: Record<string, string>, known: Iterable<string>): Resolver {
  const table = new Map<string, string>();
  for (const [k, v] of Object.entries(aliases)) {
    if (k.startsWith("_")) continue; // "_comment" and friends
    table.set(normalizeName(k), v);
  }
  const ids = new Set(known);

  return (rawName: string): string | null => {
    const name = normalizeName(rawName);
    if (name === "") return null;
    for (const candidate of [name, ...singulars(name)]) {
      const aliased = table.get(candidate);
      if (aliased !== undefined) return aliased;
      if (ids.has(candidate)) return candidate;
    }
    return null;
  };
}

export function loadAliases(path?: string): Record<string, string> {
  const file = path ?? join(dataDir(), "source_aliases.json");
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}
