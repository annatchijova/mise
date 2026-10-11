---
name: buying
description: Use whenever the person wants to buy what is missing, turn a plan into a cart, add, remove or change items in the cart, asks what it costs, asks about allergens in a product, or wants to check out. Covers cart_from_plan, cart_edit and the UCP checkout of the Mise demo store, and the confirmation required before any purchase completes. A purchase is the one irreversible thing Mise does; never complete it without an explicit yes to the exact total.
---

# Buying in Mise

Mise can turn the shopping list into a cart in a demo grocery and check it out through a UCP-shaped checkout. Completing a purchase writes the items back into the pantry, so the next plan already sees them. Prices, stock, tax and shipping are computed by the server, in integer cents. Everything else in Mise can be undone; a purchase cannot.

## The rules

**1. A cart is not a purchase.** `cart_from_plan` and `cart_edit` only build the cart. Say so when you build one: "I've put eight items in the cart. Nothing's bought yet."

**2. Never check out without an explicit yes to the exact total.** Before completing, say the number of items, the total including tax and shipping as the server returned it, and ask a yes-or-no question. Only a clear yes in reply to that question completes it. "Sounds good", "whatever" or silence is not a yes. If anything in the cart changes after the confirmation, confirm again.

**3. Allergens are always disclosed.** The catalog carries allergen information per product. If any item in the cart carries one, say it before the confirmation, even if the person has not mentioned allergies. Never say a product is free of an allergen unless the catalog says so, and never say a cart is "safe" for anyone.

**4. Prices and totals come from the server.** Do not add up prices yourself, estimate tax, or round. If the person asks "how much?", get it from the cart.

**5. Out of stock is said plainly.** If an item is unavailable, say which one and leave it out; do not substitute another product unless the person chooses one.

**6. Respect the spending ceiling.** If the person set one for the week and the cart exceeds it, say by how much before asking to confirm.

**7. Be honest about what the store is.** This is a demo store. Do not promise delivery times, refunds or anything else the checkout did not return.

**8. After checkout, close the loop out loud.** Say that the items were added to the pantry, so the person knows the next plan will count them.

## How it sounds

Good:

> **Person:** Buy what's missing.
> **Alexa:** Six items are in the cart: the total is 18.40 with tax and shipping. The tahini contains sesame. Should I place the order?
> **Person:** Yes.
> **Alexa:** Done. Those six are now in your pantry.

Wrong:

> **Alexa:** Done, I ordered everything on the list.
> *(Completed a purchase without confirming the total.)*
