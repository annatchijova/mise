// The review queue ranks curated rows by what it would cost if one were wrong, and it measures reach
// by walking the same lookup chains the server walks. That means it holds a second copy of those
// chains, in Python — and two copies of a rule are two rules that drift.
//
// So this is mostly one test: run the real TypeScript lookup over the real corpus, run the queue, and
// assert they credit exactly the same rows with exactly the same counts. If somebody changes the
// chain in `substitutionsFor` and not in the script, this fails, and the queue stops quietly ranking
// by a rule the server no longer uses.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { loadRecipes } from "../src/recipes.ts";
import { indexSubstitutions, loadSubstitutions, substitutionsFor } from "../src/substitutions.ts";

type QueueItem = {
  table: string;
  row: string;
  summary: string;
  note: string | null;
  score: number;
  because: { points: number; why: string }[];
};

function queue(table?: string): QueueItem[] {
  const args = ["scripts/review_queue.py", "--json", ...(table ? ["--table", table] : [])];
  return JSON.parse(execFileSync("python3", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

/** The row that actually answered, keyed the way the queue keys it. */
function keyFromMatch(id: string, role: string, technique: string, match: string): string {
  switch (match) {
    case "ingredient+role+technique": return `${id}|${role}|${technique}`;
    case "ingredient+role": return `${id}|${role}|*`;
    case "ingredient": return `${id}|*|*`;
    case "role+technique": return `*|${role}|${technique}`;
    default: return `*|${role}|*`;
  }
}

test("the queue's reach is the real lookup's, row for row and count for count", () => {
  const table = loadSubstitutions();
  const index = indexSubstitutions(table);
  const truth = new Map<string, number>();
  for (const r of loadRecipes()) {
    for (const i of r.ingredients) {
      if (!i.role || !i.technique) continue;
      const got = substitutionsFor(table, index, { ingredient: i.id, role: i.role, technique: i.technique });
      if (!got.length) continue;
      const key = keyFromMatch(i.id, i.role, i.technique, got[0].match);
      truth.set(key, (truth.get(key) ?? 0) + 1);
    }
  }

  const mine = new Map<string, number>();
  for (const item of queue("substitutions")) {
    for (const b of item.because) {
      const m = /^answers (\d+) ingredient line/.exec(b.why);
      if (!m || Number(m[1]) === 0) continue;
      const [rawIngredient, role, rawTechnique] = item.row.split(" · ");
      const ingredient = rawIngredient.startsWith("(any ") ? "*" : rawIngredient;
      const technique = rawTechnique === "any" ? "*" : rawTechnique;
      mine.set(`${ingredient}|${role}|${technique}`, Number(m[1]));
    }
  }

  assert.ok(truth.size > 50, "the corpus really does exercise the table");
  assert.deepEqual(
    [...mine.entries()].sort(),
    [...truth.entries()].sort(),
    "the script's copy of the lookup chain has drifted from the server's",
  );
});

test("and the guard says how much of the chain it can actually check", () => {
  // Worth being exact about, because it is easy to believe this guard is stronger than it is. It can
  // only catch drift at a level the corpus reaches. The table currently has no ingredient-only rows
  // at all, so deleting that level from the script's chain changes nothing and this would not
  // notice — verified by trying it. If a level ever gains rows, this figure moves and the guard
  // silently gets stronger; if somebody removes the last row of a level, it gets weaker and says so.
  const table = loadSubstitutions();
  const index = indexSubstitutions(table);
  const levels = new Set<string>();
  for (const r of loadRecipes()) {
    for (const i of r.ingredients) {
      if (!i.role || !i.technique) continue;
      const got = substitutionsFor(table, index, { ingredient: i.id, role: i.role, technique: i.technique });
      if (got.length) levels.add(got[0].match);
    }
  }
  assert.deepEqual(
    [...levels].sort(),
    ["ingredient+role+technique", "role", "role+technique"],
    "the levels the corpus exercises, and so the only ones the drift guard above can check",
  );
});

test("every point in a score says what produced it", () => {
  // A ranking nobody can argue with row by row is an opinion with a number on it.
  for (const item of queue()) {
    assert.equal(item.score, item.because.reduce((n, b) => n + b.points, 0), `${item.row} does not add up`);
    for (const b of item.because) {
      assert.ok(b.why.length > 10, `${item.row} has a point with no reason: ${JSON.stringify(b)}`);
    }
  }
});

test("a row nothing reaches scores nothing, and says that rather than saying nothing", () => {
  // The zero is the point. A row ranked last with no explanation looks like an oversight; a row
  // ranked last because nothing in the corpus reaches it is a finding, and it is the one a curator
  // most needs before spending a Saturday on it.
  const unread = queue().filter((i) => i.score === 0);
  assert.ok(unread.length > 0, "some rows really are unused, and pretending otherwise helps nobody");
  for (const i of unread) {
    assert.ok(i.because.length > 0, `${i.row} scores nothing and does not say why`);
    assert.ok(i.because.every((b) => b.points === 0));
  }
});

test("a safety row outranks everything, and carries the reason it is one", () => {
  // docs/BLOCKED.md §H.1 names the garlic-oil row by hand. The queue must not bury it under a row
  // that is merely popular, and the flag must be curated rather than sniffed out of a note.
  const all = queue();
  const top = all[0];
  assert.match(top.row, /garlic-oil/);
  const care = top.because.find((b) => /safety matter/.test(b.why));
  assert.ok(care, "the top row is top for a stated reason");
  assert.ok(care.points >= 100, "and by a distance, so popularity cannot overtake it");
  assert.match(care.why, /botulism/, "the reason is the row's own, not the script's");
});

test("the queue ranks by what being wrong would cost, never by how likely it is", () => {
  // The distinction the whole script rests on. "Wrong here has no fallback" is a statement about
  // cost and is welcome; "this row looks doubtful" would be the model grading somebody's judgment,
  // which is not a thing it can do. Curated text the script quotes is data and is not policed —
  // only the script's own words are.
  for (const item of queue()) {
    for (const b of item.because) {
      const own = b.why.split(": ")[0];
      assert.doesNotMatch(own, /likely|probably|unlikely|suspicious|doubtful|questionable|confidence|accurate/i,
        `${item.row}: a reason that grades correctness rather than cost — ${b.why}`);
    }
  }
});
