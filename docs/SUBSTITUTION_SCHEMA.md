# The substitution table — data contract

> The file is `data/substitutions.json`. The loader is `src/substitutions.ts`, the validator is
> `scripts/validate_substitutions.py` (run by `npm run validate`), and the tests that hold the rules
> up are `test/substitutions.test.ts`.

Everything else in this server is derived: the pantry is a fold over events, the plan is a score, the
recipes are a structuring of a book that already existed. This table is the exception — a person sat
down and wrote what to use instead of what, and why it sometimes does not work. It is the one place
where judgment is the data, so it is the one place with the strictest contract.

## Why the key is a triple

"What can I use instead of oil?" has no answer. Oil frying an onion, oil in a mayonnaise and oil in a
cake are three different questions, and only the second one is ruined by using coconut oil. So the
key is **(ingredient, role, technique)** — what it is, what job it is doing, and what is being done
to it. `role` and `technique` come from the recipe data contract (`docs/RECIPE_SCHEMA.md`), which is
what lets the tool look up a specific answer from nothing but a recipe id and an ingredient name.

## The row

```json
{
  "ingredient": "flax",
  "role": "binder",
  "technique": "whip",
  "alternatives": [
    {
      "ingredient": "aquafaba",
      "ratio": [3, 1],
      "note": "Three tablespoons of aquafaba for one of ground flax; whips to soft peaks in a cold bowl.",
      "warning": "Aquafaba does not bind when hot — it thins out as soon as it warms. Cold preparations only."
    }
  ],
  "if_missing": "Nothing else here holds air. The dish will be dense; that is a texture, not a failure."
}
```

| Field | Rule |
|---|---|
| `ingredient` | Canonical id, or `null` for a role-level row (the general answer for "a fat, for frying"). |
| `role` | From the role vocabulary. Always present — a substitution with no role is a guess. |
| `technique` | From the technique vocabulary, or `null` for the widest row of a role. |
| `alternatives[]` | May be empty. An empty list plus a good `if_missing` is a complete answer. |
| `alternatives[].ratio` | `[numerator, denominator]` of **positive integers**, or `null`. Never a float: a proportion is 2/3, and 0.6666666666666666 is a rounding of it. `null` means the swap is not proportional, and then the note states the amount in words. |
| `alternatives[].note` | How to use it. Required. |
| `alternatives[].warning` | What goes wrong, or `null` when nothing does. Required as a key so that "nothing goes wrong" is something somebody decided rather than forgot. A warning that says nothing is worse than none. |
| `if_missing` | What to do when none of the alternatives is at hand. Required on every row. |

`extra_ingredients` at the top of the file names the ingredients the table mentions that no recipe
uses yet — aquafaba, tamari, baking soda — with the name a person would hear. The resolver loads
them too, because being out of tamari is a sentence someone can say even if no recipe here calls for
it.

## The fallback chain, and why it announces itself

`substitutionsFor` walks from the most specific key outwards:

```
(ingredient, role, technique)  →  ingredient+role+technique
(ingredient, role)             →  ingredient+role
(ingredient)                   →  ingredient
(role, technique)              →  role+technique
(role)                         →  role
```

The first hit wins, and the answer carries the level it was found at. This matters more than it
looks: "for olive oil in a marinade" and "for a fat, generally" are different claims, and the second
one narrated as the first is the system pretending to know something it does not. The tool passes
the level through to `structuredContent`, and the spoken text says *"nothing curated for olive oil
itself, but generally as a fat"* when that is what happened.

When the person names an ingredient and nothing else — Alexa+ heard "I'm out of tahini" with no
recipe in play — the lookup returns **every** context the table holds for it rather than picking one.
Choosing between "for frying" and "for a mayonnaise" is a conversation, and the conversation belongs
to Alexa+.

When there is no row at any level, the answer is an empty list, and the tool says so out loud. That
is the whole point of the table: the failure mode of a curated answer is silence, and the failure
mode of a generated one is confident nonsense.

## What the validator enforces

- Ids are kebab-case, and every id — key or alternative — is either an ingredient some recipe uses or
  listed in `extra_ingredients`. A renamed ingredient breaks the build instead of quietly making a
  row unreachable.
- Ratios are two positive integers or `null`. A float fails.
- No duplicate `(ingredient, role, technique)` key: two rows answering the same question means one of
  them is dead and nobody knows which.
- No row substitutes an ingredient for itself.
- Every alternative has a note; every warning that exists says something; every row has `if_missing`.
- **Coverage**, as a warning and never an error: which `(ingredient, role, technique)` triples the
  recipes actually use that the chain cannot answer at any level. An uncovered triple is not a bug —
  the tool will correctly say it has nothing curated — but the count is the honest measure of how far
  the table reaches. It currently answers all 274 triples in the corpus, most of them at role level.

## Versioning

`version` is an integer, bumped whenever a row's advice changes. It travels in every
`substitute` response, so a recorded demo, a bug report or a transcript can be tied to the exact
advice that was given. `updated_on` and `author` are there for the same reason: this is somebody's
professional judgment, and it should be attributable.

## How the table grows: a queue, not a feedback loop

A curated table's one weakness is that it stops growing. It holds what one person thought to write
down, and nothing that happens in anybody's kitchen ever reaches it. The fix everybody reaches for —
learn from what people do — is precisely what this project refuses: a table that quietly absorbs what
somebody did once is no longer a table anybody wrote, and its advice is no longer attributable to a
person who can be asked why.

So swaps people record while cooking go into a **queue for a curator**, at
`data/imports/swap_candidates.json` (or wherever `SWAP_LOG_FILE` points; unset it and the queue lives
in memory and is lost with the process, which costs nothing but the queue). Two rules hold the line:

1. **Nothing in the queue is ever consulted by `substitute`.** The tool reads `data/substitutions.json`
   and nothing else. The table grows when a person edits that file, and at no other moment. There is
   a test for exactly this, because it is the property the whole design rests on.
2. **A swap the table already suggests is a `confirmation`, not a `candidate`.** Somebody following
   the table's advice is evidence *for* a row, and worth counting separately: a row thirty people
   have followed is a different thing from a row nobody has tested.

A record is keyed on all four of `(instead_of, used, role, technique)`, so "chickpeas for broad beans,
simmering" and "chickpeas for broad beans, fried" stay apart — they are different claims, and a
curator would answer them differently. Each record keeps a count, a first and last sighting, and the
newest few notes **verbatim**, because what somebody actually said is the most useful thing in the
file.

### Names we do not keep

A swap only becomes a pantry deduction when both names resolve to ingredients we keep — half a swap
would deduct the wrong thing. The queue is deliberately the opposite: it takes the swap either way,
holds the unresolved side as the person said it, and lists it in `unresolved`. That is not a
degraded record, it is the most valuable one. A name that keeps turning up there is either an alias
nobody has written yet — one line in `data/source_aliases.json` — or a food the table has never heard
of, which needs a row. `scripts/review_swaps.py` prints those separately for that reason: it is
different work from judging whether a substitution is sound.

Because an unresolved name has no id, the table cannot have suggested it, so such a swap is a
candidate by construction rather than by a lookup that would always miss.

### Reviewing it

    python3 scripts/review_swaps.py [queue] [table]

prints the candidates most-seen-first, what the table says today for that key beside each one, and
the verbatim notes; then the names we do not keep; then the confirmations as counts. Acting on any of
it means editing `data/substitutions.json` by hand and bumping its `version`. The queue is generated
data and is not committed — only the curator's decisions are.
