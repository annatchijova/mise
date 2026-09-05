// The account web: the small set of pages for what voice cannot do.
//
// Alexa+ is the primary surface and it builds its own visuals from structuredContent; MCP Apps views
// (plan block F) are polish on top of that. These pages are something else: the places a person
// connects a source, drives the simulated fridge for the demo, and looks at the pantry with every
// badge the data carries. They are server-rendered, inline-styled, and read the same fold the tools
// read — there is no second model of the pantry.
import { displayName } from "./pantry/events.ts";
import type { Freshness, PantryItem } from "./pantry/fold.ts";
import { esc } from "./recipe_jsonld.ts";

export const SHELL_CSS = `:root{color-scheme:light dark;--fg:#1a1a1a;--dim:#6b6b6b;--line:#e3e0da;--bg:#faf9f7;--card:#fff;
--ok:#2f7d4f;--okbg:#e6f3ea;--warn:#8a6d3b;--warnbg:#fdf6e3;--bad:#a23b3b;--badbg:#f9e7e7;--mute:#6b6b6b;--mutebg:#eeece8}
@media(prefers-color-scheme:dark){:root{--fg:#e8e6e3;--dim:#9a968f;--line:#33312e;--bg:#171614;--card:#1f1e1b;
--ok:#7fcf9a;--okbg:#1d2f24;--warn:#d3b678;--warnbg:#2a2418;--bad:#e79a9a;--badbg:#341d1d;--mute:#9a968f;--mutebg:#26241f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 5rem}
h1{font:600 1.6rem/1.2 ui-serif,Georgia,serif;margin:0 0 .25rem}
.sub{color:var(--dim);margin:0 0 1.5rem}
h2{font:600 .78rem/1.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:2rem 0 .6rem}
nav{display:flex;gap:1.25rem;font-size:.85rem;margin-bottom:2rem}nav a{color:var(--dim);text-decoration:none;border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:.92rem}th{text-align:left;font-weight:600;color:var(--dim);font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;padding:.4rem .5rem;border-bottom:1px solid var(--line)}
td{padding:.55rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-block;font:600 .68rem/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;border-radius:3px;padding:.22rem .38rem;white-space:nowrap}
.ok{color:var(--ok);background:var(--okbg)}.warn{color:var(--warn);background:var(--warnbg)}.bad{color:var(--bad);background:var(--badbg)}.mute{color:var(--mute);background:var(--mutebg)}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;margin-right:.4rem;vertical-align:-.02rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:1rem 1.1rem;margin:.75rem 0}
label{display:block;font-size:.8rem;color:var(--dim);margin:.6rem 0 .2rem}input,select{font:inherit;padding:.4rem .5rem;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--fg);width:100%;box-sizing:border-box}
.row{display:grid;grid-template-columns:2fr 1fr 1fr 1.4fr;gap:.6rem}button{font:inherit;font-weight:600;padding:.5rem .9rem;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--fg);cursor:pointer;margin-top:.9rem}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}pre{background:var(--mutebg);padding:.75rem;border-radius:4px;overflow-x:auto;font-size:.8rem}
.empty{color:var(--dim);padding:2rem 0;text-align:center}.legend{font-size:.8rem;color:var(--dim);margin-top:1rem}.legend span{margin-right:1rem}`;

