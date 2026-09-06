#!/usr/bin/env python3
"""Check data/long_steps.json. Stdlib only.

Usage: validate_long_steps.py [data/long_steps.json] [data/recipes]

What to look at during a long wait is culinary knowledge, so it is curated per step rather than worked
out from a duration. That makes two things worth enforcing that no other table here needs: every row
must point at a step that actually exists (a renamed recipe or a re-ordered step silently orphans a
plan), and every long step in the corpus should have a row — including the rows that say there is
nothing to check, because deciding that is different from nobody having looked.
"""
import json, os, sys

LONG_STEP_S = 3600


def main(argv):
    path = argv[0] if argv else "data/long_steps.json"
    recipe_dir = argv[1] if len(argv) > 1 else "data/recipes"
    with open(path, encoding="utf-8") as f:
        table = json.load(f)

    errors, warnings = [], []
    entries = table.get("entries", [])

    for field in ("version", "updated_on", "author", "note"):
        if not table.get(field):
            errors.append(f"the table has no {field}: this is somebody's judgment and should say whose")

    steps = {}
    for name in sorted(os.listdir(recipe_dir)) if os.path.isdir(recipe_dir) else []:
        if not name.endswith(".json"):
            continue
        with open(os.path.join(recipe_dir, name), encoding="utf-8") as f:
            r = json.load(f)
        for s in r.get("steps", []):
            steps[(r["id"], s["order"])] = s

    seen = set()
    quiet = 0
    for e in entries:
        key = (e.get("recipe_id"), e.get("step"))
        where = f"{key[0]} step {key[1]}"
        if key in seen:
            errors.append(f"{where}: two plans for one step")
        seen.add(key)

        step = steps.get(key)
        if step is None:
            errors.append(f"{where}: no such step. A renamed recipe or a re-ordered step orphans a plan silently")
        elif step["dur_s"] < LONG_STEP_S:
            warnings.append(f"{where}: only {step['dur_s']}s long, which nobody needs reminding about")

        if not e.get("kind"):
            errors.append(f"{where}: no kind")
        if not e.get("note"):
            errors.append(f"{where}: no note. Both a cadence and a decision not to have one need a reason")

        first, every, look = e.get("first_check_s"), e.get("check_every_s"), e.get("look_for") or []
        if first is None and every is None:
            quiet += 1
            if look:
                errors.append(f"{where}: says there is nothing to check but also lists things to look at")
            continue

        for field, v in (("first_check_s", first), ("check_every_s", every)):
            if v is not None and (not isinstance(v, int) or v <= 0):
                errors.append(f"{where}: {field} is {v!r}, which is not a positive whole number of seconds")
        if not look:
            errors.append(f"{where}: has a cadence but nothing to look at, which is a reminder with no content")
        for line in look:
            if not isinstance(line, str) or len(line.strip()) < 10:
                errors.append(f"{where}: a look_for line that says nothing: {line!r}")
        if step is not None and first is not None and first >= step["dur_s"]:
            errors.append(f"{where}: the first look is due after the step is over")

    long_steps = {k for k, s in steps.items() if s["dur_s"] >= LONG_STEP_S}
    missing = sorted(long_steps - seen)
    for k in missing:
        warnings.append(f"{k[0]} step {k[1]}: {steps[k]['dur_s']}s long and nobody has written a plan for it")

    print(
        f"long steps: {len(entries)} plans ({quiet} of them 'nothing to check')  "
        f"steps of an hour or more: {len(long_steps) - len(missing)}/{len(long_steps)} have a plan  "
        f"errors: {len(errors)}  warnings: {len(warnings)}"
    )
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
