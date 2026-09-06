#!/usr/bin/env python3
"""Which curated row should a person read first. Stdlib only.

Usage: review_queue.py [--table shelf_life|substitutions|nutrition|scaling|long_steps] [--top N] [--json]

`docs/BLOCKED.md` §H says two tables need a cook to read them end to end, and there are now five
curated tables carrying somebody's judgment. "Read it end to end" is the correct instruction and it
is also the one nobody follows, because 400-odd rows is a weekend and the reader has no idea which
rows are load-bearing.

So this ranks them. Not by how likely a row is to be wrong — nobody can compute that, and a
confidence number attached to somebody's judgment would be exactly the invented certainty this
project exists to avoid. It ranks by **what it would cost if the row were wrong**, which is
computable and is a different question:

  - **Reach.** How many times the row actually answers something, measured by running the real
    lookups over the real corpus rather than by guessing. A row nothing ever reads is not worth
    anybody's Saturday, however uncertain it is.
  - **Consequence.** Whether being wrong changes what somebody does. A shelf-life row under a week
    moves a meal in the plan; a 365-day row decides nothing. A substitution row with no wider row
    behind it is the only answer there is.
  - **Care.** Whether the row is one where wrong is a safety matter rather than a dinner matter.
    That is curated per row, not detected — a keyword in a note is not a fact about food.

Every point is itemised with what produced it. A ranking somebody cannot argue with row by row is
not a ranking, it is an opinion with a number on it.
"""
import argparse, json, os, sys, collections

# --- points ---------------------------------------------------------------------------------------
#
# Deliberately coarse and deliberately integer. The gap between "the top ten" and "the rest" is the
# only thing this has to get right; a finer scale would imply a precision that is not there.
REACH_CAP = 30          # a row cannot earn more than this for being popular
SHORT_LIVED = 25        # under a week, so the planner's deadline pass acts on it
VERY_SHORT = 15         # under three days, and a day's error is most of the answer
SOLE_AUTHORITY = 10     # nothing in the table to cross-check it against
SOLE_ANSWER = 15        # no wider row behind it: if it is wrong there is no fallback
CAUTION = 100           # wrong here is a safety matter. Always first, and by a distance.
DOMINANT = 20           # this row is most of what an answer is made of
FLAGGED = 15            # a validator already said something about this row


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def corpus(recipes_dir):
    out = []
    for name in sorted(os.listdir(recipes_dir)):
        if name.endswith(".json"):
            with open(os.path.join(recipes_dir, name), encoding="utf-8") as f:
                out.append(json.load(f))
    return out


class Item:
    """One row, with every point traced to what produced it."""

    def __init__(self, table, key, summary, note=None):
        self.table, self.key, self.summary, self.note = table, key, summary, note
        self.points = []

    def add(self, points, why):
        """Record a reason, including one worth nothing.

        A zero-point reason is the most informative line in the queue -- "nothing in the corpus
        reaches it" is exactly what a curator needs to know before spending a Saturday on a row --
        and dropping it because it scores nothing would leave the row ranked last with no
        explanation of why.
        """
        self.points.append((points, why))
        return self

    @property
    def score(self):
        return sum(p for p, _ in self.points)

    def as_dict(self):
        return {"table": self.table, "row": self.key, "summary": self.summary, "note": self.note,
                "score": self.score, "because": [{"points": p, "why": w} for p, w in self.points]}


def capped(n, per, cap):
    return min(n * per, cap)


# --- shelf life -------------------------------------------------------------------------------------

def shelf_life_queue(table, recipes):
    if not table:
        return []
    used = collections.Counter()
    roles = collections.Counter()
    for r in recipes:
        for i in r["ingredients"]:
            used[i["id"]] += 1
            roles[i.get("role")] += 1

    by_ingredient = collections.Counter(e["ingredient"] for e in table["entries"] if e.get("ingredient"))
    items = []
    for e in table["entries"]:
        ing, loc, days = e.get("ingredient"), e.get("location"), e.get("days")
        name = ing or f"(anything {e.get('role')})"
        item = Item("shelf_life", f"{name} / {loc}", f"{days} days in the {loc}", e.get("note"))

        # A role row answers for every ingredient of that role with no row of its own, which is a
        # count and not a fraction of something. Guessing it would put the same number on every role
        # row and quietly rank them all alike.
        if ing:
            n = used.get(ing, 0)
            why = f"{n} recipe line{'' if n == 1 else 's'} use{'s' if n == 1 else ''} it"
        else:
            covered = {e2["ingredient"] for e2 in table["entries"]
                       if e2.get("ingredient") and e2.get("location") == loc}
            n = sum(c for i2, c in used.items() if i2 not in covered
                    and any(x.get("role") == e.get("role") for r2 in recipes for x in r2["ingredients"] if x["id"] == i2))
            why = f"{n} recipe line{'' if n == 1 else 's'} of that role fall through to it"
        item.add(capped(n, 3, REACH_CAP), why)

        if isinstance(days, int):
            if days < 3:
                item.add(VERY_SHORT, f"{days} days: a day's error is most of the answer")
            elif days < 7:
                item.add(SHORT_LIVED, f"under a week, so the planner moves meals on it")
        if ing and by_ingredient[ing] == 1:
            item.add(SOLE_AUTHORITY, "the only row for it, so nothing here cross-checks it")
        if e.get("caution"):
            item.add(CAUTION, f"marked a safety matter: {e.get('caution_reason') or 'no reason given'}")
        items.append(item)
    return items


