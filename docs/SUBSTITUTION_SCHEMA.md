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
