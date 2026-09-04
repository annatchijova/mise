---
name: pantry-confidence
description: Say out loud how sure the Mise pantry is about each item, and what is about to go off. Use when reporting what someone has, when a connected fridge or a barcode scan contributed the information, when an amount is unknown, when an item has not been confirmed in a while, or when asked what to use up. Covers the confirmed/inferred/stale vocabulary, the expiry bands, why an unknown amount is never spoken as a number, and the rule that a total is only as certain as its least certain part.
license: Apache-2.0
compatibility: Requires the Mise MCP server over Streamable HTTP and a linked account.
---

# Saying how sure the pantry is

`pantry_list` returns every item with a `confidence`, a `freshness`, and the `origins` that produced
it. Those fields exist to be spoken, not filtered out. An add-on that reports a fridge camera's guess
in the same voice as a person's own words is the failure this design is built to avoid.

## The three confidences

- **`confirmed`** - a person said it, or a barcode was scanned. Speak it plainly: "you have two
  onions".
- **`inferred`** - something recognized it without being told. A fridge camera sees that there are
  tomatoes; it does not see how many or until when. Mark it: "the fridge reported tomatoes".
- **`stale`** - nobody has confirmed this in a while. Derived from the clock, not stored, so it can
  become true without any new event. Mark it: "you had rice, but nothing has confirmed it in days".

A person's own word beats an inference. When someone corrects what the fridge reported, the
correction wins and the item becomes `confirmed`.

**A total is only as certain as its least certain part.** If a quantity was built from one confirmed
event and one inferred one, the whole item is `inferred`. Do not report the confirmed half as if it
stood alone.

## The expiry bands

`freshness` is computed from `days_to_expiry`:

| Value | Meaning |
|---|---|
| `expired` | the date has passed |
| `urgent` | within 1 day |
| `soon` | within 3 days |
| `fresh` | beyond that |
| `unknown` | no date was ever given |

`unknown` is not `fresh`. An item with no expiry date is not known to be good - it is simply not
known. Say "I don't have a date for the tofu", never "the tofu is fine".

For "what should I use up", `filter: "expiring_soon"` returns `expired`, `urgent` and `soon`
together. Lead with `expired`, since that is the one that changes what they do next.

## Unknown amounts are never a number

An item with `qty_known: false` has `qty: null`. Speak it as "some spinach, amount unknown". Never
render it as zero, never guess, and never quietly leave it out of the list. Zero and unknown are
different claims, and only one of them is true.

`filter: "unknown_amount"` lists exactly these, which is the useful answer to "what do you not know
about my pantry".

## Origins and invalid events

`origins` names what produced an item - voice, a fridge, a barcode, a checkout. Use it when the
person questions an item: "that came from the fridge, not from you" is the answer that settles it.

`invalid_events` counts ledger entries the fold could not use. It is zero in normal operation. If it
is not zero, something got past boundary validation: report the pantry as usual, and do not pretend
the count is fine.
