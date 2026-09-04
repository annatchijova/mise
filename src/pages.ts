// The account web: the small set of pages for what voice cannot do.
//
// Alexa+ is the primary surface and it builds its own visuals from structuredContent; MCP Apps views
// (plan block F) are polish on top of that. These pages are something else: the places a person
// connects a source, drives the simulated fridge for the demo, and looks at the pantry with every
// badge the data carries. They are server-rendered, inline-styled, and read the same fold the tools
// read — there is no second model of the pantry.
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

function expiryCell(i: PantryItem): string {
  const [cls, label] = FRESH[i.freshness];
  const when = i.expires_on ? ` <span style="color:var(--dim)">${esc(i.expires_on)}</span>` : "";
  return `<span class="dot ${cls}" style="background:currentColor"></span>${label}${when}`;
}

export type SourceLine = { label: string; kind: string; synced_at: string | null };

/** The pantry, exactly as the fold sees it. Every reservation the data carries is on the page. */
export function renderPantryPage(items: PantryItem[], sources: SourceLine[], now: string, opts: { location?: string } = {}): string {
  const locations = [...new Set(items.map((i) => i.location))].sort();
  const shown = opts.location ? items.filter((i) => i.location === opts.location) : items;

  const filter = locations.length > 1
    ? `<p class="sub"><a href="/pantry">all</a>${locations.map((l) => ` · <a href="/pantry?location=${encodeURIComponent(l)}">${esc(l)}</a>`).join("")}</p>`
    : "";

  const rows = shown.map((i) => `<tr>
<td>${esc(i.ingredient_id.replace(/-/g, " "))}<br><span style="color:var(--dim);font-size:.8rem">${esc(i.location)}</span></td>
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
<p class="legend"><span><span class="badge ok">confirmed</span> you said it, or scanned it</span><span><span class="badge warn">inferred</span> a device or a recipe deduced it</span><span><span class="badge mute">stale</span> nobody has confirmed it in a while</span></p>`;

  const sourceLines = sources.length === 0
    ? `<p class="sub">No connected sources. Voice only.</p>`
    : `<p class="sub">${sources.map((s) => `${esc(s.label)} <span style="color:var(--dim)">(${esc(s.kind)}${s.synced_at ? `, last report ${esc(s.synced_at.slice(0, 16).replace("T", " "))}` : ", never reported"})</span>`).join(" · ")}</p>`;

  return shell("Pantry", `${filter}${table}<h2>Sources</h2>${sourceLines}<p class="legend">As of ${esc(now.slice(0, 16).replace("T", " "))} UTC. Amounts never convert between units, and an unknown amount is never shown as zero.</p>`,
    `${items.length} line${items.length === 1 ? "" : "s"}, ordered by what goes off first.`);
}

/** The demo's fridge. It posts the same payload shape the real adapter will read. */
export function renderSimFridgePage(): string {
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
    fetch('/sim/fridge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){return r.text()}).then(function(t){document.getElementById('out').textContent=t;})
      .catch(function(e){document.getElementById('out').textContent=String(e)});
  };
})();
</script>`;
  return shell("Simulated fridge", body, "Drive the demo's fridge by hand. Then look at the pantry.");
}
