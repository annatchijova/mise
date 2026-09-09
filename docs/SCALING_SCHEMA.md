# The scaling table — data contract

> The file is `data/scaling.json`. The lookup and the arithmetic are `src/cook/scaling.ts`, applied
> in `misePlace` and `consumptionEvents`. The validator is `scripts/validate_scaling.py` (run by
> `npm run validate`) and the tests are `test/scaling.test.ts`.

## The problem it solves

`misePlace` multiplied every amount by servings over serves. That is right for the lentils and a lie
about the salt. Double a stew and you want roughly one and a half times the seasoning; triple a
batter and you need a second tin rather than a deeper one, and the recipe's baking time stops
describing it at all.

Scaling something a cook knows about is not arithmetic. It is a table.

## Damping: integers, and only ever downwards

A row's `damping` is a pair of integers saying how much of the *change* to apply:

```
scaled = base + (base × (servings − serves) × k_num) ÷ (serves × k_den)
```

`[1,1]` is straight multiplication and is what every ingredient no row covers still does. `[1,2]`
applies half the change: a hundred grams of salt for six becomes a hundred and fifty for twelve, not
two hundred. `[1,3]` is a bay leaf, where one does a big pot and three make it medicinal.

Everything stays in integer milli-units and is rounded exactly once, so a linear amount scaled up and
back down lands precisely where it started. There is a test that says so.

**A damping above 1 is an error, not a row.** It would mean an amount grows faster than the number of
people, and nothing does. The validator rejects it.

## The lookup

```
(ingredient)            →  ingredient
(role, technique)       →  role+technique
(role)                  →  role
(technique)             →  technique
nothing                 →  linear
```

Salt has a row of its own because salt is salt whatever it is doing. Cumin does not, and falls to
`spice / season`. Red lentils fall through everything and multiply straight, which is correct.

A row for a named ingredient must not also set a role or a technique: the ingredient key matches
first, so the rest would never be read. That is an error rather than a warning, because a row nobody
can reach looks like a decision that was made and is not.

## The half that is not a number

Some things do not scale because the equipment does not. `warn_above` and `warning` carry that: past
the factor, the row's warning is said out loud at `cook_start` and folded into no amount.

- Browning and frying past double: the pan's surface is the limit. Cook in batches or it steams.
- Baking past double: a second tin, not a deeper one — the recipe's time stops applying.
- Leavening past double: two doughs. One enormous rise is uneven.
- Whipping past double, emulsifying past quadruple, fermenting past triple: each for its own reason,
  written in the row.

A recipe with six things that all brown earns **one** warning about the pan, not six; the warnings
deduplicate on their text. A recipe cooked at or below the servings it was written for earns none —
cooking less is not a pan problem.

## Two rules the code enforces around it

**The pantry loses what the cook was told to use.** The deduction on `cook_finish` applies the same
damping the mise en place did. Taking twice the salt off a shelf that only lost one and a half times
as much would make the pantry quietly disagree with what the person was told to put in.

**An amount nobody stated is never reported as damped.** Saying "the water did not scale straight"
about a quantity the book never gave is noise dressed as care.

## Without the table

`misePlace` and `consumptionEvents` both take the scaling lookup as an optional argument. Without it
every amount multiplies straight — exactly what the code did before this table existed — so the table
can be removed, replaced or argued with without any of the machinery around it changing.
