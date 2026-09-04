// The importer's quantity parser, exercised directly on the strings real recipe sites publish.
//
// The round-trip test cannot reach these cases: our own cookbooks never write "2-3 onions", so the
// ambiguous branches only ever run on imported text. Every case below asserts one of two things —
// a number the page plainly stated is read, or a number it did not plainly state stays null.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("../scripts/import_jsonld.py", import.meta.url).pathname;

type Parsed = { qty: number | null; unit: string; qty_source: string; note: string | null };

/** Call parse_ingredient for a batch of lines in one python process. */
function parse(lines: string[]): Parsed[] {
  const driver = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("imp", ${JSON.stringify(script)})`,
    "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
    "lines = json.load(sys.stdin)",
    "out = []",
    "for line in lines:",
    "    q, u, s, n = mod.parse_ingredient(line)",
    '    out.append({"qty": q, "unit": u, "qty_source": s, "note": n})',
    "json.dump(out, sys.stdout)",
  ].join("\n");
  const raw = execFileSync("python3", ["-c", driver], { input: JSON.stringify(lines), encoding: "utf8" });
  return JSON.parse(raw) as Parsed[];
}

test("a plainly stated quantity and unit are read", () => {
  const [cups, grams, tbsp, half, mixed, vulgar, mixedVulgar] = parse([
    "2 cups all-purpose flour",
    "250 g cherry tomatoes",
    "1 tablespoon olive oil",
    "1/2 teaspoon salt",
    "1 1/2 cups water",
    "\u00bd cup sugar",
    "1\u00bd cups oat milk",
  ]);
  assert.deepEqual([cups.qty, cups.unit, cups.qty_source], [2, "cup", "stated"]);
  assert.deepEqual([grams.qty, grams.unit], [250, "g"]);
  assert.deepEqual([tbsp.qty, tbsp.unit], [1, "tbsp"]);
  assert.deepEqual([half.qty, half.unit], [0.5, "tsp"]);
  assert.deepEqual([mixed.qty, mixed.unit], [1.5, "cup"]);
  assert.deepEqual([vulgar.qty, vulgar.unit], [0.5, "cup"], "sites publish vulgar fractions constantly");
  assert.deepEqual([mixedVulgar.qty, mixedVulgar.unit], [1.5, "cup"]);
});

test("a count with no unit is pieces, and the source line is kept", () => {
  const [onions] = parse(["3 onions, finely chopped"]);
  assert.deepEqual([onions.qty, onions.unit, onions.qty_source], [3, "pc", "stated"]);
});

test("a range is two numbers, so no number is taken", () => {
  for (const line of ["2-3 onions", "2 – 3 large onions", "1 to 2 cups water", "4-6 cloves garlic"]) {
    const [p] = parse([line]);
    assert.equal(p.qty, null, line);
    assert.equal(p.qty_source, "unspecified", line);
    assert.equal(p.note, line.replace(/–/g, "–"), "the site's own wording is what survives");
  }
});

test("text with no quantity at all stays unspecified rather than defaulting to one", () => {
  for (const line of ["Salt and pepper to taste", "A handful of parsley", "Olive oil, for frying", "Water as needed"]) {
    const [p] = parse([line]);
    assert.equal(p.qty, null, line);
    assert.equal(p.unit, "to_taste", line);
    assert.equal(p.note, line, line);
  }
});

test("an empty or whitespace line yields nothing, and does not throw", () => {
  const [empty, spaces] = parse(["", "   "]);
  assert.equal(empty.qty, null);
  assert.equal(spaces.qty, null);
});

test("a zero or absurd quantity is refused rather than stored", () => {
  const [zero, zeroFraction] = parse(["0 cups flour", "0/4 cup sugar"]);
  assert.equal(zero.qty, null);
  assert.equal(zeroFraction.qty, null);
});

test("a divide-by-zero fraction does not crash the import", () => {
  const [p] = parse(["1/0 cup sugar"]);
  assert.equal(p.qty, null);
  assert.equal(p.qty_source, "unspecified");
});

test("units outside the vocabulary do not silently become a known unit", () => {
  const [sticks, pkg] = parse(["2 sticks vegan butter", "1 bowl leftover pasta"]);
  // Unrecognized words are treated as part of the ingredient name, counted as pieces — never
  // mapped onto a unit we happen to have.
  assert.equal(sticks.unit, "pc");
  assert.equal(pkg.unit, "pc");
  assert.equal(sticks.qty, 2);
});

test("ISO 8601 durations are read only when the page states one", () => {
  const driver = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("imp", ${JSON.stringify(script)})`,
    "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
    'json.dump([mod.parse_duration_minutes(v) for v in json.load(sys.stdin)], sys.stdout)',
  ].join("\n");
  const out = JSON.parse(
    execFileSync("python3", ["-c", driver], {
      input: JSON.stringify(["PT30M", "PT1H30M", "P1DT2H", "PT0S", "", "half an hour", null]),
      encoding: "utf8",
    }),
  );
  assert.deepEqual(out, [30, 90, 1560, null, null, null, null]);
});

test("recipeYield is read from the shapes sites actually publish", () => {
  const driver = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("imp", ${JSON.stringify(script)})`,
    "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
    'json.dump([mod.parse_yield(v) for v in json.load(sys.stdin)], sys.stdout)',
  ].join("\n");
  const out = JSON.parse(
    execFileSync("python3", ["-c", driver], {
      input: JSON.stringify([4, "4", "4 servings", ["6 servings"], "serves a crowd", null, 0]),
      encoding: "utf8",
    }),
  );
  assert.deepEqual(out, [
    [4, "stated"], [4, "stated"], [4, "stated"], [6, "stated"],
    [null, "unspecified"], [null, "unspecified"], [null, "unspecified"],
  ]);
});

test("a step whose @type is a list does not crash the import", () => {
  const driver = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("imp", ${JSON.stringify(script)})`,
    "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
    'json.dump(mod.flatten_instructions(json.load(sys.stdin)), sys.stdout)',
  ].join("\n");
  const out = JSON.parse(execFileSync("python3", ["-c", driver], {
    input: JSON.stringify([
      { "@type": ["HowToStep"], text: "Boil" },
      { "@type": ["HowToSection"], itemListElement: [{ "@type": "HowToStep", text: "Drain" }, "Serve"] },
    ]),
    encoding: "utf8",
  }));
  assert.deepEqual(out, ["Boil", "Drain", "Serve"]);
});

test("a yield that is a range or several numbers is not one number, so none is taken", () => {
  const driver = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("imp", ${JSON.stringify(script)})`,
    "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
    'json.dump([mod.parse_yield(v) for v in json.load(sys.stdin)], sys.stdout)',
  ].join("\n");
  const out = JSON.parse(execFileSync("python3", ["-c", driver], {
    input: JSON.stringify(["4-6 servings", "Makes 12 cookies, serves 6", "4 to 6", "8 servings"]),
    encoding: "utf8",
  }));
  assert.deepEqual(out, [[null, "unspecified"], [null, "unspecified"], [null, "unspecified"], [8, "stated"]]);
});
