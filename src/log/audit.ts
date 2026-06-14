import { appendFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GenerateResponse } from "../api/contract";

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

// Best-effort audit copy of a finished run's source assets: symlink each scene object's
// LOCAL on-disk .glb into <logRoot>/<runId>/assets/ so the per-run log dir is a complete,
// self-contained record of what the run produced. Browser-facing values are skipped — a
// "/assets/<hash>.glb" path or an http(s):// URL is the publishSceneAssets serving rewrite,
// not a real local file. Like the rest of this module it is BEST-EFFORT and NEVER throws:
// a failed mirror must not abort a possibly paid generation.
export function mirrorRunAssets(result: GenerateResponse): void {
  try {
    const dir = join(logRoot(), currentRunId(), "assets");
    mkdirSync(dir, { recursive: true });
    const seen = new Set<string>();
    for (const pass of result.passes) {
      for (const obj of pass.sceneState.objects) {
        const src = obj.glbUrl;
        // Dedupe identical sources (the same asset recurs across passes) so each is
        // symlinked at most once; skip empties, serving paths, and remote URLs.
        if (!src || seen.has(src)) continue;
        seen.add(src);
        if (src.startsWith("/assets/") || /^https?:\/\//i.test(src)) continue;
        if (!existsSync(src)) continue;
        const safeId = obj.id.replace(/[^a-zA-Z0-9_-]/g, "_");
        symlinkSync(src, join(dir, `${safeId}.glb`));
      }
    }
  } catch (err) {
    console.error("[dream3d-audit] mirror assets failed:", err);
  }
}
