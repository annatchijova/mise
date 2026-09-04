// schema.org/Recipe JSON-LD: how a Mise recipe leaves the building.
//
// This is the whole "recipe portal integration". Samsung Food, Family Hub, Paprika, Google and
// most recipe apps import a URL by reading its JSON-LD; none of them offers a public write API.
// So interoperability is a rendering problem, not an API problem.
//
// One rule governs every field, from docs/RECIPE_SCHEMA.md: a value must never look more certain
// than its source. schema.org has no provenance vocabulary, so we encode provenance by omission:
//
//   stated       -> emit the field plainly (the book says so)
//   estimated    -> emit it, and mark it as an estimate in the HTML and in mise:provenance
//   unspecified  -> omit the field entirely (the book said nothing; we will not tell Google a
//                   serving count the author never gave)
//
// The mise: block carries what schema.org cannot express — role, technique and every *_source
// flag — so another Mise instance can round-trip a recipe without losing the chef's judgment,
// while consumers that do not understand the namespace simply ignore it.
import type { Ingredient, Recipe, Step } from "./recipes.ts";

export const MISE_NS = "https://github.com/annatchijova/mise/ns#";

/** Integer-safe decimal formatting: 2 -> "2", 0.5 -> "1/2", 1.25 -> "1.25". No locale, no floats printed raw. */
export function formatQty(qty: number): string {
  if (Number.isInteger(qty)) return String(qty);
  const eighths = Math.round(qty * 8);
  if (Math.abs(eighths / 8 - qty) < 1e-9) {
    const whole = Math.floor(eighths / 8);
    const rem = eighths - whole * 8;
    const frac: Record<number, string> = { 1: "1/8", 2: "1/4", 3: "3/8", 4: "1/2", 5: "5/8", 6: "3/4", 7: "7/8" };
    if (rem !== 0) return whole === 0 ? frac[rem] : `${whole} ${frac[rem]}`;
  }
  return String(qty);
}

const UNIT_WORD: Record<string, [string, string]> = {
  g: ["g", "g"], kg: ["kg", "kg"], ml: ["ml", "ml"], l: ["l", "l"],
  tsp: ["teaspoon", "teaspoons"], tbsp: ["tablespoon", "tablespoons"], cup: ["cup", "cups"],
  pc: ["", ""], clove: ["clove", "cloves"], pinch: ["pinch", "pinches"], slice: ["slice", "slices"],
  bunch: ["bunch", "bunches"], can: ["can", "cans"], sachet: ["sachet", "sachets"], to_taste: ["", ""],
};

/** Canonical id to a readable English name: "flour-0000" -> "flour 0000". */
export function displayName(id: string): string {
  return id.replace(/-/g, " ");
}

/** One schema.org recipeIngredient line. Never invents a quantity: an unspecified qty yields the
 *  bare ingredient, with the book's own wording ("a gusto", "cantidad necesaria") kept as a note. */
export function ingredientLine(ing: Ingredient): string {
  const name = displayName(ing.id);
  const note = ing.note ? ` (${ing.note})` : "";
  if (ing.qty === null || ing.qty_source === "unspecified") {
    return ing.unit === "to_taste" ? `${name}, to taste${note}` : `${name}${note}`;
  }
  const [one, many] = UNIT_WORD[ing.unit] ?? [ing.unit, ing.unit];
  const word = ing.qty === 1 ? one : many;
  return [formatQty(ing.qty), word, name].filter(Boolean).join(" ") + note;
}

