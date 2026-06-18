// Pure stage reducer for the studio progress panel.
//
// `deriveStages(log, amendRounds, status)` recomputes the full list of pipeline
// stages from the COMPLETE job log on every poll. Because it walks the whole log
// in order each time, it is idempotent (same input -> same output), cannot miss or
// reorder events, reconstructs historical/persisted jobs correctly, and yields
// real per-stage durations from the server-side timestamps for free. It touches no
// DOM and no clock, so it is unit-testable in isolation.
//
// The log strings and event order mirror the Python orchestrator
// (backend/src/pipeline/orchestrator.py + format_event in backend/src/api/generate.py):
//   plan -> plan_done -> asset_start(s) -> asset_done(s) -> layout ->
//   per amend round: render -> critique -> (fix | clean) -> done
// and a cached run emits a single "Response served from cache" line.

import type { LogLine } from "../api/contract";

export type StageState = "pending" | "running" | "done" | "failed";

export interface Stage {
  id: string;
  name: string;
  state: StageState;
  startedAtMs: number | null;
  endedAtMs: number | null;
  estimatedSeconds: number;
}

// Rough per-stage estimates, shown only as "~Ns" on pending rows before a stage runs.
const EST = {
  plan: 25,
  asset: 30,
  layout: 1,
  renderCritique: 65, // render (20) + critique (45) share one log-measurable span
  fix: 1,
  done: 0,
  cached: 0,
} as const;

// Internal working stage carries an optional label so a "Generating asset c/N: label"
// completion line can be paired to the right running asset row (assets run concurrently,
// so the exact which-asset-finished is not recoverable from the log — cosmetic only).
interface WorkStage extends Stage {
  label?: string;
}

function findStage(stages: WorkStage[], id: string): WorkStage | undefined {
  return stages.find((s) => s.id === id);
}

function setRunning(stage: WorkStage | undefined, ts: number): void {
  if (!stage) return;
  stage.state = "running";
  if (stage.startedAtMs === null) stage.startedAtMs = ts;
}

// Mark a stage done at the given boundary timestamp. Idempotent: a stage already done
// (e.g. render[r] done by critique, re-asserted by clean) keeps its first endedAtMs.
function setDone(stage: WorkStage | undefined, ts: number): void {
  if (!stage) return;
  if (stage.state === "done") return;
  stage.state = "done";
  stage.endedAtMs = ts;
}

// Determine the planned object count N from the whole log: prefer "Plan ready — N",
// else the max total seen on a "Starting asset i/N" line, else 1 until anything is known.
function deriveObjectCount(log: LogLine[]): number {
  for (const line of log) {
    const m = line.text.match(/Plan ready — (\d+) object\(s\)/);
    if (m) return parseInt(m[1], 10);
  }
  let maxTotal = 1;
  for (const line of log) {
    const m = line.text.match(/^Starting asset \d+\/(\d+): /);
    if (m) maxTotal = Math.max(maxTotal, parseInt(m[1], 10));
  }
  return maxTotal;
}

