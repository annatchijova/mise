# The shelf-life table — data contract

> The file is `data/shelf_life.json`. The lookup is `src/pantry/shelf_life.ts`, the derivation is in
> `src/pantry/fold.ts`, the validator is `scripts/validate_shelf_life.py` (run by `npm run validate`),
> and the tests are `test/shelf_life.test.ts`.

## The problem it solves

The pantry only ever learns a real expiry date when somebody states one — the person says "the tofu
expires Friday", or a package carries a date. In practice that is almost never. Which left the
planner's best pass, the one that schedules food on the last day it is still good, with almost
nothing to work on: an empty deadline queue and a week built entirely on coverage.

This table fills that in. It is 149 curated rows saying how long each food keeps, and where.

## The rule that makes it safe

**An estimate from this table can never become a date somebody gave.**

That is not a style preference; it is the only thing standing between "advice about your spinach" and
"a fact this system invented about your spinach". It is enforced structurally, in three places:

1. **Nothing is stored.** No event ever carries a number from this table. The estimate is *derived at
   read time* by the fold, exactly the way `stale` is derived from the clock. There is no path by
   which it can be written back into the ledger and later read as though a source had said it.
2. **The fields are separate.** `expires_on` holds only what a source actually stated and is left
   `null` otherwise; `expiry_estimated_on` holds what the table worked out; `expiry_source` says
   which of the two `days_to_expiry` and `freshness` were computed from — `stated`, `estimated`, or
   `unknown`.
3. **The distinction survives to the sentence.** `pantry_list` says *"roughly four days by my
   reckoning"* for an estimate and *"expiring today or tomorrow"* for a stated date. The planner's
   reason says *"…which has roughly two days left by the shelf-life table — nobody gave it a date"*.
   The pantry page marks the row `estimate` and puts the table's own note in the tooltip. Nothing has
   to remember to add the hedge, because the hedge is chosen from the field.

A stated date always wins, and when one exists the table is not consulted at all.

## A row

```json
{ "ingredient": "spinach", "location": "fridge", "days": 4,
  "note": "Wilts from the stems in. Loose leaves go faster than a whole bunch." }
```

| Field | Rule |
|---|---|
| `ingredient` | A canonical id some recipe uses, or `null` on a wider row. |
| `role` | Only on a row where `ingredient` is `null`. Setting both is an error: the ingredient key would match first and the role would never be read. |
| `location` | One the table declares — `fridge`, `freezer`, `pantry` — or `null` for a row that answers anywhere. |
| `days` | A positive whole number, capped at 3650. Ten years is the ceiling because nothing in a kitchen is usefully described as keeping longer, and a bigger number is a slipped finger rather than a claim. |
| `note` | What a cook would add, or `null`. A note under ten characters is an error: a note that says nothing is worse than none. |

## The lookup, and where it stops

```
(ingredient, location)   →  ingredient+location
(ingredient, any)        →  ingredient
(role, location)         →  role+location
(role, any)              →  role
(any, location)          →  location        ← only the freezer row is this wide
```

The role comes from the recipe corpus: the role an ingredient plays most often, computed the same way
in the loader and in the validator so the two cannot drift. The match level travels with the answer,
so the pantry page can show *why* a number is what it is.

**A place the table does not know about gets no estimate at all.** The ledger allows any location —
"other:the second fridge in the garage", "other:the cabin" — and a lemon keeps three weeks in a fridge
and one week on a counter. In an unnamed place we genuinely do not know which, and answering anyway
would be exactly the failure this table is arranged against. The one exception is the freezer, which
has a catch-all row, because the freezer's answer really is the same for almost everything: six
months, and that is when texture and flavour have gone, not when it becomes unsafe.

## When the clock starts

From the day the food **arrived** — the first event that still contributes to that pantry line — and
not from the last time somebody touched it. Cooking with half the spinach on Thursday does not make
the other half younger. A `correct` or a `remove` restarts the line and therefore the clock, which is
right: "actually there are three" is a fresh statement about the food in front of you.

## What is said out loud, and what is not

An estimate is only spoken while it is near enough to change what somebody cooks — currently within
fourteen days. A two-year estimate on a bag of lentils is true and useless, and reading it out makes
the pantry list unlistenable. A date a person actually gave is always spoken, however far off. The
data carries both regardless; this is a narration rule, not a data rule.

## Coverage

The validator reports how many (ingredient, location) pairs the chain can answer for the corpus, over
the two everyday locations. It currently answers all of them, most through an ingredient row. Coverage
is a warning and never an error: an uncovered ingredient simply gets no estimated date, which is
precisely the state the pantry was in before this table existed.
