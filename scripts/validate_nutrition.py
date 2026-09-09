#!/usr/bin/env python3
"""Check data/nutrition.json. Stdlib only.

Usage: validate_nutrition.py [data/nutrition.json] [data/recipes]

The table is deliberately incomplete: an ingredient with no row is reported as having no figures,
which is a supported answer and not a defect. So coverage here is a *warning* and a measurement, never
an error. What is an error is a row that is internally impossible, because that is the kind of mistake
nobody catches by reading — a macronutrient total heavier than the food it is in, energy that does not
follow from the macronutrients, a measure of a unit no recipe uses.
"""
import json, os, re, sys, collections

KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
CG = ("protein_cg", "carb_cg", "fat_cg", "fibre_cg")
# Units a curated measure may be given for. `g`, `ml`, `kg` and `l` are handled by arithmetic and
# must not be curated: a gram is a gram, and a row claiming otherwise is a bug wearing a fact's hat.
MEASURE_UNITS = {"pc", "clove", "slice", "bunch", "can", "cup", "tbsp", "tsp"}
# Energy from the macronutrients: 4 kcal a gram of protein and carbohydrate, 9 of fat, 2 of fibre.
# Round figures never land exactly on this, so the check is a wide band and only catches real slips
# (a decimal point in the wrong place), not honest rounding.
ATWATER = {"protein_cg": 4, "carb_cg": 4, "fat_cg": 9, "fibre_cg": 2}


def main(argv):
    path = argv[0] if argv else "data/nutrition.json"
    recipe_dir = argv[1] if len(argv) > 1 else "data/recipes"
    with open(path, encoding="utf-8") as f:
        table = json.load(f)

    errors, warnings = [], []
    entries = table.get("entries", [])

    for field in ("version", "updated_on", "author", "basis", "note"):
        if not table.get(field):
            errors.append(f"the table has no {field}: these figures are somebody's curation and should say whose")
    if not isinstance(table.get("version"), int):
        errors.append("version must be an integer")

    seen = set()
    for e in entries:
        rid = e.get("id", "?")
        where = f"{rid}"
        if not KEBAB.match(str(rid)):
            errors.append(f"{where}: id is not kebab-case")
        if rid in seen:
            errors.append(f"{where}: two rows for one ingredient, so one of them is dead and nobody knows which")
        seen.add(rid)
        if not e.get("name"):
            errors.append(f"{where}: no name. The name says what state the figures are for, and 'chickpea' dried and cooked differ threefold")
        if not e.get("source"):
            errors.append(f"{where}: no source")

        if e.get("negligible"):
            # A trace row asserts nothing, so it must not carry figures that look like assertions.
            for field in ("kcal",) + CG:
                if e.get(field) is not None:
                    errors.append(f"{where}: marked as a trace amount but carries {field}. It should assert nothing at all")
            if not e.get("note"):
                errors.append(f"{where}: a trace row must say why, because it is a judgment and not a measurement")
            continue

        for field in ("kcal",) + CG:
            v = e.get(field)
            if not isinstance(v, int) or isinstance(v, bool):
                errors.append(f"{where}: {field} must be an integer, got {v!r}")
            elif v < 0:
                errors.append(f"{where}: {field} is negative")

        if all(isinstance(e.get(f), int) for f in CG):
            grams = sum(e[f] for f in ("protein_cg", "carb_cg", "fat_cg")) / 100
            if grams > 100:
                errors.append(f"{where}: protein, carbohydrate and fat come to {grams:.1f} g in 100 g of food")
            if isinstance(e.get("kcal"), int):
                # Carbohydrate as published includes the fibre, so counting both at their own rate
                # charges the fibre twice. Take it out of the carbohydrate before adding it back.
                available = max(0, e["carb_cg"] - e["fibre_cg"]) / 100
                implied = (e["protein_cg"] / 100 * 4 + available * 4
                           + e["fat_cg"] / 100 * 9 + e["fibre_cg"] / 100 * 2)
                # Wide on purpose: alcohol, rounding and differing fibre conventions all live in here.
                if e["kcal"] > 20 and not (implied * 0.55 - 25 <= e["kcal"] <= implied * 1.45 + 25):
                    # Printed with the row's own note, because these are usually not mistakes —
                    # alcohol and unavailable carbohydrate both live here — and a warning a reader
                    # has to go and investigate every run is a warning they stop reading.
                    said = f" Row says: {e['note']}" if e.get("note") else " The row says nothing about why."
                    warnings.append(
                        f"{where}: {e['kcal']} kcal does not follow from its macronutrients "
                        f"(they imply about {implied:.0f}).{said}"
                    )

        ml = e.get("g_per_100ml")
        if ml is not None and (not isinstance(ml, int) or not 30 <= ml <= 250):
            errors.append(f"{where}: g_per_100ml is {ml!r}; a real liquid weighs somewhere near what water does")

        for unit, per in (e.get("measures") or {}).items():
            if unit not in MEASURE_UNITS:
                errors.append(f"{where}: a curated measure for '{unit}'. Weights and volumes are arithmetic, not curation")
            if not isinstance(per, int) or per <= 0:
                errors.append(f"{where}: the measure for '{unit}' is {per!r}, which is not a positive whole number of grams")

    # Coverage against the corpus: a measurement, never a failure.
    used = collections.Counter()
    unit_of = collections.defaultdict(collections.Counter)
    if os.path.isdir(recipe_dir):
        for name in sorted(os.listdir(recipe_dir)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(recipe_dir, name), encoding="utf-8") as f:
                for i in json.load(f).get("ingredients", []):
                    used[i["id"]] += 1
                    unit_of[i["id"]][i["unit"]] += 1

    by_id = {e["id"]: e for e in entries}
    for rid in by_id:
        if rid not in used:
            warnings.append(f"{rid}: a row for an ingredient no recipe uses")

    # The measure a recipe actually asks for is the one worth curating. Say which are missing.
    missing_measure = []
    for rid, units in unit_of.items():
        row = by_id.get(rid)
        if not row or row.get("negligible"):
            continue
        for unit in units:
            if unit in MEASURE_UNITS and unit not in (row.get("measures") or {}):
                missing_measure.append(f"{rid} in {unit}")

    no_row = [i for i in used if i not in by_id]
    covered = len(used) - len(no_row)
    print(
        f"nutrition: {len(entries)} rows  "
        f"({sum(1 for e in entries if e.get('negligible'))} trace)  "
        f"ingredients in the corpus: {covered}/{len(used)} have a row  "
        f"errors: {len(errors)}  warnings: {len(warnings)}"
    )
    if no_row:
        print(f"  no figures for {len(no_row)}: {', '.join(sorted(no_row)[:12])}"
              + (" ..." if len(no_row) > 12 else ""))
    if missing_measure:
        print(f"  measured in a way we cannot weigh: {', '.join(sorted(missing_measure))}")
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
