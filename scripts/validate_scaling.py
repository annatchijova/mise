#!/usr/bin/env python3
"""Deterministic validator for the scaling table (docs/SCALING_SCHEMA.md). Stdlib only.

Usage: validate_scaling.py [data/scaling.json] [data/recipes]

Exit 0 = valid. Exit 1 = hard errors (listed). Warnings never fail the run.

The table decides how much salt goes into a doubled stew, so the checks are about the ways a damping
table goes wrong: a damping that is a float, a damping above 1 (which would mean an amount grows
faster than the number of people, and nothing does), a row for a named ingredient that also sets a
role and would therefore never be reached, and a warning with no threshold or a threshold with no
warning — either half alone is a row that does nothing.
"""
import json, os, re, sys

ROLE = {"protein","fat","acid","binder","umami","aromatic","vegetable","fruit","grain","starch","sweetener","liquid","leavening","spice","herb","garnish","thickener"}
TECHNIQUE = {"emulsify","brown","bind-cold","bind-hot","leaven","thicken","ferment","marinate","simmer","fry","bake","raw","whip","sweeten","season","dissolve","none"}
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def corpus_ids(recipes_dir):
    ids = set()
    if not os.path.isdir(recipes_dir):
        return ids
    for name in sorted(os.listdir(recipes_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(recipes_dir, name), encoding="utf-8") as f:
            data = json.load(f)
        for r in (data if isinstance(data, list) else [data]):
            if isinstance(r, dict) and isinstance(r.get("ingredients"), list):
                for ing in r["ingredients"]:
                    if isinstance(ing.get("id"), str):
                        ids.add(ing["id"])
    return ids


def main(argv):
    path = argv[0] if len(argv) > 0 else "data/scaling.json"
    recipes_dir = argv[1] if len(argv) > 1 else "data/recipes"
    errors, warnings = [], []

    try:
        with open(path, encoding="utf-8") as f:
            table = json.load(f)
    except Exception as e:
        print(f"ERROR {path}: invalid JSON ({e})")
        return 1

    for k in ("version", "updated_on", "author", "entries"):
        if k not in table:
            errors.append(f"missing top-level field '{k}'")
    if errors:
        for e in errors: print("ERROR", e)
        return 1

    known = corpus_ids(recipes_dir)
    seen = set()
    damped = 0
    for n, e in enumerate(table["entries"]):
        ing, role, tech = e.get("ingredient"), e.get("role"), e.get("technique")
        tag = f"entry[{n}] {ing or '*'}/{role or '*'}/{tech or '*'}"
        for k in ("ingredient", "role", "technique", "damping", "note", "warn_above", "warning"):
            if k not in e:
                errors.append(f"{tag}: missing field '{k}'")
        if any(k not in e for k in ("ingredient", "role", "technique", "damping", "note", "warn_above", "warning")):
            continue

        if ing is not None:
            if not KEBAB.match(ing): errors.append(f"{tag}: ingredient is not kebab-case or null")
            elif ing not in known: errors.append(f"{tag}: ingredient '{ing}' appears in no recipe")
            if role is not None or tech is not None:
                errors.append(f"{tag}: a row for a named ingredient must not also set a role or technique — the ingredient key matches first, so the rest would never be read")
        if role is not None and role not in ROLE: errors.append(f"{tag}: role '{role}' not in the vocabulary")
        if tech is not None and tech not in TECHNIQUE: errors.append(f"{tag}: technique '{tech}' not in the vocabulary")
        if ing is None and role is None and tech is None:
            errors.append(f"{tag}: a row that keys on nothing would shadow every other row")

        d = e["damping"]
        if not isinstance(d, list) or len(d) != 2 or not all(isinstance(x, int) and not isinstance(x, bool) for x in d):
            errors.append(f"{tag}: damping must be two integers — a proportion, never a float")
        else:
            num, den = d
            if den <= 0 or num < 0:
                errors.append(f"{tag}: damping must be a non-negative numerator over a positive denominator")
            elif num > den:
                errors.append(f"{tag}: damping {num}/{den} is above 1, which would mean the amount grows faster than the number of people. Nothing does.")
            elif num != den:
                damped += 1

        if not isinstance(e["note"], str) or len(e["note"].strip()) < 15:
            errors.append(f"{tag}: every row needs a note saying why it behaves the way it does")

        has_threshold = e["warn_above"] is not None
        has_text = e["warning"] is not None
        if has_threshold != has_text:
            errors.append(f"{tag}: a threshold with no warning, or a warning with no threshold, is a row that does nothing")
        if has_threshold and (not isinstance(e["warn_above"], int) or e["warn_above"] < 1):
            errors.append(f"{tag}: warn_above must be a whole factor of 1 or more")
        if has_text and len(e["warning"].strip()) < 20:
            errors.append(f"{tag}: a warning that says nothing is worse than none")

        key = (ing, role, tech)
        if key in seen: errors.append(f"{tag}: duplicate key — two rows would answer the same question")
        seen.add(key)

    warns = sum(1 for e in table["entries"] if e.get("warning"))
    print(f"scaling: {len(table['entries'])} rows  damped: {damped}  with a pan warning: {warns}  "
          f"errors: {len(errors)}  warnings: {len(warnings)}")
    for w in warnings: print("WARN ", w)
    for e in errors: print("ERROR", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
