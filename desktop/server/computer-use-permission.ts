import type { ComputerUsePolicy } from "../../packages/shared/computer-use-policy.ts";
import type { YourComputerCall } from "../../packages/shared/your-computer.ts";

/** Only the screen-consent layer: tool review and OS permissions remain separate. */
export class ComputerUsePermission {
  private revision = 0;
  private readonly turns = new Map<string, { generation: string; revision: number; consent: boolean; pending?: Promise<void>; refused?: { revision: number; error: unknown } }>();
  private readonly policy: () => ComputerUsePolicy;
  private readonly ask: (threadId: string, generation: string, call?: YourComputerCall) => Promise<void>;
  constructor(policy: () => ComputerUsePolicy, ask: (threadId: string, generation: string, call?: YourComputerCall) => Promise<void>) {
    this.policy = policy;
    this.ask = ask;
  }

  register(threadId: string, generation: string, explicitlySelected: boolean): void {
    this.turns.set(threadId, { generation, revision: this.revision, consent: explicitlySelected });
  }
  forget(threadId: string, generation: string): void {
    if (this.turns.get(threadId)?.generation === generation) this.turns.delete(threadId);
  }
  changed(): void { this.revision++; }
  async check(threadId: string, generation: string, call?: YourComputerCall): Promise<void> {
    const turn = this.turns.get(threadId);
    if (!turn || turn.generation !== generation) throw new Error("This turn has no registered permission to use this computer. This call was not performed.");
    for (;;) {
      const policy = this.policy();
      if (policy === "deny") throw new Error("Computer access is set to Never allow in Settings. This call was not performed.");
      if (policy === "allow") return;
      if (turn.revision === this.revision && turn.consent) return;
      if (turn.refused?.revision === this.revision) throw turn.refused.error;
      const revision = this.revision;
      turn.pending ??= this.ask(threadId, generation, call);
      const pending = turn.pending;
      try { await pending; }
      catch (error) { turn.refused = { revision, error }; throw error; }
      finally { if (turn.pending === pending) turn.pending = undefined; }
      if (this.turns.get(threadId) !== turn) throw new Error("This computer request has ended.");
      if (revision !== this.revision) continue;
      turn.revision = revision;
      turn.consent = true;
    }
  }
}
