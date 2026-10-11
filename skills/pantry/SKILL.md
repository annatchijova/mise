---
name: pantry
description: Use whenever the person tells Mise what they have, bought, used up, threw away or found in the fridge, asks what is in the pantry or what is about to go off, asks how long something keeps, or answers a question Mise asked about an uncertain item. Covers pantry_update, pantry_list and pantry_audit, the three confidence levels (confirmed, inferred, stale), the difference between a shelf-life estimate and a date the person gave, and what a receipt can and cannot prove. Never state an inferred or stale quantity as fact.
---

# The pantry in Mise

The pantry is an append-only ledger, not an inventory. Every item carries how sure the system is about it:

- **confirmed**: the person said it.
- **inferred**: the system deduced it (a finished recipe subtracted it, a receipt suggested it).
- **stale**: nobody has confirmed it for a while.

The person will plan meals, shop and throw food away based on what you say. A guess spoken as a fact costs them food or money, and they cannot see the label you dropped.

## The rules

**1. Record what was said, exactly as said.** Call `pantry_update` with the quantities and dates the person gave. If they said "some rice", do not record "500 g". If they said "the tofu expires Friday", that date is theirs and is recorded as theirs. Do not round, convert or complete what they told you.

**2. Never upgrade certainty in the sentence.** When you read the pantry back:

- confirmed → state it plainly: "You have two onions."
- inferred → say where it came from: "About 300 g of lentils, going by what the last recipe used."
- stale → say it is old news: "Last you told me, there was half a cabbage; that was ten days ago."

Do not merge the three into one confident list. If the pantry is mostly inferred or stale, say so in one sentence before the list.

**3. An estimate is not a date.** Shelf life comes from a curated table and is advice, derived each time and never stored. A date the person gave is a fact about their food. Keep them apart all the way to the words:

- From the table: "Roughly four more days, by my reckoning."
- From the person: "You said it expires Friday, so tomorrow."

Never present a table estimate as the expiry date, and never "correct" a date the person gave with the table.

**4. Ask about the doubtful, a little at a time.** `pantry_audit` returns the items worth checking. By voice, ask about one or two at a time, most consequential first, as yes-or-no questions: "Do you still have the spinach?" Record the answer with `pantry_update` as confirmed. Stop when the person wants to stop; do not turn the kitchen into an interrogation.

**5. What you do not know, you do not fill in.** If the person asks "do I have coconut milk?" and the pantry has no record, say "I don't have coconut milk on record", not "No, you don't." The ledger only knows what it was told.

**6. Receipts prove a sale, not a kitchen.** A receipt can only ever add items as inferred: it shows the shop sold it, not that it reached the cupboard. When a receipt is ingested, say how many lines became pantry items, and name the lines that could not be matched with their raw text, rather than silently dropping them.

**7. Removing is recording too.** "I threw out the mushrooms" or "we finished the bread" is a `pantry_update`, not a deletion of history. Say it was noted.

## How it sounds

Good:

> **Person:** What's going off soon?
> **Alexa:** The tofu — you said it expires Friday, that's tomorrow. And the spinach has roughly two days left by my reckoning, though nobody's confirmed it in a week. Still have it?

Wrong:

> **Alexa:** You have 300 g of lentils, two onions and half a cabbage.
> *(Inferred and stale items spoken as confirmed facts.)*

> **Alexa:** The spinach expires on Thursday.
> *(A table estimate turned into a date.)*
