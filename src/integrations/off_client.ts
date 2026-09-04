// Open Food Facts lookup. The one place the barcode path touches the network — on the ingest path,
// never on the Alexa+ response path — with a hard timeout and a cache so a barcode is fetched once.
//
// API: GET {base}/api/v2/product/{ean}?fields=... — public, no key. `status: 1` means found.
import type { OffProduct } from "./barcode.ts";

export const OFF_FIELDS = "code,product_name,product_name_en,brands,quantity,categories_tags";

export type OffLookup = (ean: string) => Promise<OffProduct | null>;

export function makeOffLookup(opts: { baseUrl?: string; timeoutMs?: number; userAgent?: string } = {}): OffLookup {
  const base = (opts.baseUrl ?? "https://world.openfoodfacts.org").replace(/\/$/, "");
  const timeout = opts.timeoutMs ?? 5000;
  const cache = new Map<string, OffProduct | null>();

  return async (ean: string): Promise<OffProduct | null> => {
    const key = ean.trim();
    if (!/^\d{6,14}$/.test(key)) return null;
    if (cache.has(key)) return cache.get(key)!;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(`${base}/api/v2/product/${key}?fields=${OFF_FIELDS}`, {
        signal: ctl.signal,
        headers: { "user-agent": opts.userAgent ?? "mise/0.1 (+https://github.com/annatchijova/mise)" },
      });
      if (!res.ok) return null; // not cached: a 5xx today may be a hit tomorrow
      const data = (await res.json()) as { status?: number; product?: OffProduct };
      const product = data.status === 1 && data.product ? data.product : null;
      cache.set(key, product);
      return product;
    } catch {
      return null; // timeout or network: the adapter reports the lookup as failed, nothing is guessed
    } finally {
      clearTimeout(timer);
    }
  };
}