function shell(title: string, body: string, subtitle = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Mise</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<main>
<nav><a href="/pantry">Pantry</a><a href="/sim/fridge">Simulated fridge</a><a href="/recipes">Recipes</a></nav>
<h1>${esc(title)}</h1>
${subtitle ? `<p class="sub">${subtitle}</p>` : ""}
${body}
</main>
</body>
</html>
`;
}

const FRESH: Record<Freshness, [string, string]> = {
  expired: ["bad", "expired"],
  urgent: ["bad", "today or tomorrow"],
  soon: ["warn", "within 3 days"],
  fresh: ["ok", "fresh"],
  unknown: ["mute", "no date"],
};

const CONF: Record<string, string> = { confirmed: "ok", inferred: "warn", stale: "mute" };

function qtyCell(i: PantryItem): string {
  if (!i.qty_known) return `<span class="badge mute">amount unknown</span>`;
  if (i.unit === "to_taste") return "to taste";
  return `${i.qty} ${esc(i.unit)}`;
}

/** A date somebody gave is printed. A date the shelf-life table worked out is printed too, and
 *  marked, with the row that produced it as the tooltip — advice should be legible as advice. */
function expiryCell(i: PantryItem): string {
  const [cls, label] = FRESH[i.freshness];
  const light = `<span class="dot ${cls}" style="background:currentColor"></span>${label}`;
  if (i.expires_on) return `${light} <span style="color:var(--dim)">${esc(i.expires_on)}</span>`;
  if (i.expiry_source === "estimated" && i.expiry_estimated_on) {
    const why = i.expiry_note ? ` title="${esc(i.expiry_note)}"` : "";
    return `${light} <span style="color:var(--dim)"${why}>~${esc(i.expiry_estimated_on)}</span> <span class="badge mute">estimate</span>`;
  }
  return light;
}

export type SourceLine = { label: string; kind: string; synced_at: string | null };

/** The pantry, exactly as the fold sees it. Every reservation the data carries is on the page. */
export function renderPantryPage(items: PantryItem[], sources: SourceLine[], now: string, opts: { location?: string; invalid?: number } = {}): string {
  const invalid = opts.invalid ?? 0;
  const warning = invalid > 0
    ? `<div class="card" style="border-color:var(--bad)"><span class="badge bad">warning</span> ${invalid} ledger record${invalid === 1 ? "" : "s"} could not be read (bad timestamp or date) and ${invalid === 1 ? "is" : "are"} not shown. The pantry below is what the rest of the ledger says.</div>`
    : "";
  const locations = [...new Set(items.map((i) => i.location))].sort();
  const shown = opts.location ? items.filter((i) => i.location === opts.location) : items;

  const filter = locations.length > 1
    ? `<p class="sub"><a href="/pantry">all</a>${locations.map((l) => ` · <a href="/pantry?location=${encodeURIComponent(l)}">${esc(l)}</a>`).join("")}</p>`
    : "";

  const rows = shown.map((i) => `<tr>
<td>${esc(displayName(i.ingredient_id))}<br><span style="color:var(--dim);font-size:.8rem">${esc(i.location)}</span></td>
<td class="num">${qtyCell(i)}</td>
<td><span class="badge ${CONF[i.confidence]}">${esc(i.confidence)}</span></td>
<td>${expiryCell(i)}</td>
<td style="color:var(--dim);font-size:.8rem">${i.origins.map(esc).join(", ")}</td>
</tr>`).join("\n");

  const table = shown.length === 0
    ? `<p class="empty">Nothing here yet. Say something to Alexa+, scan a barcode, or drive the <a href="/sim/fridge">simulated fridge</a>.</p>`
    : `<table><thead><tr><th>Item</th><th class="num">Amount</th><th>Confidence</th><th>Expiry</th><th>Reported by</th></tr></thead><tbody>
${rows}
</tbody></table>
<p class="legend"><span><span class="badge ok">confirmed</span> you said it, or scanned it</span><span><span class="badge warn">inferred</span> a device or a recipe deduced it</span><span><span class="badge mute">stale</span> nobody has confirmed it in a while</span><span><span class="badge mute">estimate</span> no date was given; the shelf-life table worked one out</span></p>`;

  const sourceLines = sources.length === 0
    ? `<p class="sub">No connected sources. Voice only.</p>`
    : `<p class="sub">${sources.map((s) => `${esc(s.label)} <span style="color:var(--dim)">(${esc(s.kind)}${s.synced_at ? `, last report ${esc(s.synced_at.slice(0, 16).replace("T", " "))}` : ", never reported"})</span>`).join(" · ")}</p>`;

  return shell("Pantry", `${warning}${filter}${table}<h2>Sources</h2>${sourceLines}<p class="legend">As of ${esc(now.slice(0, 16).replace("T", " "))} UTC. Amounts never convert between units, and an unknown amount is never shown as zero.</p>`,
    `${items.length} line${items.length === 1 ? "" : "s"}, ordered by what goes off first.`);
}

/** What every account-bound page answers when there is no account to bind to. */
export function renderLinkAccountPage(): string {
  return shell("Link your account", `<div class="card"><p style="margin:0">This needs a linked account. Until account linking exists, set <code>DEMO_USER</code> to name the demo account; it is currently unset, so the pantry, the simulated fridge and the ingest sources are closed rather than serving an anonymous pantry.</p></div>`);
}

/** The demo's fridge. It posts the same payload shape the real adapter will read. */
export function renderSimFridgePage(token: string): string {
  const body = `
<div class="card">
<p style="margin:0 0 .5rem">This page stands in for a connected fridge: what you submit here reaches the pantry through the same
door a real device would use, stamped <span class="badge warn">inferred</span> and <code>simulated</code>. The payload shape mirrors a
SmartThings device status; its capability id is unverified against a real Family Hub, which is why this is called simulated and not SmartThings.</p>
</div>
<form id="f">
<h2>What the fridge sees right now</h2>
<div id="rows"></div>
<button type="button" id="add">+ another item</button>
<h2>Report</h2>
<label>Reading timestamp (leave blank for now)</label><input name="ts" placeholder="2026-09-04T07:00:00Z">
<button class="primary" type="submit">Send the fridge's report</button>
</form>
<h2>Response</h2>
<pre id="out">—</pre>
<script>
(function(){
  var TOKEN = ${JSON.stringify(token)};
  var rows = document.getElementById('rows');
  function row(n,q,u,e){
    var d=document.createElement('div');d.className='row';
    d.innerHTML='<div><label>Food</label><input name="name" value="'+n+'"></div><div><label>Qty</label><input name="qty" value="'+q+'"></div>'
      +'<div><label>Unit</label><select name="unit">'+['pc','g','kg','ml','l','bunch','can'].map(function(x){return '<option'+(x===u?' selected':'')+'>'+x+'</option>'}).join('')+'</select></div>'
      +'<div><label>Expires</label><input name="exp" value="'+e+'" placeholder="YYYY-MM-DD"></div>';
    rows.appendChild(d);
  }
  row('Tofu','1','pc','2026-09-05');row('Cherry Tomatoes','250','g','2026-09-08');row('Carrots','4','pc','');row('Baby Spinach','','pc','2026-09-06');
  document.getElementById('add').onclick=function(){row('','','pc','')};
  document.getElementById('f').onsubmit=function(ev){
    ev.preventDefault();
    var items=[];rows.querySelectorAll('.row').forEach(function(r){
      var name=r.querySelector('[name=name]').value.trim();if(!name)return;
      var q=r.querySelector('[name=qty]').value.trim();var e=r.querySelector('[name=exp]').value.trim();
      var it={name:name,unit:r.querySelector('[name=unit]').value};if(q)it.quantity=Number(q);if(e)it.expireDate=e;items.push(it);
    });
    var ts=document.querySelector('[name=ts]').value.trim()||new Date().toISOString();
    var payload={deviceId:'mise-sim-fridge-1',components:{main:{'samsungce.fridgeFoodList':{foodList:{timestamp:ts,value:items}}}}};
    fetch('/sim/fridge',{method:'POST',headers:{'content-type':'application/json','x-sim-token':TOKEN},body:JSON.stringify(payload)})
      .then(function(r){return r.text()}).then(function(t){document.getElementById('out').textContent=t;})
      .catch(function(e){document.getElementById('out').textContent=String(e)});
  };
})();
</script>`;
  return shell("Simulated fridge", body, "Drive the demo's fridge by hand. Then look at the pantry.");
}

// --- the demo store ---------------------------------------------------------------------------

/** The refund policy the UCP profile links to. A demo store still has to have one: the checkout
 *  reference asks for the link, and a link that 404s is worse than no link. */
export function renderRefundPolicyPage(storeName: string): string {
  const body = `<div class="card">
<p><strong>${esc(storeName)} is a demonstration store.</strong> It exists so that an add-on can be shown
buying groceries end to end. Nothing is dispatched, no card is charged, and the payment instruments
it offers are fictional.</p>
<p>If it were a real shop, this page would carry the refund terms the checkout reference requires:
the window, what a refund covers, how to start one, and how long it takes. It does not, because
promising terms nobody will honour is worse than saying so.</p>
</div>
<h2>What is real about it</h2>
<div class="card">
<p>The prices, the stock counts and the allergen declarations are real data in
<code>data/catalog.json</code>, and they are the only source the checkout uses — a request cannot
tell this store what something costs. Completing a checkout writes what you bought into the pantry
ledger, which is the point of the whole exercise.</p>
</div>`;
  return shell("Refund policy", body, "Demonstration store — nothing here ships.");
}

/** A receipt, reachable by its order id. The id is the capability: unguessable, and enough on its
 *  own, the way a receipt link normally works. */
export function renderReceiptPage(order: {
  order_id: string;
  placed_at: string;
  currency: string;
  lines: { title: string; quantity: number; total_cents: number }[];
  totals: { subtotal_cents: number; tax_cents: number; shipping_cents: number; total_cents: number };
  disclosures: string[];
}): string {
  const cents = (c: number) => `${order.currency === "USD" ? "$" : `${order.currency} `}${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  const rows = order.lines
    .map((l) => `<tr><td>${esc(l.title)}</td><td class="num">${l.quantity}</td><td class="num">${esc(cents(l.total_cents))}</td></tr>`)
    .join("");
  const body = `<div class="card">
<table>
<thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot>
<tr><td>Subtotal</td><td></td><td class="num">${esc(cents(order.totals.subtotal_cents))}</td></tr>
<tr><td>Tax</td><td></td><td class="num">${esc(cents(order.totals.tax_cents))}</td></tr>
<tr><td>Delivery</td><td></td><td class="num">${esc(cents(order.totals.shipping_cents))}</td></tr>
<tr><td><strong>Paid</strong></td><td></td><td class="num"><strong>${esc(cents(order.totals.total_cents))}</strong></td></tr>
</tfoot>
</table>
</div>
${order.disclosures.length ? `<h2>Disclosures</h2><div class="card">${order.disclosures.map((d) => `<p>${esc(d)}</p>`).join("")}</div>` : ""}
<p class="legend">Order ${esc(order.order_id)} · ${esc(order.placed_at)} · demonstration store, nothing was dispatched and no card was charged.</p>`;
  return shell("Receipt", body, "");
}
