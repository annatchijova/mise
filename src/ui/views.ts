// The four MCP Apps views, as self-contained HTML.
//
// Alexa+ renders a `ui://` resource in an isolated iframe with no network of its own, so every view
// is one document: inline CSS, inline script, no font, no image, no fetch. The bundled app runtime
// (src/ui/runtime.ts, built to dist/ui-runtime.js) is inlined into each of them.
//
// These are polish and the plan says so — without a declared UI, Alexa+ builds its own visuals from
// structuredContent and everything still works. So each view is a plain function of the tool output
// it belongs to, adds no state of its own, and never computes anything the server already decided.
// The step card does not know how long is left on a timer; it prints the number the session gave it.
//
// Value order, from docs/PLAN.md §08: the step card first, then the weekly grid, the cart, the
// pantry.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rootDir } from "../recipes.ts";

export const VIEW_URIS = {
  stepCard: "ui://mise/step-card",
  weekGrid: "ui://mise/week-grid",
  cart: "ui://mise/cart",
  pantry: "ui://mise/pantry",
} as const;

export function runtimeFile(): string {
  return process.env.UI_RUNTIME_FILE ?? join(rootDir(), "dist", "ui-runtime.js");
}

/** The bundled runtime, or null when nobody has built it. Read once, at startup. */
export function loadRuntime(file: string = runtimeFile()): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Shared with the account web's palette, trimmed to what a card in an iframe needs. */
const CSS = `:root{color-scheme:light dark;--fg:#1a1a1a;--dim:#6b6b6b;--line:#e3e0da;--bg:#faf9f7;--card:#fff;
--ok:#2f7d4f;--okbg:#e6f3ea;--warn:#8a6d3b;--warnbg:#fdf6e3;--bad:#a23b3b;--badbg:#f9e7e7;--mute:#6b6b6b;--mutebg:#eeece8}
@media(prefers-color-scheme:dark){:root{--fg:#e8e6e3;--dim:#9a968f;--line:#33312e;--bg:#171614;--card:#1f1e1b;
--ok:#7fcf9a;--okbg:#1d2f24;--warn:#d3b678;--warnbg:#2a2418;--bad:#e79a9a;--badbg:#341d1d;--mute:#9a968f;--mutebg:#26241f}}
*{box-sizing:border-box}body{margin:0;padding:1rem;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
h1{font:600 1.15rem/1.25 ui-serif,Georgia,serif;margin:0 0 .2rem}
.dim{color:var(--dim);font-size:.85rem}
.step{font:600 1.5rem/1.3 ui-serif,Georgia,serif;margin:.6rem 0}
.timer{font-variant-numeric:tabular-nums;font-size:2rem;font-weight:600;letter-spacing:-.02em}
.badge{display:inline-block;font:600 .68rem/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;border-radius:3px;padding:.24rem .4rem;white-space:nowrap;margin-right:.3rem}
.ok{color:var(--ok);background:var(--okbg)}.warn{color:var(--warn);background:var(--warnbg)}.bad{color:var(--bad);background:var(--badbg)}.mute{color:var(--mute);background:var(--mutebg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:.85rem 1rem;margin:.6rem 0}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{text-align:left;font:600 .7rem/1.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);padding:.35rem .4rem;border-bottom:1px solid var(--line)}
td{padding:.45rem .4rem;border-bottom:1px solid var(--line);vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums}
button{font:inherit;font-weight:600;padding:.55rem 1rem;border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--fg);cursor:pointer;margin:.5rem .4rem 0 0}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
button[disabled]{opacity:.5;cursor:default}
ul{margin:.4rem 0;padding-left:1.1rem}li{margin:.15rem 0}
.src{color:var(--dim);font-size:.78rem;margin-top:.8rem;padding-top:.5rem;border-top:1px solid var(--line)}
.mise{list-style:none;margin:.6rem 0;padding:0}
.mise li{display:flex;gap:.6rem;align-items:baseline;padding:.4rem 0;border-bottom:1px solid var(--line);cursor:pointer}
.mise li:last-child{border-bottom:none}
.mise .why{display:block;margin-top:.1rem}
/* The mode button sits over the header line, so the header keeps clear of it. */
#root>.dim:first-of-type{padding-right:6.5rem}
body.big #root>.dim:first-of-type{padding-right:8rem}
.tick{flex:0 0 1.1rem;height:1.1rem;border:2px solid var(--line);border-radius:3px;text-align:center;line-height:.95rem;font-weight:700;color:transparent}
.mise li.done .tick{border-color:var(--ok);background:var(--ok);color:var(--bg)}
.mise li.done .what{color:var(--dim);text-decoration:line-through}
.amt{font-variant-numeric:tabular-nums;font-weight:600}
/* Large print: one step, high contrast, nothing else. Not a separate view — the same data, and the
   host only ever picks one view per tool, so a toggle is the only way a person gets both. */
body.big{padding:1.4rem;font-size:22px;--fg:#000;--bg:#fff;--dim:#333;--line:#999;--card:#fff}
@media(prefers-color-scheme:dark){body.big{--fg:#fff;--bg:#000;--dim:#ccc;--line:#777;--card:#000}}
body.big .step{font-size:2.6rem;line-height:1.25}
body.big .timer{font-size:3.4rem}
body.big .dim{font-size:1rem}
body.big .card,body.big .src,body.big .why{border:none}
body.big .hide-big{display:none}
body.big button{font-size:1.1rem;padding:.9rem 1.4rem}
.mode{position:absolute;top:.5rem;right:.6rem;font-size:.72rem;padding:.3rem .5rem;margin:0}
.grid{display:grid;gap:.5rem}
.why{color:var(--dim);font-size:.82rem;margin-top:.15rem}
.empty{color:var(--dim);padding:1.5rem 0;text-align:center}`;

