// The app-side runtime that every ui:// view loads.
//
// It runs inside the client's sandboxed iframe, where there is no network at all — no CDN, no fetch,
// no font — so this file is bundled by esbuild into one inline <script>. That is also why it uses
// the real `@modelcontextprotocol/ext-apps` App rather than a hand-rolled postMessage bridge: the
// handshake with the host is the one part of this project that cannot be checked by running it here,
// and a guess at somebody else's protocol is the last place to be inventive.
//
// What it exposes is deliberately small. A view is a function of the tool's structuredContent; it
// renders when data arrives and it can ask the server to run one more tool when somebody presses a
// button. Nothing else.
import { App } from "@modelcontextprotocol/ext-apps";

type Render = (data: Record<string, unknown>) => void;

declare global {
  interface Window {
    mise: {
      /** Render now with whatever has arrived, and again on every later tool result. */
      onData(render: Render): void;
      /** Ask the server to run a tool. The host asks the person first; that is the protocol's design. */
      call(name: string, args?: Record<string, unknown>): Promise<void>;
      /** Escape text before it goes anywhere near innerHTML. */
      esc(value: unknown): string;
    };
  }
}

const app = new App({ name: "mise-view", version: "0.1.0" }, {}, { autoResize: true });

let render: Render | null = null;
let latest: Record<string, unknown> = {};

function paint(): void {
  if (render === null) return;
  try {
    render(latest);
  } catch (err) {
    // A view that throws must not leave a blank panel with no explanation.
    document.body.textContent = `This view could not draw itself: ${String(err)}`;
  }
}

app.addEventListener("toolresult", (params) => {
  const structured = (params as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (structured) {
    latest = structured;
    paint();
  }
});

window.mise = {
  onData(next: Render) {
    render = next;
    paint();
  },
  async call(name: string, args: Record<string, unknown> = {}) {
    const result = await app.callServerTool({ name, arguments: args });
    const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    if (structured) {
      latest = structured;
      paint();
    }
  },
  esc(value: unknown): string {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },
};

void app.connect();
