// The export is a claim made to the outside world, so these tests are mostly about restraint:
// what the JSON-LD must NOT say when the cookbook did not say it.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Recipe } from "../src/recipes.ts";
import { loadRecipes } from "../src/recipes.ts";
import { esc, formatQty, ingredientLine, isoDuration, renderRecipePage, toJsonLd } from "../src/recipe_jsonld.ts";

const recipes = loadRecipes();

function base(): Recipe {
  return {
    id: "test-dish",
    title: "Test dish",
    title_es: "Plato de prueba",
    source: { book: "vegan-delicious", locator: "p. 1", original_text: "..." },
    category: "main",
    diet: { vegan: true, gluten_free: false, notes: [] },
    minutes: 30,
    minutes_source: "stated",
    serves: 4,
    serves_source: "stated",
    ingredients: [
      { id: "tofu", name_es: "tofu", note: null, role: "protein", technique: "fry", qty: 1, unit: "pc", qty_source: "stated" },
    ],
    steps: [
      { order: 1, text: "Fry the tofu.", text_es: "Freír el tofu.", dur_s: 600, dur_source: "stated", timer: true, depends_on: [] },
    ],
    review: { needs_review: false, reasons: [] },
  };
}

test("isoDuration renders schema.org durations", () => {
  assert.equal(isoDuration(600), "PT10M");
  assert.equal(isoDuration(5400), "PT1H30M");
  assert.equal(isoDuration(45), "PT45S");
  assert.equal(isoDuration(0), "PT0S");
});

test("formatQty prefers cooking fractions and never prints float noise", () => {
  assert.equal(formatQty(2), "2");
  assert.equal(formatQty(0.5), "1/2");
  assert.equal(formatQty(0.25), "1/4");
  assert.equal(formatQty(1.5), "1 1/2");
  assert.equal(formatQty(0.3), "0.3");
});

test("an unspecified serving count is left out rather than published as fact", () => {
  const stated = toJsonLd(base());
  assert.equal(stated.recipeYield, "4 servings");

  const unstated = base();
  unstated.serves_source = "unspecified";
  assert.equal("recipeYield" in toJsonLd(unstated), false);
});

test("an unspecified time is left out; an estimated one is published and flagged in mise:", () => {
  const estimated = base();
  estimated.minutes_source = "estimated";
  const ld = toJsonLd(estimated);
  assert.equal(ld.totalTime, "PT30M");
  assert.equal((ld["mise:provenance"] as Record<string, unknown>).minutes_source, "estimated");

  const unspecified = base();
  unspecified.minutes_source = "unspecified";
  assert.equal("totalTime" in toJsonLd(unspecified), false);
});

test("an ingredient with no stated quantity never acquires one", () => {
  const r = base();
  r.ingredients = [
    { id: "olive-oil", name_es: "aceite de oliva", note: "c/n", role: "fat", technique: "fry", qty: null, unit: "to_taste", qty_source: "unspecified" },
    { id: "onion", name_es: "cebolla", note: null, role: "aromatic", technique: "brown", qty: null, unit: "pc", qty_source: "unspecified" },
  ];
  const lines = toJsonLd(r).recipeIngredient as string[];
  assert.equal(lines[0], "olive oil, to taste (c/n)");
  assert.equal(lines[1], "onion");
  assert.ok(lines.every((l) => !/\d/.test(l.replace(/-\d+/g, ""))), "no digits appear where the book gave none");
});

test("quantities and units read as English, singular and plural", () => {
  const line = (over: Partial<Recipe["ingredients"][number]>) =>
    ingredientLine({ id: "flour-0000", name_es: "harina", note: null, role: "starch", technique: "bind-cold", qty: 2, unit: "cup", qty_source: "stated", ...over });
  assert.equal(line({}), "2 cups flour 0000");
  assert.equal(line({ qty: 1 }), "1 cup flour 0000");
  assert.equal(line({ id: "garlic", qty: 1, unit: "clove" }), "1 clove garlic");
  assert.equal(line({ id: "potato", qty: 3, unit: "pc" }), "3 potato");
  assert.equal(line({ id: "salt", qty: 0.5, unit: "tsp" }), "1/2 teaspoons salt");
});

