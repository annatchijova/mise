# Reading a receipt

A receipt is the cheapest complete record of what entered a house that exists. Nobody scans, nobody
photographs, nobody lists anything out loud: the shopping already produced the document. It is also
the messiest input this project takes. `CHKPS 400G` is chickpeas, `2 X TOMATOES` is two of something
sold by the piece, `BANANAS 0.842kg @ 2.19/kg` is a weight, and a good half of what is printed is not
food at all.

The obvious thing to do with a mess like that is hand it to a model. Two reasons this does not.

The first is the thesis of the whole server: Alexa+ is the model, this is data and deterministic
logic, and a pantry that guesses is worse than no pantry — a wrong count is trusted exactly as much
as a right one, and nobody knows which they have.

The second is narrower and sharper. A receipt is **evidence**, and the value of evidence is that it
can be checked. A parser with a written grammar can be told it is wrong, in public, by anyone who
reads this page and disagrees with a rule. A reading cannot.

## The door

Receipts arrive at `POST /ingest/receipt-app`, the same signed door every connected source uses:
HMAC signature, `Idempotency-Key`, confidence clamped to the source's ceiling. There is deliberately
no `receipt_*` MCP tool — an integration is a producer of pantry events, never something on the
Alexa+ response path.

```json
{
  "text": "…the receipt, unedited, newlines and all…",
  "purchased_at": "2026-09-04T18:42:00.000Z",
  "merchant": "La Esquina",
  "location": "pantry"
}
```

`purchased_at` is when the shopping happened, not when the receipt was pasted, and events are stamped
with it: a receipt is often days old and the ledger should not pretend otherwise. `location` defaults
to the pantry and is the person's to say.

## Where a line can end up

Every line of the input ends up in exactly one of three places, and there is a test that says so.

| | |
|---|---|
| **an event** | the line yields a food this kitchen has an id for |
| **unmapped** | plainly a purchase, but the name resolves to nothing. Reported with the raw text: that is a missing alias, and somebody can add one to `data/source_aliases.json` |
| **skipped** | the grammar recognises it as something that is not a purchase, reported **with the rule that skipped it** |

Skipped lines carry their rule because a receipt format we read badly must not look like a short
shop. Fifteen lines skipped as `no_price` is a bug report; fifteen lines quietly missing is not.

## The grammar

Rules apply in a fixed order, and the order is part of the contract.

1. **A line with no price is not a purchase.** This is not a heuristic about layout — it is what a
   receipt is. The shop charged for it, so it printed what it charged. It also disposes of
   everything around the shopping (the shop's name, its address, its footer, a loyalty message)
   without a list of things nobody could finish enumerating.
2. **The price comes off first**, so `CHICKPEAS 400G 1.29` never reads `1.29` as a quantity or `400`
   as a price.
3. **A unit price is removed and not read.** `@ 2.19/kg` beside a total of `1.84` would give 0.84 kg,
   and we could work that out. We are not entitled to: a quantity nobody printed is one we
   calculated, and a pantry that calculates can be wrong quietly.
4. **A leading count** — `2 X `, `3x `, `2 @ ` — is a count of pieces.
5. **A printed weight or volume beats a count** rather than multiplying it. `2 X CHICKPEAS 400G`
   bought 400 g twice over, and that two packs is 800 g is a fact about packaging we do not have. The
   amount wins: understating beats inventing.
6. Kilograms and litres are converted to grams and millilitres **at this boundary**, never in the
   fold, for the reason `canonicalAmount` exists: half a kilo of lentils and the 250 g a recipe takes
   out must not be two lines that never meet.
7. What remains, with shop codes and punctuation stripped, is the name, and it goes through the same
   resolver every other source uses.

A line with no amount printed becomes an event with `qty_milli: null` — "some, amount unknown", which
the ledger already understands and which is simply the truth. The receipt says you bought tomatoes.
It does not say how many.

### What the grammar refuses

- **Centilitres, ounces and pounds** produce no amount rather than a converted one. A centilitre we
  could convert exactly and choose not to; an ounce is not exactly anything useful without knowing
  what it measures.
- **A currency printed without decimals** is not read as a price, because `CHICKPEAS 400` would then
  be a price and a pack size at once. Such a receipt fails loudly, every line at once.
- **A shop that prints prices on their own line** fails the same way, and for the same reason it is
  better than the alternative: every item comes back as `no_price` instead of quietly missing.

The `price_cents` on a parsed line is carried for a person to check against, and is never used to
work out an amount.

## Why a receipt may only say `inferred`

This is the interesting decision, and the ceiling enforces it whatever an adapter tries to claim.

A barcode scan may say `confirmed`: a person held the thing and put it away. A receipt is a document,
and it proves something narrower than it appears to — **the shop sold it**. It does not say the food
reached this kitchen, that it was for this household, that it was not eaten on the way or given to
somebody, or that the abbreviation on line 7 means what the alias table thinks it means. Every one of
those gaps is small. The point is that nobody checked them.

So `inferred` here is not a hedge, it is a hook. The pantry audit asks about inferred lines, so a
receipt puts food in the pantry *and* puts a question in the queue:

> The chickpea came off a receipt, so I know it was bought but not that it is still there. Is it
> still there?

The person answering that is what makes the line `confirmed`, and nothing else should be.

## Trying it

    node dist/server.js   # with INGEST_SECRET and DEMO_USER set

then sign the body with `sign(secret, body)` from `src/integrations/ingest.ts` and post it with an
`Idempotency-Key`. `test/fixtures/receipt.txt` is a receipt with a header, a footer, a separator, a
weight, a unit price, a bare price, a barcode line and one food nothing recognises, which is roughly
what a real one looks like.
