// Where a weekly plan lives once it has been made.
//
// A plan is not a suggestion that evaporates when the conversation ends: `cart_from_plan` shops for
// it, and "what am I making on Thursday" has to answer the same thing tomorrow. One current plan
// per user, plus whatever was made before, keyed by the plan id that carries its hash.
import { readFileSync, writeFileSync } from "node:fs";

import type { PlanResult } from "./planner.ts";

export type PlanStore = {
  /** The most recent plan for this user, or null. */
  current(userId: string): Promise<PlanResult | null>;
  get(userId: string, planId: string): Promise<PlanResult | null>;
  put(userId: string, plan: PlanResult): Promise<void>;
};

export class MemoryPlanStore implements PlanStore {
  private byUser = new Map<string, PlanResult[]>();
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file) this.load();
  }

  async current(userId: string): Promise<PlanResult | null> {
    return (this.byUser.get(userId) ?? []).at(-1) ?? null;
  }

  async get(userId: string, planId: string): Promise<PlanResult | null> {
    return (this.byUser.get(userId) ?? []).find((p) => p.plan_id === planId) ?? null;
  }

  async put(userId: string, plan: PlanResult): Promise<void> {
    const list = (this.byUser.get(userId) ?? []).filter((p) => p.plan_id !== plan.plan_id);
    list.push(plan);
    this.byUser.set(userId, list);
    this.persist();
  }

  snapshot(): Record<string, PlanResult[]> {
    return Object.fromEntries([...this.byUser].map(([u, p]) => [u, [...p]]));
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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const [u, plans] of Object.entries(JSON.parse(raw) as Record<string, PlanResult[]>)) this.byUser.set(u, plans);
  }
}
