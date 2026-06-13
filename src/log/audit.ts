import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Backend audit logger: every Claude CLI call and every key Meshy pipeline event is
// appended to disk so a paid, multi-minute generation is fully reconstructable after the
// fact. Events are grouped per request by a runId carried in AsyncLocalStorage.
//
// EXCEPTION to the repo-wide fail-loud rule: every write here is BEST-EFFORT. A lost log
// line must never break (or abort) a possibly paid generation, so all fs work is wrapped
// and this module NEVER throws — on failure it reports to stderr and continues.

const UNASSIGNED_RUN = "_unassigned";

const runStore = new AsyncLocalStorage<string>();

// Log root mirrors the ~/.cache/dream3d data-dir convention (see server/apiPlugin.ts),
// overridable via DREAM3D_LOG_DIR. Read lazily so the env var can be set before any write.
function logRoot(): string {
  return process.env.DREAM3D_LOG_DIR ?? join(homedir(), ".cache", "dream3d", "uuid");
}

export function newId(): string {
  return randomUUID();
}

// Bind `runId` as the current request id for the duration of `fn`; nested logEvent /
// logClaudeCall calls (sync or async) then land under <logRoot>/<runId>/. PHASE 1 never
// calls this, so events fall under "_unassigned" until a later phase wraps the handler.
export function withRun<T>(runId: string, fn: () => T): T {
  return runStore.run(runId, fn);
}

export function currentRunId(): string {
  return runStore.getStore() ?? UNASSIGNED_RUN;
}

// Append one JSON line to <logRoot>/<runId>/events.jsonl. Best-effort: never throws.
export function logEvent(event: Record<string, unknown>): void {
  const runId = currentRunId();
  try {
    const dir = join(logRoot(), runId);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), runId, ...event });
    appendFileSync(join(dir, "events.jsonl"), `${line}\n`);
  } catch (err) {
    console.error("[dream3d-audit] log write failed:", err);
  }
}

// Persist the FULL Claude call payload as pretty JSON under <logRoot>/<runId>/llm/, then
// append a compact summary line to events.jsonl. Best-effort: never throws.
export function logClaudeCall(payload: Record<string, unknown>): void {
  const runId = currentRunId();
  const caller = String(payload.caller);
  const callId = String(payload.callId);
  try {
    const dir = join(logRoot(), runId, "llm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${caller}-${callId}.json`), JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("[dream3d-audit] log write failed:", err);
  }

  const summary: Record<string, unknown> = {
    kind: "llm.call",
    callId: payload.callId,
    caller: payload.caller,
    model: payload.model,
    ok: payload.ok,
    durationMs: payload.durationMs,
  };
  if (payload.session_id !== undefined) summary.sessionId = payload.session_id;
  if (payload.total_cost_usd !== undefined) summary.costUsd = payload.total_cost_usd;
  if (payload.usage !== undefined) summary.usage = payload.usage;
  logEvent(summary);
}
