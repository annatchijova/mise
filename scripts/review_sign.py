#!/usr/bin/env python3
"""Record that a person read a curated row, and what they concluded. Stdlib only.

    review_sign.py <table> <row> --verdict confirmed [--note "..."] [--by "..."]
    review_sign.py <table> <row> --verdict corrected --set days=10 --note "why"
    review_sign.py --status

<table> is one of: shelf_life, substitutions, nutrition, scaling, long_steps.
<row> is the key `review_queue.py` prints, e.g. "garlic-oil / fridge" or "chickpea".

Three verdicts, and the middle one is the point of having three:

  confirmed  the row is right as it stands.
  corrected  it was wrong and has been changed. Pass --set to change it in the same breath, so the
             new value and the sign-off are the same act and cannot disagree.
  unsure     a cook read it and does not want to sign it off. This is not a failed review, it is
             better information than the row had before, and it ranks the row UP rather than
             clearing it. It must say what the doubt is.

The signature is a digest of the row's content, so a review says what it reviewed. Change the row
afterwards and the review goes stale and the row comes back into the queue -- which is the only way
a sign-off means anything a year later.
"""
import argparse
import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reviews import VERDICTS, review_state, row_digest  # noqa: E402

TABLES = {
    "shelf_life": ("data/shelf_life.json",
                   lambda e: f"{e.get('ingredient') or '(anything ' + str(e.get('role')) + ')'} / {e.get('location')}"),
    "substitutions": ("data/substitutions.json",
                      lambda e: f"{e.get('ingredient') or '(any ' + str(e.get('role')) + ')'} · {e.get('role')} · {e.get('technique') or 'any'}"),
    "nutrition": ("data/nutrition.json", lambda e: e.get("id")),
    "scaling": ("data/scaling.json",
                lambda e: f"{e.get('ingredient') or '(any ' + str(e.get('role')) + ')'} · {e.get('technique') or 'any'}"),
    "long_steps": ("data/long_steps.json", lambda e: f"{e.get('recipe_id')} step {e.get('step')}"),
}

DEFAULT_BY = "the author's kitchen"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(path, table):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(table, f, indent=2, ensure_ascii=False)
        f.write("\n")


def coerce(text):
    """'10' -> 10, 'true' -> True, anything else stays a string. Small on purpose: --set is for
    fixing a number or a flag, and anything bigger belongs in an editor where you can see it."""
    for cast in (int, float):
        try:
            return cast(text)
        except ValueError:
            pass
    return {"true": True, "false": False, "null": None}.get(text.lower(), text)


def status():
    total = collections = 0
    print(f"{'table':<16}{'rows':>6}{'reviewed':>10}{'stale':>7}{'unsure':>8}")
    for name, (path, _) in sorted(TABLES.items()):
        table = load(path)
        rows = table["entries"]
        states = [review_state(e) for e in rows]
        unsure = sum(1 for e in rows if (e.get("reviewed") or {}).get("verdict") == "unsure")
        print(f"{name:<16}{len(rows):>6}{states.count('current'):>10}{states.count('stale'):>7}{unsure:>8}")
        total += len(rows)
        collections += states.count("current")
    print(f"\n{collections} of {total} rows carry a review that still applies to what the row says now.")
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("table", nargs="?", choices=sorted(TABLES))
    ap.add_argument("row", nargs="?")
    ap.add_argument("--verdict", choices=VERDICTS)
    ap.add_argument("--note", default="")
    ap.add_argument("--by", default=DEFAULT_BY)
    ap.add_argument("--on", default=date.today().isoformat())
    ap.add_argument("--set", action="append", default=[], metavar="FIELD=VALUE",
                    help="change a field as part of a 'corrected' verdict")
    ap.add_argument("--status", action="store_true", help="how much of each table has been read")
    args = ap.parse_args(argv)

    if args.status:
        return status()
    if not (args.table and args.row and args.verdict):
        ap.error("give a table, a row and a --verdict (or --status)")

    path, key_of = TABLES[args.table]
    table = load(path)
    matches = [e for e in table["entries"] if key_of(e) == args.row]
    if not matches:
        print(f"No row called {args.row!r} in {args.table}. The keys are the ones review_queue.py prints:")
        for e in table["entries"][:5]:
            print(f"  {key_of(e)}")
        return 1
    if len(matches) > 1:
        print(f"{len(matches)} rows answer to {args.row!r}, which the validator should have caught.")
        return 1
    row = matches[0]

    if args.verdict == "corrected" and not args.set:
        print("A 'corrected' verdict with nothing changed is a 'confirmed' with a bad name.")
        print("Pass --set field=value, or edit the file and sign it as confirmed afterwards.")
        return 1
    if args.verdict != "corrected" and args.set:
        print("--set only makes sense with --verdict corrected.")
        return 1
    if args.verdict == "unsure" and not args.note.strip():
        print("An 'unsure' verdict has to say what the doubt is, or nobody can act on it.")
        return 1

    before = {}
    for pair in args.set:
        if "=" not in pair:
            print(f"--set wants field=value, got {pair!r}")
            return 1
        field, value = pair.split("=", 1)
        if field not in row:
            print(f"{args.row}: no field {field!r}. It has: {', '.join(k for k in row if k != 'reviewed')}")
            return 1
        before[field] = row[field]
        row[field] = coerce(value)

    row["reviewed"] = {
        "by": args.by,
        "on": args.on,
        "verdict": args.verdict,
        "note": args.note.strip() or None,
        # Computed last, over the row as it now stands, so a correction is signed in its corrected form.
        "row_digest": row_digest(row),
    }
    # `version` means the advice changed, and it travels in every response so a recorded answer can
    # be tied to the advice that produced it. Reading a row and agreeing with it does not change any
    # advice, so a `confirmed` or `unsure` review leaves the version alone -- bumping it for every
    # sign-off would turn the number into noise and break the one thing it is for.
    if before:
        table["version"] = table.get("version", 1) + 1
    save(path, table)

    print(f"{args.table}: {args.row}")
    for field, was in before.items():
        print(f"  {field}: {was} -> {row[field]}")
    print(f"  {args.verdict} by {args.by} on {args.on}"
          + (f' — "{args.note.strip()}"' if args.note.strip() else ""))
    print(f"  signed {row['reviewed']['row_digest']}; {path}"
          + (f" is now version {table['version']}" if before else f" stays at version {table.get('version', 1)},"
             " because a review that changed nothing changed no advice"))
    if args.verdict == "unsure":
        print("  It stays near the top of the queue, marked as wanting a second opinion.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