/** Shared view helpers, in the plain JavaScript the iframe runs. No template literals in here: the
 *  whole file is itself inside one. */
const HELPERS = `
var esc = window.mise.esc;
function el(id){ return document.getElementById(id); }
function clock(seconds){
  var s = Math.max(0, Math.round(seconds));
  var m = Math.floor(s / 60), r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}
function freshBadge(f){
  var map = { expired: ['bad','past its date'], urgent: ['bad','today or tomorrow'], soon: ['warn','within 3 days'], fresh: ['ok','fresh'], unknown: ['mute','no date'] };
  var pair = map[f] || map.unknown;
  return '<span class="badge ' + pair[0] + '">' + pair[1] + '</span>';
}
function confBadge(c){
  var map = { confirmed: ['ok','you said so'], inferred: ['warn','worked out'], stale: ['mute','unconfirmed'] };
  var pair = map[c] || map.stale;
  return '<span class="badge ' + pair[0] + '">' + pair[1] + '</span>';
}
function money(cents, currency){
  var sign = cents < 0 ? '-' : '', abs = Math.abs(cents);
  var sym = currency === 'USD' || !currency ? '$' : currency + ' ';
  var c = abs % 100;
  return sign + sym + Math.floor(abs / 100) + '.' + (c < 10 ? '0' : '') + c;
}
`;

