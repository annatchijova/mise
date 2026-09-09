#!/usr/bin/env python3
"""What people actually swapped, queued for a curator. Stdlib only.

Usage: review_swaps.py [data/imports/swap_candidates.json] [data/substitutions.json]

The substitution table's one weakness is that it stops growing: it holds what one cook thought to
write down. The obvious fix — learn from what people do — is exactly the thing this project refuses,
because a table that quietly absorbs what somebody did once is no longer a table anybody wrote.

So this is a queue and not a feed. It prints what the table has no answer for, most-seen first, with
what the table currently says for that key beside it, and what somebody actually said at the time.
Acting on it means editing data/substitutions.json by hand. Nothing here is ever read by the server.
"""
import json, os, sys


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        print(f"ERROR {path}: {e}")
        sys.exit(1)


def table_answer(table, instead_of, role, technique):
    """What data/substitutions.json says today, walking the same chain the server walks."""
    entries = table.get("entries", [])
    def find(ing, r, t):
        for e in entries:
            if e.get("ingredient") == ing and e.get("role") == r and e.get("technique") == t:
                return e
        return None
    for ing, r, t in ((instead_of, role, technique), (instead_of, role, None), (None, role, technique), (None, role, None)):
        if r is None and ing is not None:
            continue
        hit = find(ing, r, t)
        if hit:
            alts = ", ".join(a["ingredient"] for a in hit["alternatives"]) or "nothing — the row says to leave it out"
            level = "exactly" if ing is not None and t is not None else "more widely"
            return f"{level}: {alts}"
    return "nothing at all"


def main(argv):
    log_path = argv[0] if len(argv) > 0 else "data/imports/swap_candidates.json"
    table_path = argv[1] if len(argv) > 1 else "data/substitutions.json"
    log = load(log_path, {"records": []})
    table = load(table_path, {"entries": []})
    records = log.get("records", [])

    candidates = [r for r in records if r.get("kind") == "candidate"]
    confirmations = [r for r in records if r.get("kind") == "confirmation"]
    # A swap holding a name we have no id for is separated out, because it is different work: not
    # "should the table say this?" but "what is this food called here?", and it is usually one line
    # in data/source_aliases.json rather than a judgement about cooking.
    unnamed = [r for r in records if r.get("unresolved")]

    print(f"swaps seen: {sum(r['count'] for r in records)}  distinct: {len(records)}  "
          f"candidates: {len(candidates)}  confirmations: {len(confirmations)}  "
          f"with a name we do not keep: {len(unnamed)}")
    if not records:
        print("\nNothing queued. Either nobody has recorded a swap yet, or the server had nowhere to write.")
        return 0

    if unnamed:
        print("\n=== NAMES WE DO NOT KEEP — an alias, or a food the table has never heard of ===")
        for r in sorted(unnamed, key=lambda x: -x["count"]):
            print(f"\n  {r['used']} instead of {r['instead_of']}   seen {r['count']}×"
                  f"   (not an ingredient id: {', '.join(r['unresolved'])})")
            for s_ in r["sightings"][-3:]:
                print(f"    \"{s_['note']}\"  ({s_['recipe_id']})")
        print("\n  If one of these is a name for something already in the table, add it to")
        print("  data/source_aliases.json. If it is a food nothing knows, it needs a row of its own.")

    named_candidates = [r for r in candidates if not r.get("unresolved")]
    if named_candidates:
        print("\n=== CANDIDATES — the table has no answer for these ===")
        for r in named_candidates:
            where = f"{r['role'] or '?'}/{r['technique'] or '?'}"
            print(f"\n  {r['used']} instead of {r['instead_of']}  ({where})   seen {r['count']}×, "
                  f"{r['first_seen'][:10]} to {r['last_seen'][:10]}")
            print(f"    the table today says {table_answer(table, r['instead_of'], r['role'], r['technique'])}")
            for s in r["sightings"][-3:]:
                print(f"    \"{s['note']}\"  ({s['recipe_id']})")

    if confirmations:
        print("\n=== CONFIRMATIONS — somebody did what the table already suggests ===")
        for r in sorted(confirmations, key=lambda x: -x["count"]):
            print(f"  {r['used']} instead of {r['instead_of']} ({r['role'] or '?'}/{r['technique'] or '?'}): {r['count']}×")

    print("\nTo act on a candidate, edit data/substitutions.json by hand and bump its version.")
    print("Nothing in this file is ever read by the server: `substitute` reads the table and nothing else.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
