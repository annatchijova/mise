---
name: pantry-by-voice
description: Record what someone says about their food into the Mise pantry - bought, used up, corrected, or gone. Use when a person states what they have ("I've got two onions", "the tofu expires Friday"), says they used something ("I finished the lentils"), corrects an amount ("actually there are three"), or reports something is gone. Covers choosing between the four modes, what to pass for an amount nobody stated, and why an unrecognized food is read back instead of guessed.
license: Apache-2.0
compatibility: Requires the Mise MCP server over Streamable HTTP and a linked account.
---

# Recording the pantry from speech

The `pantry_update` tool appends to an append-only ledger. It does not edit items, because there are
no items - there is a history, and the current pantry is folded from it. Every call is one more fact
in that history, so a wrong call is not overwritten later, it is contradicted later.

## Choosing the mode

`mode` is the whole decision. Get it from the tense and the intent, not from the food.

| They said | mode | Why |
|---|---|---|
| "I bought", "I've got", "there's", "put away" | `add` | New food arrives |
| "I used", "I finished", "we ate" | `consume` | Some was taken away; the rest stays |
| "actually there are three", "no, it's two litres" | `correct` | States the true amount *now*, replacing what we thought |
| "it's gone", "we're out", "I threw it out" | `remove` | All of it is gone; no amount needed |

`consume` subtracts. `correct` replaces. Confusing the two is the common error: "there are three left"
after cooking is a `correct`, not a `consume` of three.

## What to pass

Pass `name` **as the person said it**. The server resolves it against a versioned alias table; that
mapping is its job, not yours. Do not translate, normalize, singularize, or improve the word.

- `qty` - only if they stated a number. If they did not, leave it out.
- `unit` - only from the closed list: `g`, `kg`, `ml`, `l`, `tsp`, `tbsp`, `cup`, `pc`, `clove`,
  `pinch`, `slice`, `bunch`, `can`, `sachet`, `to_taste`. Use `pc` for a plain count. Anything
  outside the list is rejected.
- `expires` - `YYYY-MM-DD`, and only if they gave a date. Resolve "Friday" to a real date against
  today before sending; never send the word.
- `location` - `fridge`, `freezer`, `pantry`, or the place they named.

## Never invent an amount

If nobody said how much, send no `qty`. The pantry stores that as "some, amount unknown" and reports
it that way forever after. An invented number becomes a fact in the ledger that no later event
corrects, because nothing contradicts a number that was never questioned.

The same rule covers ranges and prose. "A couple of onions" and "a handful of rice" carry no amount.

## When a food is not recognized

The response has two arrays. `recorded` is what landed. `rejected` lists what could not be placed,
each with a reason. Read the rejected ones back to the person in your own words and let them
rephrase. Do not substitute the nearest food you do know, and do not silently drop them - a pantry
that quietly loses items is worse than one that admits it did not understand.

A bad amount, unit, or date rejects **that item only**. The rest of the call still lands.

## No linked account

`pantry_update` returns an error asking to link the account. Say that plainly and offer what does
work without one: searching recipes.
