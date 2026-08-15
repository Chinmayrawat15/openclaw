import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";

// Worker identity is resolved once at startup and on supervision checks, not on
// a timer, so it keeps the Windows reader's original 5s-per-attempt tolerance
// rather than the shorter lock-owner default. Shortening it would let a slow
// PowerShell/WMIC probe fail worker startup closed where it previously
// succeeded.
const WORKER_IDENTITY_PROBE_TIMEOUT_MS = 5000;

export type NodeWorkerProcessIdentity = {
  pid: number;
  startTime: number;
};

type NodeWorkerProcessIdentityState = "live" | "dead" | "reused" | "unknown";

export function requireNodeWorkerProcessIdentity(pid: number): NodeWorkerProcessIdentity {
  const startTime = getFileLockProcessStartTime(pid, WORKER_IDENTITY_PROBE_TIMEOUT_MS);
  if (startTime === null) {
    throw new Error(`cannot establish PID-reuse-safe identity for process ${pid}`);
  }
  return { pid, startTime };
}

export function inspectNodeWorkerProcessIdentity(
  identity: NodeWorkerProcessIdentity,
): NodeWorkerProcessIdentityState {
  const observedStartTime = getFileLockProcessStartTime(
    identity.pid,
    WORKER_IDENTITY_PROBE_TIMEOUT_MS,
  );
  if (observedStartTime !== null) {
    if (observedStartTime !== identity.startTime) {
      return "reused";
    }
    return isPidDefinitelyDead(identity.pid) ? "dead" : "live";
  }
  return isPidDefinitelyDead(identity.pid) ? "dead" : "unknown";
}
