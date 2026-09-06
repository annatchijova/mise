// Where cooking sessions live between "pause" and "where was I?".
//
// The interface is what block B's DynamoDB repository will implement (`USER#id / COOK#recipe#started`
// in docs/PLAN.md); the in-memory store is what runs today. One rule shapes it: **a user has at most
// one session that is not finished**. Two live sessions would mean `cook_next` has to ask which pot
// you mean, and nobody talking to a speaker with their hands covered in flour wants that question.
// Starting a second recipe is therefore an explicit decision, made by the tool, not a silent
// overwrite here.
import { readFileSync, writeFileSync } from "node:fs";

import type { CookSession } from "./session.ts";

export type CookStore = {
  /** The session in progress — `mise_en_place`, `cooking` or `paused` — or null. */
  active(userId: string): Promise<CookSession | null>;
  get(userId: string, id: string): Promise<CookSession | null>;
  put(session: CookSession): Promise<void>;
  /** Newest first. The demo never reads it; a "what did I cook this week" tool would. */
  history(userId: string): Promise<CookSession[]>;
};

export const LIVE_STATES = new Set(["mise_en_place", "cooking", "paused"]);

export class MemoryCookStore implements CookStore {
  private byUser = new Map<string, CookSession[]>();
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file) this.load();
  }

  async active(userId: string): Promise<CookSession | null> {
    const live = (this.byUser.get(userId) ?? []).filter((s) => LIVE_STATES.has(s.state));
    // Newest wins if a bug ever leaves two: answering with the stale one would be the worse failure.
    return live.sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1) ?? null;
  }

  async get(userId: string, id: string): Promise<CookSession | null> {
    return (this.byUser.get(userId) ?? []).find((s) => s.id === id) ?? null;
  }

  async put(session: CookSession): Promise<void> {
    const list = this.byUser.get(session.user_id) ?? [];
    const at = list.findIndex((s) => s.id === session.id);
    if (at === -1) list.push(session);
    else list[at] = session;
    this.byUser.set(session.user_id, list);
    this.persist();
  }

  async history(userId: string): Promise<CookSession[]> {
    return [...(this.byUser.get(userId) ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  snapshot(): Record<string, CookSession[]> {
    return Object.fromEntries([...this.byUser].map(([u, s]) => [u, [...s]]));
  }

  private persist(): void {
    if (!this.file) return;
    writeFileSync(this.file, JSON.stringify(this.snapshot(), null, 2), "utf8");
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file!, "utf8");
    } catch (err) {
      // Same rule as the pantry mirror: only a missing file is a first run. Starting empty over a
      // file we simply could not read would lose a session somebody paused an hour ago.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const [u, sessions] of Object.entries(JSON.parse(raw) as Record<string, CookSession[]>)) {
      this.byUser.set(u, sessions);
    }
  }
}