test("performTime appears only for a duration the book actually stated", () => {
  const stated = toJsonLd(base()).recipeInstructions as Record<string, unknown>[];
  assert.equal(stated[0].performTime, "PT10M");

  const guessed = base();
  guessed.steps[0].dur_source = "estimated";
  const est = toJsonLd(guessed).recipeInstructions as Record<string, unknown>[];
  assert.equal("performTime" in est[0], false, "our estimate is not the author's timing");
  assert.equal((toJsonLd(guessed)["mise:provenance"] as any).steps[0].dur_source, "estimated");
});

test("the mise: block carries the chef's judgment schema.org cannot express", () => {
  const prov = toJsonLd(base())["mise:provenance"] as any;
  assert.equal(prov.ingredients[0].role, "protein");
  assert.equal(prov.ingredients[0].technique, "fry");
  assert.equal(prov.ingredients[0].name_es, "tofu");
  assert.equal(prov.steps[0].timer, true);
  assert.equal(prov.book, "vegan-delicious");
});

test("gluten-free is claimed only when the data says so", () => {
  assert.deepEqual(toJsonLd(base()).suitableForDiet, ["https://schema.org/VeganDiet"]);
  const gf = base();
  gf.diet.gluten_free = true;
  assert.deepEqual(toJsonLd(gf).suitableForDiet, ["https://schema.org/VeganDiet", "https://schema.org/GlutenFreeDiet"]);
});

test("the export is byte-stable for a given recipe", () => {
  assert.equal(JSON.stringify(toJsonLd(base())), JSON.stringify(toJsonLd(base())));
});

test("every recipe in data/ produces JSON-LD an importer can read", () => {
  assert.ok(recipes.length > 0, "no recipes loaded — the rest of this test would prove nothing");
  for (const r of recipes) {
    const ld = toJsonLd(r, { baseUrl: "https://example.test" }) as any;
    assert.equal(ld["@type"], "Recipe", r.id);
    assert.equal(ld.name, r.title, r.id);
    assert.equal(ld["@id"], `https://example.test/recipes/${r.id}`, r.id);
    assert.equal(ld.recipeIngredient.length, r.ingredients.length, r.id);
    assert.equal(ld.recipeInstructions.length, r.steps.length, r.id);
    assert.ok(ld.recipeIngredient.every((l: string) => l.trim().length > 0), r.id);
    assert.deepEqual(ld.recipeInstructions.map((s: any) => s.position), r.steps.map((s) => s.order), r.id);
    assert.ok(ld.suitableForDiet.includes("https://schema.org/VeganDiet"), r.id);
  }
});

test("the page embeds its JSON-LD and escapes anything that could break out of it", () => {
  const r = base();
  r.title = 'Tofu <script>alert("x")</script> & friends';
  const html = renderRecipePage(r, { baseUrl: "https://example.test" });
  assert.match(html, /<script type="application\/ld\+json">/);
  assert.ok(!html.includes("<script>alert"), "no raw tag survives into the document");
  assert.ok(!/<\/script>\s*alert/.test(html));
  assert.equal(esc('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");

  const ld = JSON.parse(html.split('<script type="application/ld+json">')[1].split("</script>")[0].replace(/\\u003c/g, "<"));
  assert.equal(ld.name, r.title, "the JSON-LD still carries the real title");
});

test("the page shows an estimate as an estimate", () => {
  // Scoped to the meta row: the footer legend explains the words, so a whole-page match would pass
  // even if the flag next to the value disappeared.
  const meta = (html: string) => html.split('<div class="meta">')[1].split("</div>")[0];
  const r = base();
  r.minutes_source = "estimated";
  r.serves_source = "unspecified";
  assert.match(meta(renderRecipePage(r)), /30 min <span class="flag">estimated<\/span>/);
  assert.match(meta(renderRecipePage(r)), /serves 4 <span class="flag">unspecified<\/span>/);
  assert.doesNotMatch(meta(renderRecipePage(base())), /class="flag"/, "nothing stated is flagged");
});
