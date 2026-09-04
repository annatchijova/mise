// The MCP Apps views run inside a sandboxed iframe with no network of its own. These tests are the
// only place that fact is enforced: a stylesheet link or a CDN script would not fail to build, it
// would fail silently in front of a judge. They also hold up the smaller promise that the views
// never compute what the server decided — they render numbers, they do not derive them.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { VIEW_URIS, buildViews, loadRuntime, runtimeFile } from "../src/ui/views.ts";

const RUNTIME = "/* runtime bundle stand-in */ window.mise = { onData(){}, call(){}, esc(v){ return String(v); } };";
const views = buildViews(RUNTIME);

test("every view a tool points at is one the server actually builds", () => {
  const built = new Set(views.map((v) => v.uri));
  for (const uri of Object.values(VIEW_URIS)) assert.ok(built.has(uri), `${uri} is referenced but never built`);
  assert.equal(built.size, Object.values(VIEW_URIS).length);
});

test("no view reaches outside its iframe for anything", () => {
  // The sandbox has no network. A <script src>, a stylesheet link, an image or a font would not
  // break the build — it would break the demo, quietly, on somebody else's machine.
  for (const view of views) {
    assert.ok(!/<script[^>]+\ssrc=/i.test(view.html), `${view.uri} loads an external script`);
    assert.ok(!/<link[^>]+\shref=/i.test(view.html), `${view.uri} loads an external stylesheet`);
    assert.ok(!/<img[^>]+\ssrc=/i.test(view.html), `${view.uri} loads an image`);
    assert.ok(!/@import/i.test(view.html), `${view.uri} imports a stylesheet`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(view.html.replace(RUNTIME, "")), `${view.uri} makes its own network call`);
  }
});

test("each view is one complete document with the runtime inlined", () => {
  for (const view of views) {
    assert.match(view.html, /^<!doctype html>/i, `${view.uri} is not a whole document`);
    assert.ok(view.html.includes("</html>"), `${view.uri} is truncated`);
    assert.ok(view.html.includes(RUNTIME), `${view.uri} does not carry the runtime`);
    assert.ok(view.html.includes("window.mise.onData"), `${view.uri} never subscribes to its data`);
  }
});

test("without a built runtime the views say so, and say what to run", () => {
  for (const view of buildViews(null)) {
    assert.match(view.html, /npm run build/, `${view.uri} does not say how to fix it`);
    assert.match(view.html, /structuredContent/, `${view.uri} does not say that the tools still work`);
    assert.ok(!view.html.includes("window.mise.onData"), "a view with no runtime must not pretend to have one");
  }
});

test("everything a view puts on the page goes through the escaper", () => {
  // Anything from a recipe title to an ingredient id can carry a character that matters in HTML.
  for (const view of views) {
    const script = view.html.slice(view.html.lastIndexOf("<script>"));
    const interpolations = script.match(/'\s*\+\s*([A-Za-z0-9_.[\]()]+)\s*\+\s*'/g) ?? [];
    for (const hit of interpolations) {
      // `pair[0]` and `pair[1]` are the two halves of a literal badge map with a default, chosen
      // by a lookup and never carrying anything a person typed. That is the only exception.
      assert.ok(
        /esc\(|clock\(|money\(|freshBadge\(|confBadge\(|String\(|pair\[/.test(hit),
        `${view.uri} writes ${hit.trim()} into the page without escaping it`,
      );
    }
  }
});

test("the step card counts down but never invents a number the session did not give it", () => {
  const card = views.find((v) => v.uri === VIEW_URIS.stepCard)!;
  assert.match(card.html, /data-remaining/, "the countdown starts from the server's remaining_s");
  assert.ok(!/duration_s\s*-\s*/.test(card.html), "the view must not recompute elapsed time itself");
  assert.match(card.html, /data-run/, "only a running timer ticks; a paused one holds");
});

test("the pantry view shows 'some' rather than a number nobody counted", () => {
  const pantry = views.find((v) => v.uri === VIEW_URIS.pantry)!;
  assert.match(pantry.html, /qty_known \? /, "the view branches on whether the amount is known");
  assert.match(pantry.html, />some</, "and says 'some' when it is not");
});

test("the week grid reads the planner's own reason and writes none of its own", () => {
  const week = views.find((v) => v.uri === VIEW_URIS.weekGrid)!;
  assert.match(week.html, /esc\(m\.why\)/, "the reason comes from the plan");
  assert.match(week.html, /unplaceable/, "and so does the list of what could not be saved");
});

test("the built runtime, when there is one, is a self-contained bundle", () => {
  const runtime = loadRuntime();
  if (runtime === null) {
    // `npm run check` does not build. That is fine: the views above are tested with a stand-in.
    return;
  }
  assert.ok(runtime.length > 1000, `${runtimeFile()} looks truncated`);
  assert.ok(!/\brequire\s*\(|^import\s/m.test(runtime), "the bundle still has unresolved module syntax in it");
  assert.ok(runtime.includes("mise"), "the bundle does not define the view API");
});

test("the runtime source asks the host, and never the network, for its data", () => {
  const source = readFileSync(new URL("../src/ui/runtime.ts", import.meta.url), "utf8");
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(source), "the runtime must not have a network path");
  assert.match(source, /callServerTool/, "a button asks the server to run a tool, through the host");
});
