# Which row should somebody read first

`docs/BLOCKED.md` §H says two of the curated tables need a cook to read them end to end. There are
now five, carrying 389 rows of somebody's judgment between them. "Read it end to end" is the correct
instruction, and it is also the one nobody follows: 389 rows is a weekend, and the reader has no idea
which of them are load-bearing.

    python3 scripts/review_queue.py [--table <name>] [--top N] [--json]

## What it ranks by, and what it refuses to

It does **not** rank by how likely a row is to be wrong. Nobody can compute that, and a confidence
number attached to a person's professional judgment would be exactly the invented certainty this
project is arranged against — worse here than anywhere else, because it would be a model grading a
cook.

It ranks by **what it would cost if the row were wrong**, which is a different question and is
computable:

| | |
|---|---|
| **Reach** | How many times the row actually answers something, measured by running the real lookups over the real corpus. A row nothing ever reads is not worth anybody's Saturday, however uncertain it is. |
| **Consequence** | Whether being wrong changes what somebody does. A shelf-life row under a week moves a meal in the plan; a 365-day row decides nothing. A substitution row with nothing wider behind it is the only answer there is. |
| **Care** | Whether wrong here is a safety matter rather than a dinner matter. Curated per row, never detected. |

Every point is itemised with what produced it:

```
  1. [113] shelf_life: garlic-oil / fridge
         7 days in the fridge
         +3   1 recipe line uses it
         +10  the only row for it, so nothing here cross-checks it
         +100 marked a safety matter: Garlic under oil is an anaerobic, low-acid environment...
```

A ranking nobody can argue with row by row is not a ranking, it is an opinion with a number on it.

## `caution`: the one thing that is not computed

A shelf-life row may carry `caution: true` and a `caution_reason`. It outranks everything, by a
distance, so that no amount of popularity can push it down the list.

It is **curated and never sniffed out of a note**. Most of the "never" advice in the shelf-life table
is about texture — *never the fridge, it stales faster there* — and a keyword search would drag all
of it up alongside the one row that is genuinely about botulism. Deciding which is which is a
person's job, and the validator enforces that anyone making that call writes down why: a flag with no
reason is a flag nobody can act on.

Exactly one row carries it today, the one §H.1 already names by hand. That is a fact about this
corpus, not a sign the field is unnecessary — a table that cannot say *this one is a safety matter*
loses the distinction the moment a second such row is written.

## Recording that somebody read a row

Until now a row a cook had read and confirmed looked exactly like a row nobody had ever opened. Both
just sat there being equally authoritative.

    python3 scripts/review_sign.py <table> <row> --verdict confirmed --note "..."
    python3 scripts/review_sign.py <table> <row> --verdict corrected --set days=7 --note "why"
    python3 scripts/review_sign.py <table> <row> --verdict unsure --note "what the doubt is"
    python3 scripts/review_sign.py --status

The row key is the one the queue prints. Three verdicts:

| | |
|---|---|
| **confirmed** | right as it stands |
| **corrected** | it was wrong and has been changed. `--set` changes it in the same act, so the new value and the sign-off cannot disagree. A `corrected` that corrects nothing is refused — that is a `confirmed` with a misleading name |
| **unsure** | a cook read it and will not sign it off. **Not a failed review.** It is better information than the row had before, it must say what the doubt is, and it ranks the row **up** rather than clearing it |

### A review says what it reviewed

The record carries a `row_digest` — a hash of the row as it stood when it was read.

Without it the mechanism would be worse than nothing: somebody changes 7 days to 14 a year later and
the row still carries a cook's name against a number they never saw. So the digest is checked rather
than trusted. A row whose content has moved comes back into the queue and says *why* it came back,
which is different from looking never-reviewed:

```
  reviewed by the author's kitchen on 2026-09-06, but the row has changed since:
  the sign-off no longer covers what it says now
```

A stale review is not misconduct and not an error — it is the ordinary life of a table.
`validate_reviews.py` reports it; nothing fails.

### What a review does not do

**It does not bump the table's version.** `version` means the advice changed, and it travels in every
response so a recorded answer can be tied to the advice that produced it. Reading a row and agreeing
with it changes no advice; bumping the number for every sign-off would turn it into noise and break
the one thing it is for. Only `corrected` bumps it.

### In the published data

Rows carry their `reviewed` block through to `/data` untouched, and the `_published` header says how
many records a table holds — worded as a **count of records**, not as a claim that each still
applies. Verifying that is what each row's own `row_digest` is for. Checking those digests in
TypeScript would put a third copy of the canonical-JSON rule in a third language, which is how one
rule becomes three.

## The drift guard

Measuring reach honestly means walking the same lookup chains the server walks, and the script is
Python while the server is TypeScript. Two copies of a rule are two rules that drift.

So `test/review_queue.test.ts` runs the real `substitutionsFor` over the real corpus, runs the
script, and asserts they credit **the same rows with the same counts** — 84 rows, exactly. If
somebody changes the chain in one place and not the other, the build fails rather than the queue
quietly ranking by a rule the server no longer uses.

**What that guard cannot do**, stated because it is easy to believe it is stronger than it is: it
only catches drift at a chain level the corpus actually reaches. The table has no ingredient-only
rows at all today, so deleting that level from the script changes nothing and the guard would not
notice — verified by trying it. A second test pins the levels currently exercised
(`ingredient+role+technique`, `role+technique`, `role`), so the guard's real strength is written
down and moves visibly when the table does.

## What reach cannot see

Reach is measured over the corpus, by walking the real chain for every `(ingredient, role,
technique)` a recipe actually contains. That misses one real path: somebody asking *"what instead of
tahini?"* with no recipe in play. No recipe here uses tahini, so its two rows answer nothing the
corpus can count — and they exist precisely for that question.

Rows like those are named separately in the queue rather than reported as unreached, because a row
that looks dead is a row somebody deletes. They are the ingredients listed in the table's own
`extra_ingredients`, which is what that field means.

## Reading the tail

The queue ends with the rows nothing reaches — 67 of 389. They are not wrong, they are unused, and
they are the last thing worth anybody's time. Most are the `long_steps` rows that say *there is
nothing to check here*, which is exactly where a row that decides nothing ought to rank.
