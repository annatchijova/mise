// Export a Mise recipe as a page, import that page back with scripts/import_jsonld.py, and check
// what survived. This is the only test that holds the two halves of the portal integration to each
// other — the TypeScript that publishes and the Python that reads — and the only one that proves an
// import refuses to invent what a page cannot carry.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadRecipes } from "../src/recipes.ts";
import { renderRecipePage } from "../src/recipe_jsonld.ts";

const repo = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "mise-roundtrip-"));
after(() => rmSync(work, { recursive: true, force: true }));

const recipes = loadRecipes();

/** Chosen for their edge cases: fractions, unspecified quantities, to_taste, a long timed recipe. */
const SAMPLE = ["vegan-gnocchi", "tofu-scramble", "chia-pudding", "barbecue-tofu", "beer-bread", "sauerkraut"];

type Staged = {
  id: string;
  title: string;
  minutes: number | null;
  minutes_source: string;
  serves: number | null;
  ingredients: { id: null; raw: string; role: null; technique: null; qty: number | null; unit: string; qty_source: string }[];
  steps: { order: number; text: string }[];
  source: { kind: string; jsonld: string; jsonld_sha256: string };
  review: { needs_review: boolean; reasons: string[] };
};

function roundTrip(id: string): Staged {
  const recipe = recipes.find((r) => r.id === id);
  assert.ok(recipe, `${id} is not in data/recipes — fix the sample list, do not weaken the test`);
  const page = join(work, `${id}.html`);
  writeFileSync(page, renderRecipePage(recipe, { baseUrl: "https://example.test" }), "utf8");
  const out = execFileSync("python3", [join(repo, "scripts/import_jsonld.py"), page, "--id", id, "--stdout"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out) as Staged;
}

for (const id of SAMPLE) {
  test(`round trip: ${id} survives export and re-import`, () => {
    const original = recipes.find((r) => r.id === id)!;
    const staged = roundTrip(id);

    assert.equal(staged.title, original.title);
    assert.equal(staged.ingredients.length, original.ingredients.length, "no ingredient lost or invented");
    assert.equal(staged.steps.length, original.steps.length, "no step lost or invented");
    assert.deepEqual(staged.steps.map((s) => s.text), original.steps.map((s) => s.text));

    // What a page cannot carry, an import must not claim.
    assert.ok(staged.ingredients.every((i) => i.id === null), "ingredient ids stay unmapped");
    assert.ok(staged.ingredients.every((i) => i.role === null && i.technique === null), "roles stay unassigned");
    assert.equal(staged.review.needs_review, true);

    // A quantity the cookbook never gave must not reappear as a number on the way back in.
    original.ingredients.forEach((ing, i) => {
      if (ing.qty_source === "unspecified") {
        assert.equal(staged.ingredients[i].qty, null, `${id}: ${ing.id} gained a quantity it never had`);
        assert.equal(staged.ingredients[i].qty_source, "unspecified");
      }
    });

    if (original.minutes_source === "unspecified") {
      assert.equal(staged.minutes, null, "an omitted time cannot come back as a number");
    } else {
      assert.equal(staged.minutes, original.minutes, "a published time round-trips exactly");
    }
    if (original.serves_source === "unspecified") {
      assert.equal(staged.serves, null, "an omitted yield cannot come back as a number");
    }
  });
}

test("stated quantities round-trip as numbers, so the import is not merely refusing everything", () => {
  const original = recipes.find((r) => r.id === "vegan-gnocchi")!;
  const staged = roundTrip("vegan-gnocchi");
  const statedPairs = original.ingredients
    .map((ing, i) => [ing, staged.ingredients[i]] as const)
    .filter(([ing]) => ing.qty_source === "stated");
  assert.ok(statedPairs.length >= 3, "this recipe should carry several stated quantities");
  for (const [ing, imported] of statedPairs) {
    assert.equal(imported.qty_source, "stated", ing.id);
    assert.equal(imported.qty, ing.qty, `${ing.id} quantity changed in transit`);
  }
  assert.equal(staged.ingredients.find((i) => i.raw.startsWith("2 cups"))!.unit, "cup");
});

test("the staged provenance hash matches the block it claims to be a hash of", () => {
  const staged = roundTrip("tofu-scramble");
  assert.equal(staged.source.kind, "imported");
  const parsed = JSON.parse(staged.source.jsonld);
  assert.equal(parsed["@type"], "Recipe");
  const digest = execFileSync("python3", ["-c", "import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"], {
    input: staged.source.jsonld,
    encoding: "utf8",
  }).trim();
  assert.equal(digest, staged.source.jsonld_sha256);
});

test("a staged import passes the staging contract and would fail the curated one", () => {
  const staged = roundTrip("chia-pudding");
  const dir = join(work, "imports");
  execFileSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, "chia-pudding.json"), JSON.stringify(staged), "utf8");

  const ok = execFileSync("python3", [join(repo, "scripts/validate_recipes.py"), "--staging", dir], { encoding: "utf8" });
  assert.match(ok, /errors: 0/, ok);

  // The same file against the full contract must be rejected — otherwise "staging" means nothing.
  assert.throws(
    () => execFileSync("python3", [join(repo, "scripts/validate_recipes.py"), dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    /Command failed/,
    "an unreviewed import must not satisfy the curated recipe contract",
  );
});

test("a page with no Recipe JSON-LD is reported, not half-imported", () => {
  const page = join(work, "empty.html");
  writeFileSync(page, "<!doctype html><html><body><p>No structured data here.</p></body></html>", "utf8");
  assert.throws(
    () => execFileSync("python3", [join(repo, "scripts/import_jsonld.py"), page, "--stdout"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    /Command failed/,
  );
});
