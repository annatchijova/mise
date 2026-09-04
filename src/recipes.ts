// Recipe loading and search. Shapes follow docs/RECIPE_SCHEMA.md.
// Pure and deterministic: same files in, same order out.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Provenance = "stated" | "estimated" | "unspecified";

export type Ingredient = {
  id: string;
  name_es: string;
  note: string | null;
  role: string;
  technique: string;
  qty: number | null;
  unit: string;
  qty_source: Provenance;
};

export type Step = {
  order: number;
  text: string;
  text_es: string;
  dur_s: number;
  dur_source: Provenance;
  timer: boolean;
  depends_on: number[];
};

export type Recipe = {
  id: string;
  title: string;
  title_es: string;
  source: { book: string; locator: string; original_text: string; also_in?: unknown };
  category: string;
  diet: { vegan: boolean; gluten_free: boolean; notes: string[] };
  minutes: number;
  minutes_source: Provenance;
  serves: number;
  serves_source: Provenance;
  ingredients: Ingredient[];
  steps: Step[];
  tags?: string[];
  review: { needs_review?: boolean; reasons?: string[] };
};

/** The data directory. Resolved one level up from this module, which holds both for src/*.ts under
 *  the type-stripping test runner and for the esbuild bundle in dist/ — every data loader goes
 *  through here so the two never disagree. */
export function dataDir(): string {
  return process.env.DATA_DIR ?? join(fileURLToPath(new URL("..", import.meta.url)), "data");
}

export function recipesDir(): string {
  return process.env.RECIPES_DIR ?? join(dataDir(), "recipes");
}

/** Load every recipe file in the directory. Each *.json may hold one recipe or an array;
 *  anything without id+ingredients+steps (e.g. an inventory file) is ignored. Sorted by id. */
export function loadRecipes(dir: string = recipesDir()): Recipe[] {
  const out: Recipe[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
      if (r && typeof r.id === "string" && Array.isArray(r.ingredients) && Array.isArray(r.steps)) out.push(r as Recipe);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export type SearchInput = { query?: string; use_ingredients?: string[]; max_minutes?: number };

/** Deterministic recipe search: integer scoring, stable ordering, no floats. */
export function searchRecipes(recipes: Recipe[], input: SearchInput) {
  const q = (input.query ?? "").trim().toLowerCase();
  const wanted = (input.use_ingredients ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const candidates = recipes
    .filter((r) => input.max_minutes === undefined || r.minutes <= input.max_minutes)
    .filter((r) => q === "" || r.title.toLowerCase().includes(q) || r.ingredients.some((i) => i.id.includes(q)))
    .map((r) => {
      const have = wanted.filter((w) => r.ingredients.some((i) => i.id === w || i.id.includes(w))).length;
      // percent of the recipe's ingredients already on hand, as an integer
      const pct = r.ingredients.length === 0 ? 0 : Math.floor((have * 100) / r.ingredients.length);
      const missing = [...new Set(r.ingredients.filter((i) => !wanted.some((w) => i.id === w || i.id.includes(w))).map((i) => i.id))];
      return { id: r.id, title: r.title, category: r.category, minutes: r.minutes, serves: r.serves, have_pct: pct, missing };
    })
    .sort((a, b) => b.have_pct - a.have_pct || a.minutes - b.minutes || a.title.localeCompare(b.title));
  return { candidates, total: candidates.length };
}
