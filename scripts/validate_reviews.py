#!/usr/bin/env python3
"""Check the review records across every curated table. Stdlib only.

Usage: validate_reviews.py

One script rather than a check bolted onto each of the five table validators, because the rule is the
same everywhere and five copies of it would be five rules.

Errors are malformed records -- a review with no name on it, a verdict that is not one of the three,
an `unsure` that does not say what the doubt is. Those are records nobody can act on.

A **stale** review is not an error. Somebody signed a row and then the row changed; that is the
ordinary life of a table. It is reported, and `review_queue.py` puts the row back in the queue, and
nothing pretends the old sign-off covers the new number.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reviews import review_state  # noqa: E402

TABLES = {
    "shelf_life": ("data/shelf_life.json",
                   lambda e: f"{e.get('ingredient') or '*' + str(e.get('role'))}/{e.get('location')}"),
    "substitutions": ("data/substitutions.json",
                      lambda e: f"{e.get('ingredient') or '*' + str(e.get('role'))}/{e.get('technique') or '*'}"),
    "nutrition": ("data/nutrition.json", lambda e: str(e.get("id"))),
    "scaling": ("data/scaling.json",
                lambda e: f"{e.get('ingredient') or '*' + str(e.get('role'))}/{e.get('technique') or '*'}"),
    "long_steps": ("data/long_steps.json", lambda e: f"{e.get('recipe_id')} step {e.get('step')}"),
}


def main():
    from reviews import problems

    errors, stale, reviewed, total, unsure = [], [], 0, 0, []
    for name, (path, key_of) in sorted(TABLES.items()):
        try:
            with open(path, encoding="utf-8") as f:
                table = json.load(f)
        except FileNotFoundError:
            continue
        for e in table.get("entries", []):
            total += 1
            where = f"{name}: {key_of(e)}"
            errors.extend(problems(e, where))
            state = review_state(e)
            if state == "current":
                reviewed += 1
                if (e.get("reviewed") or {}).get("verdict") == "unsure":
                    unsure.append((where, e["reviewed"].get("note")))
            elif state == "stale":
                stale.append((where, (e.get("reviewed") or {}).get("by")))

    print(f"reviews: {reviewed}/{total} rows carry a sign-off that still applies  "
          f"stale: {len(stale)}  unsure: {len(unsure)}  errors: {len(errors)}")
    for where, note in unsure:
        print(f"UNSURE {where}: {note}")
    for where, by in stale:
        print(f"STALE {where}: {by} signed it and the row has changed since; it is back in the queue")
    for e in errors:
        print(f"ERROR {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
