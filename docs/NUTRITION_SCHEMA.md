# `data/nutrition.json`

Round reference figures for whole ingredients, per 100 g, in the state each row names.

The dishonest version of this feature is easy to build and everybody expects it: sum what you know
and print a number. It is wrong nearly all the time, and the reason it gets away with it is that the
number never says which ingredients went into it.

This corpus makes that impossible to hide. It is home cooking out of books, and **284 of its roughly
500 ingredient lines say `to_taste`** — the recipe does not state an amount. No table fixes that. So
the honest tool here is mostly a refusal, and the work went into making the refusal useful.

## The three things a line can be

For each ingredient of a recipe, exactly one of:

- **counted** — we have figures for it and could turn its amount into grams;
- **a gap** — we could not, for one of three reasons, kept apart because different people fix them:
  - `no_amount`: the recipe does not say how much. *A fact about the recipe.*
  - `no_measure`: it is measured in a way we do not weigh — a slice of pumpkin, a piece of tofu.
    *A fact about the ambiguity of the measure.*
  - `no_data`: we have no row for it. *A fact about this table.*
- **exempt**, in one of two ways that are deliberately not merged:
  - `ignored_as_trace`: a curator marked it as used in amounts too small to count. **Somebody's
    judgment**, and it applies only when the recipe measures it as a trace amount (`to_taste`,
    `pinch`, `tsp`, `tbsp`). A stated 200 g of cumin is not a pinch however the table describes cumin.
  - `contribute_nothing`: every figure in its row is zero, so no quantity of it can change what the
    dish comes to. **Arithmetic**, not judgment. Water and salt. Not knowing how much water is in a
    soup must not stop us adding the soup up.

Blurring the last two would hide which of the two a reader is being asked to trust.

## When there is a total, and when there is a floor

A total is produced **only when there are no gaps at all**. Not "most", not "enough" — a threshold is
just a smaller lie, and the person reading a calorie figure has no way to see which side of it their
dinner fell on. Three of the 49 recipes here clear that bar.

For the rest, there is something better than a hedge: a **floor**.

> At least 284 calories a serving, and I mean at least: that is the 5 of 6 ingredients I can account
> for, and the rest can only add to it. I stop short of a total because I have no figures for plant
> milk powder.

"At least" is not a weaker guess. It is a *different claim*, and one that is provable: every
ingredient contributes a non-negative amount, so the dish cannot come to less than the sum of the
ones we could weigh. "About" would not be provable. 32 of the 49 recipes get a useful floor; 14 get
nothing at all, and say so.

## A row

```json
{
  "id": "chickpea",
  "name": "chickpea",
  "kcal": 364,
  "protein_cg": 1930,
  "carb_cg": 6100,
  "fat_cg": 600,
  "fibre_cg": 1740,
  "g_per_100ml": null,
  "measures": { "cup": 200 },
  "negligible": false,
  "source": "reference tables for raw ingredients",
  "note": "Dried, as bought. Cooked chickpeas weigh about three times this for the same food, so a recipe that means cooked is a different number."
}
```

- **Everything is an integer.** Macronutrients are in **centigrams** — hundredths of a gram — for the
  same reason the pantry keeps thousandths: these are summed over and over and must not drift.
- **`name` carries the state**, and it matters more than anything else in the row. "Chickpea" dried
  and "chickpea" cooked differ threefold, and a table that does not say which it means is worse than
  no table.
- **`g_per_100ml`** is what 100 ml of it weighs, for liquids. Null means we do not turn its volume
  into a weight.
- **`measures`** gives grams for one of a unit a recipe actually uses — a medium onion, a clove of
  garlic, a tablespoon of oil. These are reference figures a person wrote down, and the tool reports
  them as `measured` rather than `weighed` so they are never silently mixed in with a stated weight.
  Grams, kilograms, millilitres and litres are never curated here: those are arithmetic, and a row
  claiming otherwise is a bug wearing a fact's hat.
- **`negligible`** rows assert nothing at all — every figure is null — because a row that claims to
  be a judgment must not also look like a measurement.

### What is deliberately absent

An ingredient with no row is reported as having no figures, **never estimated from one that looks
similar**. Prepared foods whose values depend entirely on the brand are absent for that reason:
plant milk in general, vegan cheese, mayonnaise, whipped topping, stock, curry pastes, sweetener.
18 of the corpus's 168 ingredients have no row, and the tool names them when they block an answer.

Coverage is a measurement here, not a target. If every recipe could be totalled, the interesting half
of this feature would never be seen — and there is a test that asserts most of them cannot be.

### Measures we decline to curate

Some are ambiguous rather than merely unknown, and the row says so instead of picking one:

| | |
|---|---|
| a *piece* of garlic | a head to some people, a clove to others |
| a *slice* of pumpkin | a wedge off a squash of unknown size |
| a *piece* of tofu | blocks are sold from 200 to 500 g |
| *cups* of lemon | that means the juice, which is a different food |
| a *can* of hearts of palm | the drained weight is what goes in the dish, and tins do not agree on it |

## What the validator enforces

Errors, because they are mistakes nobody catches by reading:

- Ids kebab-case and unique; every non-trace row carries a name and a source.
- Every figure a non-negative integer.
- Protein, carbohydrate and fat cannot come to more than 100 g inside 100 g of food.
- `g_per_100ml` somewhere near what water weighs.
- A curated measure only for a unit that is genuinely ambiguous — never for `g`, `kg`, `ml` or `l`.
- A `negligible` row carries no figures at all, and says why it is one.

Warnings, because they are usually not mistakes:

- **Energy that does not follow from the macronutrients**, computed with the fibre taken out of the
  carbohydrate first so it is not charged twice. Alcohol trips this legitimately, so the warning is
  printed together with the row's own note — a warning a reader has to go and investigate every run
  is a warning they stop reading.
- A row for an ingredient no recipe uses, and the ingredients measured in a way we cannot weigh.

## Versioning

`version` is an integer, bumped whenever a figure changes, and it travels in every
`recipe_nutrition` response so a recorded answer can be tied to the figures that produced it.
These are somebody's curation and should be attributable, like every other table here.