# --- substitutions ----------------------------------------------------------------------------------

def key_of(ingredient, role, technique):
    return f"{ingredient or '*'}|{role or '*'}|{technique or '*'}"


def substitution_queue(table, recipes):
    """Reach measured by walking the real chain, not estimated.

    Every (ingredient, role, technique) the corpus actually contains is looked up exactly the way
    `substitutionsFor` looks it up, and the row that wins is credited. A row that never wins is a row
    nobody has ever been given, whatever it says.
    """
    if not table:
        return []
    index = {key_of(e.get("ingredient"), e.get("role"), e.get("technique")): e for e in table["entries"]}
    # Ingredients no recipe uses, listed in the table on purpose so that somebody asking "what
    # instead of tahini?" with no recipe in play gets an answer. Reach over the corpus cannot see
    # that path, and a row that looks dead is a row somebody deletes.
    extra = set(table.get("extra_ingredients") or [])

    wins = collections.Counter()
    for r in recipes:
        for i in r["ingredients"]:
            ing, role, tech = i["id"], i.get("role"), i.get("technique")
            if not role or not tech:
                continue
            chain = [
                key_of(ing, role, tech), key_of(ing, role, None), key_of(ing, None, None),
                key_of(None, role, tech), key_of(None, role, None),
            ]
            for depth, k in enumerate(chain):
                if k in index:
                    wins[k] += 1
                    # A row that answered at the first level had nothing wider behind it *for that
                    # query*; what matters for review is whether anything is behind it at all.
                    break

    items = []
    for e in table["entries"]:
        k = key_of(e.get("ingredient"), e.get("role"), e.get("technique"))
        ing = e.get("ingredient") or f"(any {e.get('role')})"
        alts = ", ".join(a["ingredient"] for a in e.get("alternatives", [])) or "nothing — leave it out"
        item = Item("substitutions", f"{ing} · {e.get('role')} · {e.get('technique') or 'any'}",
                    f"-> {alts}", e.get("if_missing"))

        n = wins.get(k, 0)
        if n:
            item.add(capped(n, 4, REACH_CAP), f"answers {n} ingredient line{'' if n == 1 else 's'} in the corpus")
        elif e.get("ingredient") in extra:
            item.add(0, "no recipe uses it: it is here to answer somebody asking about it directly, "
                        "which is a path this cannot count — not a dead row")
        else:
            item.add(0, "nothing in the corpus reaches it")

        # Is anything wider behind this row? If not, being wrong here is silence or a wrong answer
        # with no fallback.
        if e.get("ingredient"):
            wider = [key_of(e["ingredient"], e.get("role"), None), key_of(None, e.get("role"), e.get("technique")),
                     key_of(None, e.get("role"), None)]
            if n and not any(w in index and w != k for w in wider):
                item.add(SOLE_ANSWER, "no wider row behind it: wrong here has no fallback")

        # A row that tells somebody to leave the ingredient out is a stronger claim than one offering
        # a swap, and a wrong one is harder to notice.
        if not e.get("alternatives"):
            item.add(SOLE_ANSWER, "it says to leave the ingredient out, which is a strong claim")
        items.append(item)
    return items


# --- nutrition --------------------------------------------------------------------------------------

def nutrition_queue(table, recipes):
    if not table:
        return []
    rows = {e["id"]: e for e in table["entries"]}
    counted = collections.Counter()
    dominant = set()

    for r in recipes:
        # Roughly what the module counts: a row, and an amount in grams we can reach. Deliberately a
        # subset of the real rule -- this is a queue, not a second implementation of the tool.
        contributions = []
        for i in r["ingredients"]:
            e = rows.get(i["id"])
            if not e or e.get("negligible") or i.get("qty") is None:
                continue
            unit, qty = i["unit"], i["qty"]
            grams = None
            if unit == "g":
                grams = qty
            elif unit == "kg":
                grams = qty * 1000
            elif unit in ("ml", "l") and e.get("g_per_100ml"):
                grams = qty * (1000 if unit == "l" else 1) * e["g_per_100ml"] / 100
            elif unit in (e.get("measures") or {}):
                grams = qty * e["measures"][unit]
            if grams is None:
                continue
            counted[i["id"]] += 1
            contributions.append((i["id"], grams * (e.get("kcal") or 0) / 100))
        total = sum(c for _, c in contributions)
        if total > 0:
            for ing, c in contributions:
                if c / total > 0.25:
                    dominant.add(ing)

    items = []
    for e in table["entries"]:
        if e.get("negligible"):
            continue
        item = Item("nutrition", e["id"], f"{e['kcal']} kcal / 100 g, as {e['name']}", e.get("note"))
        n = counted.get(e["id"], 0)
        item.add(capped(n, 5, REACH_CAP), f"counted in {n} recipe{'' if n == 1 else 's'}"
                 if n else "never counted in any recipe here")
        if e["id"] in dominant:
            item.add(DOMINANT, "more than a quarter of the calories in at least one dish")
        # The energy check from the validator, repeated here so the queue and the validator agree.
        available = max(0, (e.get("carb_cg") or 0) - (e.get("fibre_cg") or 0)) / 100
        implied = ((e.get("protein_cg") or 0) / 100 * 4 + available * 4
                   + (e.get("fat_cg") or 0) / 100 * 9 + (e.get("fibre_cg") or 0) / 100 * 2)
        kcal = e.get("kcal") or 0
        if kcal > 20 and not (implied * 0.55 - 25 <= kcal <= implied * 1.45 + 25):
            item.add(FLAGGED, f"the validator warns: {kcal} kcal against about {implied:.0f} implied")
        items.append(item)
    return items


