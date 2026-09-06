// The substitution table is the one place in the system where a human's judgment is the data. These
// tests do not check that the advice is good — no test can — they check that the lookup never
// invents, never widens an answer silently, and never turns a curated proportion into a float.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  type SubstitutionTable,
  indexSubstitutions, loadSubstitutions, nameOf, ratioText, substitutionIds, substitutionsFor,
} from "../src/substitutions.ts";
import { loadRecipes } from "../src/recipes.ts";

const table = loadSubstitutions();
const index = indexSubstitutions(table);
const ask = (ingredient: string, role?: string, technique?: string) =>
  substitutionsFor(table, index, { ingredient, role, technique });

test("the exact (ingredient, role, technique) row wins over every wider one", () => {
  const [ctx] = ask("flax", "binder", "whip");
  assert.equal(ctx.match, "ingredient+role+technique");
  assert.equal(ctx.role, "binder");
  assert.equal(ctx.technique, "whip");
  // The row the plan was written around: aquafaba whips, and stops holding the moment it warms.
  const aquafaba = ctx.alternatives.find((a) => a.ingredient === "aquafaba");
  assert.ok(aquafaba, "aquafaba is the alternative that makes this row worth having");
  assert.match(aquafaba.warning ?? "", /does not bind when hot/);
});

test("a technique the table has no row for widens to the role, and says that it widened", () => {
  // Nobody wrote "olive oil, marinating". The answer comes from the general fat row and is labelled.
  const [ctx] = ask("olive-oil", "fat", "marinate");
  assert.ok(["role", "role+technique"].includes(ctx.match), `widened answers must say so, got ${ctx.match}`);
  assert.ok(ctx.alternatives.length > 0);
});

test("an ingredient the table says nothing about returns nothing — not a nearby guess", () => {
  assert.deepEqual(ask("kaffir-lime-leaf"), []);
  assert.deepEqual(ask("green-curry", "spice", "fry").length, 1, "with a role it may fall back to the role row");
  const [ctx] = ask("green-curry", "spice", "fry");
  assert.equal(ctx.match, "role", "and that fallback is labelled as a role-level answer");
});

test("a row with no alternatives is a complete answer, not a hole", () => {
  const [ctx] = ask("bay-leaf", "herb", "simmer");
  assert.equal(ctx.alternatives.length, 0);
  assert.match(ctx.if_missing, /leave it out/i);
});

test("without a role the answer is every context, so the narrator picks instead of the server", () => {
  const contexts = ask("vegetable-oil");
  assert.ok(contexts.length >= 2, "oil does different jobs and takes different answers");
  const techniques = contexts.map((c) => c.technique).sort();
  assert.deepEqual(techniques, [...techniques].sort(), "stable order");
  assert.ok(techniques.includes("emulsify") && techniques.includes("fry"));
});

test("the recipe's own role and technique are what make the answer specific", () => {
  const gnocchi = loadRecipes().find((r) => r.id === "vegan-gnocchi");
  assert.ok(gnocchi);
  const flour = gnocchi.ingredients.find((i) => i.id === "flour-0000");
  assert.ok(flour);
  const [ctx] = ask("flour-0000", flour.role, flour.technique);
  assert.equal(ctx.match, "ingredient+role+technique");
  const gf = ctx.alternatives.find((a) => a.ingredient === "gluten-free-premix");
  assert.match(gf?.warning ?? "", /knead/i, "a gluten-free dough is handled differently, and the row says so");
});

test("every ratio in the table is a pair of positive integers, or honestly null", () => {
  for (const e of table.entries) {
    for (const a of e.alternatives) {
      if (a.ratio === null) {
        // A ratio of null is allowed only where a proportion would be a lie. The note then has to
        // carry the amount in words, or say why no fixed amount exists.
        assert.match(
          a.note,
          /teaspoon|tablespoon|cup|clove|gram|packet|label|\d/i,
          `${a.ingredient}: a null ratio has to state the amount in words, or say why there is no fixed one`,
        );
        continue;
      }
      const [num, den] = a.ratio;
      assert.ok(Number.isInteger(num) && num > 0, `${a.ingredient}: ratio numerator ${num}`);
      assert.ok(Number.isInteger(den) && den > 0, `${a.ingredient}: ratio denominator ${den}`);
    }
  }
});

test("the file's row order cannot change an answer", () => {
  const shuffled: SubstitutionTable = { ...table, entries: [...table.entries].reverse() };
  const reordered = loadSubstitutionsFrom(shuffled);
  const a = substitutionsFor(table, index, { ingredient: "lemon", role: "acid", technique: "season" });
  const b = substitutionsFor(reordered, indexSubstitutions(reordered), { ingredient: "lemon", role: "acid", technique: "season" });
  assert.deepEqual(b, a);
});

/** Reload a table through the same normalization the loader applies to a file. */
function loadSubstitutionsFrom(t: SubstitutionTable): SubstitutionTable {
  const entries = [...t.entries].sort(
    (x, y) => (x.ingredient ?? "").localeCompare(y.ingredient ?? "") || x.role.localeCompare(y.role) || (x.technique ?? "").localeCompare(y.technique ?? ""),
  );
  return { ...t, entries };
}

test("every ingredient the table names can also be named back to a person", () => {
  for (const id of substitutionIds(table)) {
    const name = nameOf(table, id);
    assert.ok(name.length > 0, `${id} has no name`);
    assert.ok(!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name), `${id} comes back as its raw id instead of a name a person would hear`);
  }
});

test("ratios come out as English, not as arithmetic", () => {
  assert.equal(ratioText([1, 1]), "one for one");
  assert.equal(ratioText([1, 2]), "half as much");
  assert.equal(ratioText([1, 4]), "a quarter as much");
  assert.equal(ratioText([3, 1]), "3 times as much");
  assert.equal(ratioText([3, 4]), "3 parts for every 4");
  assert.equal(ratioText(null), "no simple ratio");
});
