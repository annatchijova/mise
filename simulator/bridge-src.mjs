// Host side of the real MCP Apps bridge, running in the browser (not Node).
// No hand-rolled postMessage guessing — this is @modelcontextprotocol/ext-apps's
// own AppBridge, the exact counterpart to the App class the view already uses
// (src/ui/runtime.ts). The bridge never talks to Mise's MCP server directly:
// it proxies tool calls the view makes through this page's own backend
// (/api/tool-call), which holds the one real MCP connection.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * Mount a view in an iframe, feed it the real tool call that produced it, and
 * let it ask for more tool calls (e.g. a step card's "next" button) by
 * proxying them to this page's backend.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {{name: string, args: object, result: object}} toolCall - the tool
 *   call whose result the view should render first.
 */
export async function mountView(iframe, toolCall) {
  const bridge = new AppBridge(
    null, // no direct MCP client — tool calls from the view go through /api/tool-call
    { name: "mise-alexa-plus-simulator", version: "1.0.0" },
    { openLinks: {}, serverTools: {}, logging: {} },
  );

  bridge.oncalltool = async (params) => {
    const res = await fetch("/api/tool-call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
    });
    return res.json();
  };

  bridge.oninitialized = () => {
    bridge.sendToolInput({ arguments: toolCall.args ?? {} });
    bridge.sendToolResult(toolCall.result);
  };

  const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
  await bridge.connect(transport);
  return bridge;
}