/** Seconds to an ISO 8601 duration. 600 -> "PT10M", 5400 -> "PT1H30M". */
export function isoDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const body = `${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;
  return `PT${body || "0S"}`;
}

type JsonLd = Record<string, unknown>;

/** A Mise recipe as schema.org/Recipe JSON-LD, plus a mise: provenance block. Deterministic:
 *  fields are built in a fixed order, so the serialized output is byte-stable for a given recipe. */
export function toJsonLd(r: Recipe, opts: { baseUrl?: string } = {}): JsonLd {
  const diets = ["https://schema.org/VeganDiet"];
  if (r.diet?.gluten_free) diets.push("https://schema.org/GlutenFreeDiet");

  const doc: JsonLd = {
    "@context": ["https://schema.org", { mise: MISE_NS }],
    "@type": "Recipe",
  };
  if (opts.baseUrl) doc["@id"] = `${opts.baseUrl.replace(/\/$/, "")}/recipes/${r.id}`;
  doc.identifier = r.id;
  doc.name = r.title;
  if (r.title_es && r.title_es !== r.title) doc.alternateName = r.title_es;
  doc.inLanguage = "en";
  doc.recipeCategory = r.category;
  doc.suitableForDiet = diets;
  if (r.tags?.length) doc.keywords = r.tags.join(", ");
  // stated or estimated: emit. unspecified: omit — see the rule at the top of this file.
  if (r.minutes_source !== "unspecified") doc.totalTime = isoDuration(r.minutes * 60);
  if (r.serves_source !== "unspecified") doc.recipeYield = `${r.serves} servings`;
  doc.recipeIngredient = r.ingredients.map(ingredientLine);
  doc.recipeInstructions = r.steps.map((s: Step) => {
    const step: JsonLd = { "@type": "HowToStep", position: s.order, text: s.text };
    // performTime only when the book actually stated the duration; our estimates stay in mise:.
    if (s.dur_source === "stated") step.performTime = isoDuration(s.dur_s);
    return step;
  });
  doc[`${"mise"}:provenance`] = {
    source_kind: "book",
    book: r.source?.book ?? null,
    locator: r.source?.locator ?? null,
    minutes_source: r.minutes_source,
    serves_source: r.serves_source,
    needs_review: r.review?.needs_review === true,
    review_reasons: r.review?.reasons ?? [],
    diet_notes: r.diet?.notes ?? [],
    ingredients: r.ingredients.map((i) => ({
      id: i.id, name_es: i.name_es, role: i.role, technique: i.technique,
      qty: i.qty, unit: i.unit, qty_source: i.qty_source, note: i.note,
    })),
    steps: r.steps.map((s) => ({
      order: s.order, dur_s: s.dur_s, dur_source: s.dur_source, timer: s.timer, depends_on: s.depends_on ?? [],
    })),
  };
  return doc;
}

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

const PAGE_CSS = `:root{color-scheme:light dark;--fg:#1a1a1a;--dim:#6b6b6b;--line:#e3e0da;--bg:#faf9f7;--flag:#8a6d3b;--flagbg:#fdf6e3}
@media(prefers-color-scheme:dark){:root{--fg:#e8e6e3;--dim:#9a968f;--line:#33312e;--bg:#171614;--flag:#d3b678;--flagbg:#2a2418}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-serif,Georgia,serif}
main{max-width:38rem;margin:0 auto;padding:3rem 1.25rem 5rem}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 .25rem}
.alt{color:var(--dim);font-style:italic;margin:0 0 1.5rem}
.meta{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;padding:.75rem 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);
 font:600 .78rem/1.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
h2{font:600 .8rem/1.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:2.5rem 0 .75rem}
ul,ol{padding-left:1.3rem;margin:0}li{margin:.4rem 0}
.flag{display:inline-block;font:600 .68rem/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;
 color:var(--flag);background:var(--flagbg);border-radius:3px;padding:.2rem .35rem;vertical-align:.05em}
footer{margin-top:3.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--dim);font:.82rem/1.6 ui-sans-serif,system-ui,sans-serif}
footer p{margin:.4rem 0}a{color:inherit}
.index{list-style:none;padding:0}.index li{margin:.15rem 0}.index a{text-decoration:none;border-bottom:1px solid var(--line)}
.index span{color:var(--dim);font:.8rem ui-sans-serif,system-ui,sans-serif}`;

function flag(source: string): string {
  return source === "stated" ? "" : ` <span class="flag">${esc(source)}</span>`;
}

/** The importable page: readable HTML whose JSON-LD is the actual payload. Every estimated or
 *  unspecified value is visibly flagged, so a human reading the page sees exactly what a machine
 *  reading the mise: block sees. */
export function renderRecipePage(r: Recipe, opts: { baseUrl?: string } = {}): string {
  const ld = JSON.stringify(toJsonLd(r, opts), null, 2).replace(/</g, "\\u003c");
  const meta: string[] = [];
  meta.push(esc(r.category));
  meta.push(`${r.minutes} min${r.minutes_source === "unspecified" ? " (not stated)" : ""}${flag(r.minutes_source)}`);
  meta.push(`serves ${r.serves}${flag(r.serves_source)}`);
  meta.push("vegan");
  if (r.diet?.gluten_free) meta.push("gluten free");

  const ingredients = r.ingredients
    .map((i) => `<li>${esc(ingredientLine(i))}${flag(i.qty_source)} <span class="flag" style="background:none;color:var(--dim)">${esc(i.role)} · ${esc(i.technique)}</span></li>`)
    .join("\n");
  const steps = r.steps
    .map((s) => `<li>${esc(s.text)}${s.timer ? ` <span class="flag">timer ${Math.round(s.dur_s / 60)} min</span>` : ""}${flag(s.dur_source)}</li>`)
    .join("\n");
  const notes = (r.diet?.notes ?? []).map((n) => `<p>${esc(n)}</p>`).join("\n");
  const reasons = r.review?.needs_review
    ? `<p><strong>Needs review:</strong> ${esc((r.review.reasons ?? []).join("; "))}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.title)} — Mise</title>
<style>${PAGE_CSS}</style>
<script type="application/ld+json">
${ld}
</script>
</head>
<body>
<main>
<h1>${esc(r.title)}</h1>
${r.title_es && r.title_es !== r.title ? `<p class="alt">${esc(r.title_es)}</p>` : ""}
<div class="meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
<h2>Ingredients</h2>
<ul>
${ingredients}
</ul>
<h2>Method</h2>
<ol>
${steps}
</ol>
<footer>
${notes}
${reasons}
<p>A flagged value is not the book's: <span class="flag">estimated</span> is our reading of the text,
<span class="flag">unspecified</span> means the source gave none and the field is left out of the structured data.</p>
<p>Structured as schema.org/Recipe with a <code>mise:</code> provenance block. Import this URL into any recipe app that reads JSON-LD.</p>
</footer>
</main>
</body>
</html>
`;
}

export function renderIndexPage(recipes: Recipe[]): string {
  const items = recipes
    .map((r) => `<li><a href="/recipes/${esc(r.id)}">${esc(r.title)}</a> <span>${esc(r.category)} · ${r.minutes} min</span></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recipes — Mise</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
<h1>Recipes</h1>
<p class="alt">${recipes.length} vegan recipes, each importable by URL into any app that reads schema.org JSON-LD.</p>
<ul class="index">
${items}
</ul>
</main>
</body>
</html>
`;
}
