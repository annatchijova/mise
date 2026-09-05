#!/usr/bin/env python3
"""Deterministic validator for the shelf-life table (docs/SHELF_LIFE_SCHEMA.md). Stdlib only.

Usage: validate_shelf_life.py [data/shelf_life.json] [data/recipes]

Exit 0 = the table is valid. Exit 1 = hard errors (listed). Warnings never fail the run.

This table is advice, and advice about food that has a safety edge to it. So the checks lean on the
ways a hand-written table of days goes wrong: an ingredient that no longer exists, a number that is
not a whole number of days, a duplicate key where two rows would answer the same question, and a
figure so large it is obviously a typo — 3650 days for salt is a decision, 36500 is a slipped finger.

Coverage is reported and never enforced. An ingredient the table cannot answer for simply has no
estimated date, which is exactly the state the pantry was in before this table existed.
"""
import json, os, re, sys

ROLE = {"protein","fat","acid","binder","umami","aromatic","vegetable","fruit","grain","starch","sweetener","liquid","leavening","spice","herb","garnish","thickener"}
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
# Ten years. Nothing in a kitchen is usefully described as keeping longer, and a bigger number is a
# typo rather than a claim.
MAX_DAYS = 3650


def corpus(recipes_dir):
    """Ingredient ids and the role each plays most often, the same way src/pantry/shelf_life.ts does."""
    counts = {}
    if os.path.isdir(recipes_dir):
        for name in sorted(os.listdir(recipes_dir)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(recipes_dir, name), encoding="utf-8") as f:
                data = json.load(f)
            for r in (data if isinstance(data, list) else [data]):
                if not isinstance(r, dict) or not isinstance(r.get("ingredients"), list):
                    continue
                for ing in r["ingredients"]:
                    if isinstance(ing.get("id"), str) and isinstance(ing.get("role"), str):
                        counts.setdefault(ing["id"], {})
                        counts[ing["id"]][ing["role"]] = counts[ing["id"]].get(ing["role"], 0) + 1
    roles = {}
    for ing, by_role in counts.items():
        roles[ing] = sorted(by_role.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    return roles


def main(argv):
    path = argv[0] if len(argv) > 0 else "data/shelf_life.json"
    recipes_dir = argv[1] if len(argv) > 1 else "data/recipes"
    errors, warnings = [], []

    try:
        with open(path, encoding="utf-8") as f:
            table = json.load(f)
    except Exception as e:
        print(f"ERROR {path}: invalid JSON ({e})")
        return 1

    for k in ("version", "updated_on", "author", "locations", "entries"):
        if k not in table:
            errors.append(f"missing top-level field '{k}'")
    if errors:
        for e in errors: print("ERROR", e)
        return 1

    locations = set(table["locations"])
    extra = table.get("extra_ingredients", {})
    for eid, label in sorted(extra.items()):
        if not KEBAB.match(eid): errors.append(f"extra_ingredients: '{eid}' is not kebab-case")
        if not isinstance(label, str) or not label.strip(): errors.append(f"extra_ingredients: '{eid}' has no display name")
    if not locations:
        errors.append("locations must list the places the table knows about")

    roles = corpus(recipes_dir)
    seen = set()
    answered_ingredients = set()
    answered_roles = set()
    catch_all_locations = set()

    for n, e in enumerate(table["entries"]):
        ing, role, loc = e.get("ingredient"), e.get("role"), e.get("location")
        tag = f"entry[{n}] {ing or '*'}/{role or '*'}/{loc or '*'}"
        for k in ("ingredient", "location", "days", "note"):
            if k not in e:
                errors.append(f"{tag}: missing field '{k}'")
        if any(k not in e for k in ("ingredient", "location", "days", "note")):
            continue

        if ing is not None:
            if not isinstance(ing, str) or not KEBAB.match(ing):
                errors.append(f"{tag}: ingredient is not kebab-case or null")
            elif ing not in roles and ing not in extra:
                errors.append(f"{tag}: ingredient '{ing}' appears in no recipe and is not in extra_ingredients")
            if role is not None:
                errors.append(f"{tag}: a row for a specific ingredient must not also set a role — it would never be reached")
            answered_ingredients.add(ing)
        elif role is not None:
            if role not in ROLE:
                errors.append(f"{tag}: role '{role}' not in the vocabulary")
            answered_roles.add((role, loc))
        else:
            catch_all_locations.add(loc)

        if loc is not None and loc not in locations:
            errors.append(f"{tag}: location '{loc}' is not one this table declares")

        days = e["days"]
        if not isinstance(days, int) or isinstance(days, bool) or days <= 0:
            errors.append(f"{tag}: days must be a positive whole number of days")
        elif days > MAX_DAYS:
            errors.append(f"{tag}: {days} days is past the {MAX_DAYS}-day ceiling; that is a typo, not a shelf life")

        if e["note"] is not None and (not isinstance(e["note"], str) or len(e["note"].strip()) < 10):
            errors.append(f"{tag}: a note that says nothing is worse than none; write null instead")

        key = (ing, role, loc)
        if key in seen:
            errors.append(f"{tag}: duplicate key — two rows would answer the same question")
        seen.add(key)

    # Coverage: which corpus ingredients get no answer at all, in the two everyday locations.
    uncovered = []
    for ing, role in sorted(roles.items()):
        for loc in ("fridge", "pantry"):
            if ing in answered_ingredients:
                continue
            if (role, loc) in answered_roles or (role, None) in answered_roles:
                continue
            if loc in catch_all_locations or None in catch_all_locations:
                continue
            uncovered.append((ing, loc))
    for ing, loc in uncovered:
        warnings.append(f"no shelf life for {ing} in the {loc} — it simply gets no estimated date, which is the old behaviour")

    total = len(table["entries"])
    pairs = len(roles) * 2
    answered = pairs - len(uncovered)
    pct = 0 if pairs == 0 else (answered * 100) // pairs
    print(f"shelf life: {total} rows  ingredient rows: {len(answered_ingredients)}  "
          f"(ingredient, location) pairs answered: {answered}/{pairs} ({pct}%)  "
          f"errors: {len(errors)}  warnings: {len(warnings)}")
    for w in warnings: print("WARN ", w)
    for e in errors: print("ERROR", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
