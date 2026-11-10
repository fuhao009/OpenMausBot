import type { RequestAuth } from "./request-auth.ts";
import type { DecisionActor } from "./decision-log.ts";

export function decisionActorFor(auth: RequestAuth): DecisionActor {
  if (auth.kind === "loopback") return auth.trust === "service" ? { kind: "worker" } : { kind: "loopback" };
  const session = auth.session;
  return {
    kind: "session", sessionId: session.id, label: session.label,
    ...(session.email ? { email: session.email } : {}),
    // A portal session's id is its membership grant: never written down.
    ...(session.userId && !session.userId.startsWith("portal:") ? { userId: session.userId } : {}),
  };
}