# --- scaling and long steps ---------------------------------------------------------------------------

def scaling_queue(table, recipes):
    if not table:
        return []
    used = collections.Counter()
    roles = collections.Counter()
    for r in recipes:
        for i in r["ingredients"]:
            used[i["id"]] += 1
            roles[i.get("role")] += 1
    items = []
    for e in table["entries"]:
        who = e.get("ingredient") or f"(any {e.get('role')})"
        num, den = (e.get("damping") or [1, 1])[:2]
        item = Item("scaling", f"{who} · {e.get('technique') or 'any'}", f"damping {num}/{den}", e.get("note"))
        n = used.get(e.get("ingredient"), 0) if e.get("ingredient") else roles.get(e.get("role"), 0)
        item.add(capped(n, 3, REACH_CAP), f"{n} ingredient line{'' if n == 1 else 's'} match it")
        if den and num != den:
            item.add(SOLE_ANSWER, "it changes an amount, so a wrong figure changes a dish")
        items.append(item)
    return items


def long_step_queue(table, recipes):
    if not table:
        return []
    dur = {}
    for r in recipes:
        for s in r["steps"]:
            dur[(r["id"], s["order"])] = s["dur_s"]
    items = []
    for e in table["entries"]:
        seconds = dur.get((e["recipe_id"], e["step"]), 0)
        quiet = e.get("first_check_s") is None and e.get("check_every_s") is None
        item = Item("long_steps", f"{e['recipe_id']} step {e['step']}",
                    "nothing to check" if quiet else f"every {(e.get('check_every_s') or 0) // 3600} h", e.get("note"))
        days = seconds // 86400
        item.add(capped(int(days), 4, REACH_CAP), f"{days} day{'' if days == 1 else 's'} of unattended time"
                 if days else "under a day")
        if quiet and days >= 1:
            item.add(SOLE_ANSWER, "a day or more with nobody told to look: worth a second opinion")
        items.append(item)
    return items


TABLES = {
    "shelf_life": ("data/shelf_life.json", shelf_life_queue),
    "substitutions": ("data/substitutions.json", substitution_queue),
    "nutrition": ("data/nutrition.json", nutrition_queue),
    "scaling": ("data/scaling.json", scaling_queue),
    "long_steps": ("data/long_steps.json", long_step_queue),
}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--table", choices=sorted(TABLES))
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--recipes", default="data/recipes")
    args = ap.parse_args(argv)

    recipes = corpus(args.recipes)
    items = []
    for name, (path, fn) in TABLES.items():
        if args.table and name != args.table:
            continue
        items.extend(fn(load(path), recipes))

    items.sort(key=lambda i: (-i.score, i.table, i.key))
    if args.json:
        print(json.dumps([i.as_dict() for i in items], indent=2, ensure_ascii=False))
        return 0

    unread = [i for i in items if i.score == 0]
    print(f"{len(items)} curated rows across "
          f"{len({i.table for i in items})} table{'' if args.table else 's'}. "
          f"{len(unread)} of them nothing in the corpus ever reaches.\n")
    print("Ranked by what it would cost if the row were wrong — reach, consequence, care — and never")
    print("by how likely it is to be wrong, which nobody can compute.\n")

    for n, item in enumerate(items[: args.top], 1):
        print(f"{n:3}. [{item.score:3}] {item.table}: {item.key}")
        print(f"       {item.summary}")
        for points, why in item.points:
            print(f"       +{points:<4}{why}")
        if item.note:
            note = item.note if len(item.note) < 150 else item.note[:147] + "..."
            print(f"       note: {note}")
        print()

    if unread and not args.table:
        print(f"{len(unread)} rows nothing reaches. They are not wrong, they are unused, and they are")
        print("the last thing worth anybody's time:")
        print("  " + ", ".join(f"{i.table}:{i.key}" for i in unread[:8]) + (" ..." if len(unread) > 8 else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
