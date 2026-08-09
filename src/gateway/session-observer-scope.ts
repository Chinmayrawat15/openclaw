import { normalizeAgentId } from "../routing/session-key.js";

// Global session storage uses an agent-relative key; live subscriptions must
// qualify it so identically named sessions never cross agent boundaries.
export function sessionObserverScopeKey(sessionKey: string, agentId: string): string {
  return sessionKey === "global" ? `agent:${normalizeAgentId(agentId)}:global` : sessionKey;
}
