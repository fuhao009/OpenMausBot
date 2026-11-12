export type ComputerUsePolicy = "ask" | "allow" | "deny";

export function isComputerUsePolicy(value: unknown): value is ComputerUsePolicy {
  return value === "ask" || value === "allow" || value === "deny";
}

/** Workspace backups cannot authorize a different desktop installation. */
export function effectiveComputerUsePolicy(stored: { computerUsePolicy?: ComputerUsePolicy; computerUsePolicyDevice?: string }, device: string | undefined): ComputerUsePolicy {
  return device && stored.computerUsePolicyDevice === device ? stored.computerUsePolicy ?? "ask" : "ask";
}
