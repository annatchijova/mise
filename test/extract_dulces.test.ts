import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Dulces extraction preserves source text and leaves unstated amounts unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "dulces-extract-"));
  const source = join(dir, "book.txt");
  const text = [
    "Budín de pera",
    "ESPACIO PARA TU FOTO",
    "INGREDIENTES",
    "2 tazas de harina",
    "Azúcar a gusto",
    "\fBudín de pera — Procedimiento",
    "1  Mezclar los ingredientes.",
    "2  Hornear 30 min a 180°C.",
    "Molde 20 cm",
  ].join("\n");
  writeFileSync(source, text, "utf8");

  try {
    const output = execFileSync("python3", ["scripts/extract_dulces.py", source], { encoding: "utf8" });
    const [recipe] = JSON.parse(output);
    assert.equal(recipe.title_es, "Budín de pera");
    assert.equal(recipe.ingredient_groups[0].items[0].raw, "2 tazas de harina");
    assert.equal(recipe.ingredient_groups[0].items[0].qty, 2);
    assert.equal(recipe.ingredient_groups[0].items[1].raw, "Azúcar a gusto");
    assert.equal(recipe.ingredient_groups[0].items[1].qty, null);
    assert.equal(recipe.ingredient_groups[0].items[1].qty_source, "unspecified");
    assert.deepEqual(recipe.steps.map((step: { text_es: string }) => step.text_es), [
      "Mezclar los ingredientes.",
      "Hornear 30 min a 180°C.",
    ]);
    assert.equal(recipe.review.needs_review, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