export function deriveStages(
  log: LogLine[],
  amendRounds: number,
  status: "running" | "done" | "error",
): Stage[] {
  // Cache hit: a single terminal row. No pipeline stages exist — do not leave provisional
  // plan/asset rows behind.
  const cachedLine = log.find((l) => l.text === "Response served from cache");
  if (cachedLine) {
    return [
      {
        id: "cached",
        name: "Served from cache",
        state: "done",
        startedAtMs: cachedLine.ts,
        endedAtMs: cachedLine.ts,
        estimatedSeconds: EST.cached,
      },
    ];
  }

  const objectCount = deriveObjectCount(log);

  // Build the planned skeleton: plan -> assets 0..N-1 -> layout ->
  // (render+critique, fix) per amend round -> done. amendRounds scaffolds the pending
  // render/fix rows so upcoming stages show with ~estimate before they run.
  const stages: WorkStage[] = [];
  stages.push({
    id: "plan",
    name: "Plan",
    state: "pending",
    startedAtMs: null,
    endedAtMs: null,
    estimatedSeconds: EST.plan,
  });
  for (let i = 0; i < objectCount; i++) {
    stages.push({
      id: `asset-${i}`,
      name: `Asset ${i + 1}`,
      state: "pending",
      startedAtMs: null,
      endedAtMs: null,
      estimatedSeconds: EST.asset,
    });
  }
  stages.push({
    id: "layout",
    name: "Layout",
    state: "pending",
    startedAtMs: null,
    endedAtMs: null,
    estimatedSeconds: EST.layout,
  });
  for (let r = 1; r <= amendRounds; r++) {
    stages.push({
      id: `render-${r}`,
      name: `Render+critique ${r}`,
      state: "pending",
      startedAtMs: null,
      endedAtMs: null,
      estimatedSeconds: EST.renderCritique,
    });
    stages.push({
      id: `fix-${r}`,
      name: `Fix ${r}`,
      state: "pending",
      startedAtMs: null,
      endedAtMs: null,
      estimatedSeconds: EST.fix,
    });
  }
  stages.push({
    id: "done",
    name: "Done",
    state: "pending",
    startedAtMs: null,
    endedAtMs: null,
    estimatedSeconds: EST.done,
  });

  // Walk the log in order, applying transitions using each line's authoritative ts.
  for (const line of log) {
    const { text, ts } = line;

    if (text === "Planning scene…") {
      setRunning(findStage(stages, "plan"), ts);
      continue;
    }

    const planDone = text.match(/Plan ready — (\d+) object\(s\)/);
    if (planDone) {
      setDone(findStage(stages, "plan"), ts);
      continue;
    }

    const assetStart = text.match(/^Starting asset (\d+)\/(\d+): (.*)$/);
    if (assetStart) {
      const index = parseInt(assetStart[1], 10) - 1;
      const label = assetStart[3].trim();
      const stage = findStage(stages, `asset-${index}`);
      if (stage) {
        stage.label = label;
        stage.name = `Asset ${index + 1}: ${label}`;
        setRunning(stage, ts);
      }
      continue;
    }

    const assetDone = text.match(/^Generating asset (\d+)\/(\d+): (.*)$/);
    if (assetDone) {
      const completed = parseInt(assetDone[1], 10);
      const label = assetDone[3].trim();
      const assetStages = stages.filter((s) => s.id.startsWith("asset-"));
      // Pair the completion to the first still-running asset whose label matches; else
      // fall back to the c-th asset by order. (Assets run concurrently, so exact
      // which-asset-finished is not recoverable from the log — cosmetic only.)
      let target = assetStages.find((s) => s.state === "running" && s.label === label);
      if (!target) target = assetStages[completed - 1];
      if (target && target.state !== "done") setDone(target, ts);
      continue;
    }

    const assetFailed = text.match(/^Asset (\d+)\/(\d+) failed: /);
    if (assetFailed) {
      const index = parseInt(assetFailed[1], 10) - 1;
      const stage = findStage(stages, `asset-${index}`);
      // A partial failure marks only this asset row failed; keep its start ts and
      // record the failure boundary. Already-resolved rows (done/failed) keep their
      // state so a job that ends "done" can still carry some failed asset rows.
      if (stage && stage.state !== "done" && stage.state !== "failed") {
        stage.state = "failed";
        if (stage.endedAtMs === null) stage.endedAtMs = ts;
      }
      continue;
    }

    if (text === "Arranging layout…") {
      // Any still-running assets complete at this boundary.
      for (const s of stages) {
        if (s.id.startsWith("asset-") && s.state === "running") setDone(s, ts);
      }
      setRunning(findStage(stages, "layout"), ts);
      continue;
    }

    const renderMatch = text.match(/^Amend (\d+): rendering$/);
    if (renderMatch) {
      const r = parseInt(renderMatch[1], 10);
      setDone(findStage(stages, "layout"), ts); // layout done if still open
      setRunning(findStage(stages, `render-${r}`), ts);
      continue;
    }

    const critiqueMatch = text.match(/^Amend (\d+): (\d+) issue\(s\) found$/);
    if (critiqueMatch) {
      const r = parseInt(critiqueMatch[1], 10);
      setDone(findStage(stages, `render-${r}`), ts); // render+critique span ends here
      setRunning(findStage(stages, `fix-${r}`), ts);
      continue;
    }

    const fixMatch = text.match(/^Amend (\d+): applied fixes$/);
    if (fixMatch) {
      const r = parseInt(fixMatch[1], 10);
      setDone(findStage(stages, `fix-${r}`), ts);
      continue;
    }

    const cleanMatch = text.match(/^Amend (\d+): clean$/);
    if (cleanMatch) {
      const r = parseInt(cleanMatch[1], 10);
      setDone(findStage(stages, `render-${r}`), ts); // idempotent (already done via critique)
      // The loop broke: drop this round's fix row and all later rounds' render/fix rows.
      // (The done terminal row stays pending until "Done —".)
      for (let i = stages.length - 1; i >= 0; i--) {
        const m = stages[i].id.match(/^(render|fix)-(\d+)$/);
        if (!m) continue;
        const round = parseInt(m[2], 10);
        const isFixThisRound = round === r && stages[i].id.startsWith("fix-");
        if (round > r || isFixThisRound) stages.splice(i, 1);
      }
      continue;
    }

    const doneMatch = text.match(/^Done — (\d+) pass\(es\)$/);
    if (doneMatch) {
      for (const s of stages) {
        if (s.state === "running") setDone(s, ts);
      }
      setDone(findStage(stages, "done"), ts);
      continue;
    }
  }

  // Error: the backend signals errors via status/error, not a log line. The in-flight
  // stage(s) become failed; later stages stay pending. Use the last log line's ts as the
  // failure boundary so a real duration is measurable for the failed stage.
  if (status === "error") {
    const lastLogTs = log.length > 0 ? log[log.length - 1].ts : Date.now();
    for (const s of stages) {
      if (s.state === "running") {
        s.state = "failed";
        if (s.endedAtMs === null) s.endedAtMs = lastLogTs;
      }
    }
  }

  // Strip the internal label field from the public shape.
  return stages.map(({ label: _label, ...rest }) => rest);
}
