# The demo store — data contract and checkout surface

> The catalog is `data/catalog.json`, loaded by `src/store/catalog.ts`. The cart is
> `src/store/cart.ts`, the checkout is `src/store/ucp.ts`, the tools are `src/tools/cart.ts`. The
> validator is `scripts/validate_catalog.py` (run by `npm run validate`) and the tests are
> `test/store.test.ts`.

There is no documented way for an Alexa+ add-on to buy Amazon Fresh or Whole Foods products, so
"purchase capability" means running a shop of your own (`docs/PLAN.md` §01). This is that shop: about
a hundred SKUs covering the ingredients the recipes use, priced in integer cents, with real stock
counts and declared allergens.

## Two rules

**Money is an integer number of cents, everywhere.** No price, tax rate, or total is ever a float.
The tax rate is stored in basis points (`850` = 8.5%) and applied once, to the subtotal, so a receipt
can never be a cent away from its own lines. The validator fails a catalog that breaks this.

**The catalog is the only source of prices.** A UCP Create call arrives carrying line items an agent
chose; the amounts are looked up here and the request's own numbers are ignored. A store that trusts
the price it is handed is one crafted payload away from selling everything for a cent — and
`test/store.test.ts` sends exactly that payload.

## A SKU

```json
{
  "id": "sku-red-lentil-500g",
  "title": "Red lentils, 500 g",
  "ingredient_id": "red-lentil",
  "pack": { "qty": 500, "unit": "g" },
  "price_cents": 289,
  "stock": 40,
  "allergens": []
}
```

| Field | Rule |
|---|---|
| `id` | `sku-<kebab-case>`, unique. |
| `ingredient_id` | A canonical ingredient some recipe cooks with, or one the substitution table names. A renamed ingredient fails the build rather than quietly orphaning a SKU. |
| `pack` | What one unit of purchase contains. The unit must be one a shop can sell by — grams, millilitres, pieces, cloves, bunches, cans, sachets — never `to_taste` or `pinch`. |
| `price_cents`, `stock` | Positive integer, non-negative integer. |
| `allergens` | From a closed vocabulary: gluten, soy, sesame, nuts, peanut, mustard, sulphites, celery. The disclosure groups on exact names, so a spelling variant is an error, not a nuisance. |

## Turning a shopping list into a basket

`packsFor` rounds up, because half a bag is not a thing a shop sells. The order of its two checks is
the whole design:

- **An amount nobody stated buys one pack, whatever the units say.** Half the recipes in this book
  season "to taste", and a basket that refuses to buy the curry powder because a jar is measured in
  grams and the recipe is measured in willingness would be useless. The line comes back with
  `assumed_pack: true` and the tool says "one, because the recipe does not say how much".
- **An amount that *was* stated, in a unit the pack cannot be compared to, is refused.** Two cups of
  flour against a one kilo bag needs a density. Guessing one to produce a tidier basket is the error
  this codebase is arranged against, so the line goes to `unmapped` with the reason, and the cart
  reads it out.

The shop stocks about two thirds of the ingredients the corpus uses. The rest come back as "the shop
does not stock it" — a fact about the shop, reported rather than hidden.

## The checkout surface

Under `/store`, with the profile at `/.well-known/ucp`:

| Endpoint | What it does |
|---|---|
| `GET /.well-known/ucp` | Profile: version, `dev.ucp.shopping.checkout`, the `stored_payment_method` handler, the endpoints, the refund policy link, the TTL, and a disclaimer. |
| `POST /store/checkout-sessions` | Create. Validates SKUs and stock, prices from the catalog, returns the customer's stored instruments and an `expires_at` six hours out. |
| `GET /store/checkout-sessions/{id}` | Retrieve, for recovery. `Cache-Control: no-store`, like every response here. |
| `PUT /store/checkout-sessions/{id}` | Update. An address arrives, shipping and tax are recomputed, and the session becomes `ready_for_complete`. |
| `POST /store/checkout-sessions/{id}/complete` | Validates the instrument against the ones this session offered to this customer, takes the stock off the shelf, and writes `add` events into the pantry with origin `checkout`. |
| `POST /store/checkout-sessions/{id}/cancel` | State transition. Refuses on a paid order, because cancelling that is a refund. |

**Idempotency is a claim, not a check.** State-changing calls need an `Idempotency-Key`; the same
key with the same body replays, the same key with a different body is a 409, and a key still in
flight is a 409 telling the sender to retry. It reuses the exact claim/commit/release the pantry
ingest uses one layer down — a retried Complete cannot charge twice or restock the pantry twice.

**Commercial failures are 200 with a message; protocol failures are status codes.** Out of stock,
an item we do not sell, a payment method that is not ours: 200, with the session and a `messages[]`
entry, because an agent-driven checkout needs to say something useful rather than throw. No token,
no idempotency key, no such session: 401, 400, 404.

**Allergens are disclosed with `presentation: "disclosure"`**, computed from the SKUs actually in the
basket, at Create and again on the completed order. Showing "contains sesame" before somebody
commits is the kind of thing a cook notices.

**Completing writes to the pantry** — `add`, origin `checkout`, confidence **confirmed**. This is the
one non-voice source that earns `confirmed`: the customer did not say it, but the shop knows what it
put in the box, and a receipt is evidence. That write is the loop closing, and the next `plan_week`
already sees it.

## What is not verified

The wire format follows the summary of UCP recorded in `docs/PLAN.md` §06. It has **not** been
checked field by field against the specification, and it has never spoken to a real Alexa+ client,
because neither was reachable from where this was written. `docs/BLOCKED.md` keeps that admission
with the rest of them, and the profile itself carries a `disclaimer` field saying so, so that nobody
integrates against this by accident.

Authentication is a shared secret: `UCP_TOKEN` in the environment, matched against the bearer, with
the demo account behind it. It is not OAuth and it is not per-user. Block B of the plan replaces it
with the real access token; until then, the store is closed unless that variable is set.
