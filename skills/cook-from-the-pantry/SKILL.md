---
name: cook-from-the-pantry
description: Suggest what someone can cook from the food they actually have, using the Mise pantry and recipe corpus. Use when a person asks what to cook, wants dinner ideas, asks what they can make with what is in the fridge, asks for a dish by name or by an ingredient, or wants something within a time limit. Covers the two-step order (read the pantry, then search), how to report what is missing without overstating what is on hand, and what still works when no account is linked.
license: Apache-2.0
compatibility: Requires the Mise MCP server over Streamable HTTP. recipe_search works without a linked account; reading the pantry first does not.
---

# Cooking from what is there

Two tools, in this order.

1. `pantry_list` - what they have right now.
2. `recipe_search` with those foods in `use_ingredients` - what that food can become.

Searching first and asking about the pantry afterwards inverts the point of the add-on: the corpus is
large and the pantry is small, so the pantry is what narrows the answer.

## Reading the result

`recipe_search` returns candidates ranked by how much of the dish is already on hand.

- `have_pct` - the share of the recipe's ingredients the given list covers.
- `missing` - what would still have to be bought.
- `minutes`, `serves`, `category` - for narrowing out loud.
- `total` - how many matched overall, which is usually more than you should read aloud.

Lead with the dish and what is missing, because that is the decision the person is making. Two or
three candidates is a spoken answer; ten is a list nobody can hold.

## Do not overstate what is on hand

An item can be in the pantry with `qty_known: false` - it is there, but nobody said how much. Such an
item may well be enough for the recipe, and it may not. Say "you have chickpeas, though I don't know
how many" rather than counting it as covered without comment. `have_pct` counts presence, not
sufficiency, and treating it as sufficiency is how this add-on would start lying quietly.

The same caution applies to anything `pantry_list` marks `inferred` or `stale`. See the
`pantry-confidence` skill for how to say those out loud.

## Time limits

`max_minutes` filters by total cooking time. Use it when they give one ("something quick", "I have
twenty minutes"). "Quick" with no number is not a number - either ask, or pick a sensible bound and
say which bound you used.

## Nothing matched

`total: 0` means no recipe fits. Say so and offer the nearest loosening you can name: drop the time
limit, or search without the pantry constraint. Do not invent a recipe. The corpus is a curated set
of the author's recipes, and a dish that is not in it does not exist for this add-on.

## No linked account

`recipe_search` works without one, so the whole "what could I cook" conversation still works if the
person names their ingredients out loud. Only reading the stored pantry needs an account. Offer that
path instead of refusing.
