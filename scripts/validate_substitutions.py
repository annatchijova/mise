#!/usr/bin/env python3
"""Deterministic validator for the substitution table (docs/SUBSTITUTION_SCHEMA.md). Stdlib only.

Usage: validate_substitutions.py [data/substitutions.json] [data/recipes]

Exit 0 = the table is valid. Exit 1 = hard errors (listed). Warnings never fail the run.

The table is the one piece of judgment in the system that is neither derived nor deterministic-by-
construction: a person wrote every row. So the checks here are about the ways a hand-written table
goes wrong — an ingredient id that no longer exists, a ratio that is really a float, a row that
substitutes an ingredient for itself, an alternative with a warning but no instruction — plus a
coverage report saying which (ingredient, role, technique) triples the recipes use that the table
cannot answer at any level of its fallback chain. Coverage is a warning, never an error: an
uncovered triple means `substitute` says it has nothing curated, which is a correct answer.
"""
import json, os, re, sys

ROLE = {"protein","fat","acid","binder","umami","aromatic","vegetable","fruit","grain","starch","sweetener","liquid","leavening","spice","herb","garnish","thickener"}
TECHNIQUE = {"emulsify","brown","bind-cold","bind-hot","leaven","thicken","ferment","marinate","simmer","fry","bake","raw","whip","sweeten","season","dissolve","none"}
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def corpus_ids(recipes_dir):
    """Every canonical ingredient id the recipes actually use, plus the role/technique pairs."""
    ids, triples = set(), set()
    if not os.path.isdir(recipes_dir):
        return ids, triples
    for name in sorted(os.listdir(recipes_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(recipes_dir, name), encoding="utf-8") as f:
            data = json.load(f)
        for r in (data if isinstance(data, list) else [data]):
            if not isinstance(r, dict) or "ingredients" not in r:
                continue
            for ing in r["ingredients"]:
                if isinstance(ing.get("id"), str):
                    ids.add(ing["id"])
                    triples.add((ing["id"], ing.get("role"), ing.get("technique")))
    return ids, triples


def check_ratio(ratio, path, err):
    if ratio is None:
        return
    if not isinstance(ratio, list) or len(ratio) != 2:
        err(f"{path} ratio must be [numerator, denominator] or null")
        return
    for part in ratio:
        if not isinstance(part, int) or isinstance(part, bool) or part <= 0:
            err(f"{path} ratio parts must be positive integers, not {part!r} — a ratio is a proportion, not a float")


def main(argv):
    table_path = argv[0] if len(argv) > 0 else "data/substitutions.json"
    recipes_dir = argv[1] if len(argv) > 1 else "data/recipes"
    errors, warnings = [], []
    def err(m): errors.append(m)
    def warn(m): warnings.append(m)

    try:
        with open(table_path, encoding="utf-8") as f:
            table = json.load(f)
    except Exception as e:
        print(f"ERROR {table_path}: invalid JSON ({e})")
        return 1

    for k in ("version", "updated_on", "author", "extra_ingredients", "entries"):
        if k not in table:
            err(f"missing top-level field '{k}'")
    if errors:
        for e in errors: print("ERROR", e)
        return 1
    if not isinstance(table["version"], int) or table["version"] < 1:
        err("version must be a positive integer")

    known, triples = corpus_ids(recipes_dir)
    extra = table["extra_ingredients"]
    for eid, label in sorted(extra.items()):
        if not KEBAB.match(eid): err(f"extra_ingredients: '{eid}' is not kebab-case")
        if not isinstance(label, str) or not label.strip(): err(f"extra_ingredients: '{eid}' has no display name")
        if eid in known: warn(f"extra_ingredients: '{eid}' is already a recipe ingredient; the entry is redundant")
    nameable = known | set(extra)

    seen = set()
    covered = set()          # (ingredient, role, technique) keys the table answers exactly
    covered_role = set()     # (role, technique) and (role,) keys, for the fallback levels
    for n, e in enumerate(table["entries"]):
        tag = f"entry[{n}] {e.get('ingredient') or '*'}/{e.get('role')}/{e.get('technique') or '*'}"
        for k in ("ingredient", "role", "technique", "alternatives", "if_missing"):
            if k not in e: err(f"{tag}: missing field '{k}'")
        if any(k not in e for k in ("ingredient", "role", "technique", "alternatives", "if_missing")):
            continue
        ing, role, tech = e["ingredient"], e["role"], e["technique"]
        if ing is not None:
            if not isinstance(ing, str) or not KEBAB.match(ing): err(f"{tag}: ingredient is not kebab-case or null")
            elif ing not in nameable: err(f"{tag}: ingredient '{ing}' is in no recipe and not in extra_ingredients")
        if role not in ROLE: err(f"{tag}: role '{role}' not in the vocabulary")
        if tech is not None and tech not in TECHNIQUE: err(f"{tag}: technique '{tech}' not in the vocabulary")

        key = (ing, role, tech)
        if key in seen: err(f"{tag}: duplicate key — two rows would answer the same question")
        seen.add(key)
        if ing is None:
            covered_role.add((role, tech))
        else:
            covered.add(key)

        if not isinstance(e["if_missing"], str) or len(e["if_missing"].strip()) < 10:
            err(f"{tag}: if_missing must say what to do when nothing on the list is at hand")

        alts = e["alternatives"]
        if not isinstance(alts, list): err(f"{tag}: alternatives must be a list"); continue
        alt_ids = set()
        for m, a in enumerate(alts):
            path = f"{tag} alternative[{m}]"
            aid = a.get("ingredient")
            if not isinstance(aid, str) or not KEBAB.match(aid): err(f"{path}: ingredient is not kebab-case")
            elif aid not in nameable: err(f"{path}: '{aid}' is in no recipe and not in extra_ingredients")
            elif aid == ing: err(f"{path}: substitutes '{aid}' for itself")
            if aid in alt_ids: err(f"{path}: '{aid}' listed twice")
            alt_ids.add(aid)
            check_ratio(a.get("ratio"), path, err)
            if not isinstance(a.get("note"), str) or len(a["note"].strip()) < 5:
                err(f"{path}: every alternative needs a note saying how to use it")
            if "warning" not in a: err(f"{path}: warning is required — write null when nothing goes wrong")
            elif a["warning"] is not None and (not isinstance(a["warning"], str) or len(a["warning"].strip()) < 10):
                err(f"{path}: a warning that says nothing is worse than none; write null instead")

    # Coverage: which triples the recipes use that the fallback chain cannot answer at all.
    uncovered = []
    for ing, role, tech in sorted(t for t in triples if t[1] is not None):
        if (ing, role, tech) in covered: continue
        if (ing, role, None) in covered: continue
        if (ing, None, None) in covered: continue
        if (role, tech) in covered_role: continue
        if (role, None) in covered_role: continue
        uncovered.append((ing, role, tech))
    for ing, role, tech in uncovered:
        warn(f"no answer for {ing} as {role}/{tech} — `substitute` will say it has nothing curated")

    total = len(table["entries"])
    answerable = len(triples) - len(uncovered)
    pct = 0 if not triples else (answerable * 100) // len(triples)
    print(f"substitutions: {total}  role-level rows: {len(covered_role)}  "
          f"corpus triples answered: {answerable}/{len(triples)} ({pct}%)  "
          f"errors: {len(errors)}  warnings: {len(warnings)}")
    for w in warnings: print("WARN ", w)
    for e in errors: print("ERROR", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