function page(title: string, runtime: string | null, body: string, script: string): string {
  if (runtime === null) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head>
<body><div class="card"><h1>${title}</h1>
<p>This view cannot run: the app runtime bundle is missing. Run <code>npm run build</code>, which
writes <code>dist/ui-runtime.js</code>, and reload.</p>
<p class="dim">Nothing is broken on the server side — every tool still returns its full
structuredContent, and the client will build its own visuals from that.</p></div></body></html>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
${body}
<script>${runtime}</script>
<script>
(function(){
${HELPERS}
${script}
})();
</script>
</body>
</html>
`;
}

// --- the step card ------------------------------------------------------------------------------

/**
 * The cooking step, large, with its timers.
 *
 * The only view with a clock of its own, and it still does not compute anything: it counts down from
 * the `remaining_s` the session handed it and stops there. When the number is stale the session is
 * the thing to ask, not the iframe — which is exactly why a paused session shows a frozen number
 * rather than one drifting quietly out of agreement with the server.
 */
export function stepCardView(runtime: string | null): string {
  const body = `<div id="root"><div class="empty">Waiting for the step…</div></div>`;
  const script = `
var ticking = null;
// Two pieces of state the view is allowed to keep, because neither is a fact about the cooking:
// whether the person wants large print, and which things they have gathered. The second is not sent
// to the server on purpose — the mise en place is not a step, ticking a line off is not a claim
// about a pantry, and nothing here should turn into an event.
var big = false;
var gathered = {};
window.mise.onData(function(data){
  var s = data.session;
  if (!s) { el('root').innerHTML = '<div class="empty">Nothing on the go.</div>'; return; }
  var step = s.step;
  var timers = (s.timers || []).filter(function(t){ return t.state !== 'stopped'; });
  var html = '<button class="mode" id="mode">' + (big ? 'Normal' : 'Large print') + '</button>';
  html += '<div class="dim">' + esc(s.recipe_title || s.recipe_id.replace(/-/g, ' ')) + ' · ' + esc(s.servings) + ' servings · ' + esc(s.state.replace(/_/g, ' ')) +
          (s.cooks > 1 ? ' · ' + esc(s.cooks) + ' cooks' : '') + '</div>';
  if (!step && (s.waiting_for || []).length) {
    html += '<div class="step">Waiting on step ' + esc(s.waiting_for.join(', ')) + '.</div>';
    html += '<div class="why">That one is not yours. Nothing to do until it is done.</div>';
  } else if (step) {
    html += '<div class="dim">Step ' + esc(step.order) + ' of ' + esc(step.of) + '</div>';
    html += '<div class="step">' + esc(step.text) + '</div>';
    if (step.dur_source === 'estimated') html += '<div class="why">That duration is the kitchen\\'s estimate, not the book\\'s.</div>';
  } else {
    html += '<div class="step">Mise en place.</div>';
    // Nine ingredients read aloud is a lot; nine of them to tick off is a kitchen. The amounts are
    // the ones the server scaled — the view never does arithmetic — and a line the book gave no
    // amount for says so rather than showing a blank.
    var mise = s.mise || [];
    if (mise.length) {
      html += '<ul class="mise">';
      mise.forEach(function(m, i){
        // The words come from the server, which already knows how to say them. The view's job is
        // where they go on the page, and escaping them where they are written — at the
        // interpolation, which is the only version a reader or the test that enforces it can check.
        var amount = m.display_amount;
        var what = m.display_name;
        var aside = m.qty === null ? 'the book does not say how much' : (m.note || '');
        if (m.damped && m.scaling_note) aside = aside ? aside + ' · ' + m.scaling_note : m.scaling_note;
        html += '<li data-i="' + esc(i) + '"' + (gathered[m.ingredient_id] ? ' class="done"' : '') + '>' +
                '<span class="tick">✓</span><span class="what"><span class="amt">' + esc(amount) + '</span> ' + esc(what) +
                (aside ? '<span class="why">' + esc(aside) + '</span>' : '') + '</span></li>';
      });
      html += '</ul>';
    }
  }
  if (s.cooks > 1) {
    html += '<div class="why">' + (s.tracks || []).map(function(t){
      return 'Cook ' + esc(t.cook) + ': ' + (t.step ? 'step ' + esc(t.step) : (t.waiting_for || []).length ? 'waiting on step ' + esc(t.waiting_for.join(', ')) : 'finished');
    }).join(' · ') + '</div>';
  }
  timers.forEach(function(t){
    var late = t.state === 'done';
    html += '<div class="card"><div class="dim">Timer on step ' + esc(t.step) + (t.state === 'paused' ? ' · holding' : '') + '</div>';
    html += '<div class="timer" data-remaining="' + esc(t.remaining_s) + '" data-run="' + (t.state === 'running' ? '1' : '0') + '">' + (late ? 'up' : clock(t.remaining_s)) + '</div></div>';
  });
  if ((s.deviations || []).length) {
    html += '<div class="card"><div class="dim">Noted while cooking</div><ul>';
    s.deviations.slice(-3).forEach(function(d){ html += '<li>' + esc(d.what) + '</li>'; });
    html += '</ul></div>';
  }
  html += '<div><button class="primary" id="next">Next step</button><button id="pause">Pause</button></div>';
  // Where the recipe came from. Every recipe here carries a book and a locator; showing them costs
  // nothing and answers "where did these come from" before anybody has to ask it.
  if (s.source && s.source.book) {
    html += '<div class="src hide-big">From ' + esc(s.source.book) + (s.source.locator ? ', ' + esc(s.source.locator) : '') + '.</div>';
  }
  el('root').innerHTML = html;
  document.body.className = big ? 'big' : '';
  el('next').onclick = function(){ el('next').disabled = true; window.mise.call('cook_next'); };
  el('pause').onclick = function(){ el('pause').disabled = true; window.mise.call('cook_pause'); };
  el('mode').onclick = function(){
    big = !big;
    document.body.className = big ? 'big' : '';
    el('mode').textContent = big ? 'Normal' : 'Large print';
  };
  Array.prototype.forEach.call(document.querySelectorAll('.mise li'), function(node){
    node.onclick = function(){
      var item = (s.mise || [])[Number(node.getAttribute('data-i'))];
      if (!item) return;
      gathered[item.ingredient_id] = !gathered[item.ingredient_id];
      node.className = gathered[item.ingredient_id] ? 'done' : '';
    };
  });

  if (ticking) clearInterval(ticking);
  // A second hand for the running timers only. The server's number is the truth; this just keeps
  // the display honest between tool calls, and stops rather than counting into the negative.
  ticking = setInterval(function(){
    var moved = false;
    Array.prototype.forEach.call(document.querySelectorAll('.timer'), function(node){
      if (node.getAttribute('data-run') !== '1') return;
      var left = Number(node.getAttribute('data-remaining')) - 1;
      node.setAttribute('data-remaining', String(left));
      node.textContent = left <= 0 ? 'up' : clock(left);
      moved = true;
    });
    if (!moved) { clearInterval(ticking); ticking = null; }
  }, 1000);
});
`;
  return page("Cooking step", runtime, body, script);
}

// --- the weekly grid ----------------------------------------------------------------------------

/** Days down the side, the reason beside each meal, and the shopping list underneath. The reason is
 *  the planner's own sentence; the view never writes one. */
export function weekGridView(runtime: string | null): string {
  const body = `<div id="root"><div class="empty">Waiting for the plan…</div></div>`;
  const script = `
window.mise.onData(function(data){
  if (!data.meals) { el('root').innerHTML = '<div class="empty">No plan yet.</div>'; return; }
  var html = '<h1>The week</h1>';
  html += '<div class="dim">' + esc(data.days) + ' days from ' + esc(data.start_date) +
          (data.time_budget_min ? ' · under ' + esc(data.time_budget_min) + ' minutes a meal' : '') +
          ' · plan ' + esc(String(data.plan_hash).slice(0, 8)) + '</div>';
  html += '<table><thead><tr><th>Day</th><th>Meal</th><th>Minutes</th></tr></thead><tbody>';
  data.meals.forEach(function(m){
    html += '<tr><td>' + esc(m.weekday || m.date) + '<div class="dim">' + esc(m.meal) + '</div></td>';
    html += '<td>' + esc(m.title);
    html += '<div class="why">' + (m.why_code === 'expiring' ? '<span class="badge warn">rescue</span>' : '') + esc(m.why) + '</div></td>';
    html += '<td class="num">' + esc(m.minutes) + '</td></tr>';
  });
  html += '</tbody></table>';

  (data.unfilled || []).forEach(function(u){
    html += '<div class="card"><strong>' + esc(u.date) + ', ' + esc(u.meal) + ':</strong> nothing planned. ' + esc(u.reason) + '.</div>';
  });
  if ((data.unplaceable || []).length) {
    html += '<div class="card"><div class="dim">Could not be saved</div><ul>';
    data.unplaceable.forEach(function(u){
      html += '<li>' + esc(u.ingredient_id.replace(/-/g, ' ')) + ' — ' + esc(u.reason) + '</li>';
    });
    html += '</ul></div>';
  }
  if ((data.missing || []).length) {
    html += '<div class="card"><div class="dim">To buy, across the week</div><ul>';
    data.missing.forEach(function(l){
      var amount = l.qty_known && l.qty !== null ? l.qty + ' ' + (l.unit === 'pc' ? '' : l.unit + ' ') : '';
      html += '<li>' + esc(amount) + esc(l.ingredient_id.replace(/-/g, ' ')) +
              (l.topping_up ? ' <span class="badge mute">top-up</span>' : '') + '</li>';
    });
    html += '</ul><button class="primary" id="shop">Put it in the basket</button></div>';
  }
  el('root').innerHTML = html;
  if (el('shop')) el('shop').onclick = function(){ el('shop').disabled = true; window.mise.call('cart_from_plan', { plan_id: data.plan_id }); };
});
`;
  return page("The week", runtime, body, script);
}

// --- the cart -----------------------------------------------------------------------------------

/** What is in the basket, what it costs, and — the part that matters — what the shop could not
 *  supply and why. */
export function cartView(runtime: string | null): string {
  const body = `<div id="root"><div class="empty">Waiting for the basket…</div></div>`;
  const script = `
window.mise.onData(function(data){
  var cart = data.cart;
  if (!cart) { el('root').innerHTML = '<div class="empty">No basket yet.</div>'; return; }
  var html = '<h1>The basket</h1>';
  if (!cart.lines.length) html += '<div class="empty">Nothing in it.</div>';
  else {
    html += '<table><thead><tr><th>Item</th><th class="num">Packs</th><th class="num">Price</th></tr></thead><tbody>';
    cart.lines.forEach(function(l){
      html += '<tr><td>' + esc(l.title);
      if (l.assumed_pack) html += '<div class="why">One, because the recipe never says how much.</div>';
      if (l.allergens && l.allergens.length) html += '<div class="why">Contains ' + esc(l.allergens.join(', ')) + '.</div>';
      html += '</td><td class="num">' + esc(l.packs) + '</td><td class="num">' + esc(money(l.line_total_cents, cart.currency)) + '</td></tr>';
    });
    html += '</tbody><tfoot><tr><td><strong>Before tax and delivery</strong></td><td></td><td class="num"><strong>' +
            esc(money(cart.subtotal_cents, cart.currency)) + '</strong></td></tr></tfoot></table>';
  }
  if ((cart.unmapped || []).length) {
    html += '<div class="card"><div class="dim">The shop could not supply</div><ul>';
    cart.unmapped.forEach(function(u){
      html += '<li>' + esc(u.ingredient_id.replace(/-/g, ' ')) + ' — ' + esc(u.reason) + '</li>';
    });
    html += '</ul></div>';
  }
  el('root').innerHTML = html;
});
`;
  return page("The basket", runtime, body, script);
}

// --- the pantry ---------------------------------------------------------------------------------

/** The view where the system shows that it does not pretend to know what it does not know: a
 *  confidence badge on every line, and an amount that reads "some" when nobody counted. */
export function pantryView(runtime: string | null): string {
  const body = `<div id="root"><div class="empty">Waiting for the pantry…</div></div>`;
  const script = `
window.mise.onData(function(data){
  if (!data.items) { el('root').innerHTML = '<div class="empty">Nothing on record.</div>'; return; }
  var html = '<h1>The pantry</h1><div class="dim">' + esc(data.total) + ' items' +
             (data.invalid_events ? ' · ' + esc(data.invalid_events) + ' records could not be read and were left out' : '') + '</div>';
  var c = data.confidence;
  if (c && c.total) {
    html += '<div class="card"><div style="font-size:1.5rem;font-weight:600">' + esc(c.score) + '%</div>';
    html += '<div class="why">of the pantry rests on something you said — ' + esc(c.score_basis) + '.</div>';
    html += '<div style="display:flex;height:.45rem;border-radius:3px;overflow:hidden;background:var(--mutebg);margin-top:.5rem">';
    html += '<div style="width:' + esc(c.confirmed_pct) + '%;background:var(--ok)"></div>';
    html += '<div style="width:' + esc(c.inferred_pct) + '%;background:var(--warn)"></div>';
    html += '<div style="width:' + esc(c.stale_pct) + '%;background:var(--mute)"></div></div>';
    html += '<div class="why">' + esc(c.confirmed) + ' confirmed · ' + esc(c.inferred) + ' inferred · ' + esc(c.stale) + ' unconfirmed · ' + esc(c.unknown_amount) + ' with no amount</div>';
    html += '<button id="audit">Check the doubtful ones</button></div>';
  }
  if (!data.items.length) html += '<div class="empty">Nothing on record yet.</div>';
  else {
    html += '<table><thead><tr><th>Item</th><th class="num">Amount</th><th>How sure</th></tr></thead><tbody>';
    data.items.forEach(function(i){
      var dated = i.expires_on ? ' · ' + esc(i.expires_on)
        : i.expiry_source === 'estimated' && i.expiry_estimated_on ? ' · ~' + esc(i.expiry_estimated_on) + ' (estimate)'
        : '';
      html += '<tr><td>' + esc(i.ingredient_id.replace(/-/g, ' ')) + '<div class="why">' + esc(i.location) + dated + '</div></td>';
      html += '<td class="num">' + (i.qty_known ? esc(i.qty) + ' ' + esc(i.unit === 'pc' ? '' : i.unit) : '<span class="dim">some</span>') + '</td>';
      html += '<td>' + confBadge(i.confidence) + freshBadge(i.freshness) + '</td></tr>';
    });
    html += '</tbody></table>';
    html += '<div class="why">“Some” means nobody counted it, and a date marked (estimate) came from the shelf-life table rather than from you. Neither is ever shown as something you said.</div>';
  }
  el('root').innerHTML = html;
  if (el('audit')) el('audit').onclick = function(){ el('audit').disabled = true; window.mise.call('pantry_audit', {}); };
});
`;
  return page("The pantry", runtime, body, script);
}

export type ViewSet = { uri: string; title: string; html: string }[];

/** Every view, built once at startup. */
export function buildViews(runtime: string | null): ViewSet {
  return [
    { uri: VIEW_URIS.stepCard, title: "Cooking step", html: stepCardView(runtime) },
    { uri: VIEW_URIS.weekGrid, title: "The week", html: weekGridView(runtime) },
    { uri: VIEW_URIS.cart, title: "The basket", html: cartView(runtime) },
    { uri: VIEW_URIS.pantry, title: "The pantry", html: pantryView(runtime) },
  ];
}
