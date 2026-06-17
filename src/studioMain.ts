// Studio page: prompt -> POST /api/generate (starts a job) -> poll GET /api/generate/<jobId>,
// streaming a live progress log into the panel, then render each returned pass in the SceneViewer
// with a Prev/Next stepper. The progress panel is driven by a PURE stage reducer
// (src/studio/deriveStages.ts) recomputed from the full job log on every poll — one unified list
// of plan/assets/layout/amend/done rows, each with a spinner while active, a ✓ when done, and its
// real measured duration. `three` is pulled in only transitively via SceneViewer.
//
// Failure policy (matches the repo's fail-fast principle): network / non-2xx / malformed-shape errors
// are surfaced loudly in the status line and console — never swallowed. The single tolerated-and-
// reported failure is a per-pass GLB load: SceneViewer.loadScene is fail-loud, so a missing or
// unloadable glbUrl throws. We catch THAT (and only that) and show a banner, while the stepper +
// object list stay usable because they are updated before loadScene is awaited.
import { SceneViewer } from "./viewer/SceneViewer";
import type { GenerateRequest, JobStartResponse, JobStatus, LogLine, Pass } from "./api/contract";
import type { SceneState } from "./scene/schema";
import { deriveStages, type Stage, type StageState } from "./studio/deriveStages";
import scenePresetsJson from "../config/scene-presets.json";

// Committed preset prompts (config/scene-presets.json), surfaced as the "Preset" dropdown. Typed
// locally so the populate/lookup code is explicit regardless of the JSON module's inferred type.
interface ScenePreset {
  id: string;
  label: string;
  prompt: string;
}
const scenePresets = scenePresetsJson as ScenePreset[];
const DEFAULT_PRESET_ID = "sc-demo";

// Optional base URL for API/asset requests. In dev mode the Vite server proxies
// /api and /assets to the Python backend, so the default empty string (relative
// paths) is correct. Set VITE_API_BASE_URL to hit the backend directly, e.g.
// when running the built frontend against a remote backend.
const API_BASE: string = (import.meta.env as Record<string, string | undefined>).VITE_API_BASE_URL ?? "";

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function resolveAssetUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  if (url.startsWith("/assets/")) return `${API_BASE}${url}`;
  return url;
}

function resolveSceneStateAssets(scene: SceneState): SceneState {
  for (const obj of scene.objects) {
    obj.glbUrl = resolveAssetUrl(obj.glbUrl);
  }
  return scene;
}

// Poll cadence for the generate job's progress (a real run is minute-scale). The render interval is
// finer so the running row's live timer ticks smoothly.
const POLL_INTERVAL_MS = 1000;
const RENDER_TICK_MS = 250;

// Resolve a required element by id, throwing loudly if it is missing or the wrong tag (fail fast — a
// missing node means studio.html and this module drifted out of sync).
function requireEl<T extends Element>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) {
    throw new Error(`studio.html is missing required element #${id}`);
  }
  return el;
}

const canvas = requireEl("viewer", HTMLCanvasElement);
const promptInput = requireEl("prompt", HTMLInputElement);
const promptOptions = requireEl("prompt-options", HTMLDataListElement);
const amendRoundsInput = requireEl("amend-rounds", HTMLInputElement);
const generateBtn = requireEl("generate", HTMLButtonElement);
const statusEl = requireEl("status", HTMLElement);
const bannerEl = requireEl("banner", HTMLElement);
const stepperEl = requireEl("stepper", HTMLElement);
const prevBtn = requireEl("prev", HTMLButtonElement);
const nextBtn = requireEl("next", HTMLButtonElement);
const passLabel = requireEl("pass-label", HTMLElement);
const objectList = requireEl("object-list", HTMLElement);
const logEl = requireEl("log", HTMLPreElement);
const progressPanel = requireEl("progress-panel", HTMLElement);
const runIdEl = requireEl("run-id", HTMLElement);
const copyRunIdBtn = requireEl("copy-run-id", HTMLButtonElement);
const progressFill = requireEl("progress-fill", HTMLElement);
const elapsedEl = requireEl("elapsed", HTMLElement);
const stageListEl = requireEl("stage-list", HTMLElement);
const cachedBadge = requireEl("cached-badge", HTMLElement);

const viewer = new SceneViewer(canvas);

let passes: Pass[] = [];
let current = 0;

// Progress panel state: holds the latest job snapshot so the stage reducer can recompute the full
// stage list each render tick. The reducer (deriveStages) is pure and stateless; this just feeds it
// the whole log + status, plus the cached/done/error flags for the progress bar + badges.
interface ProgressState {
  jobId: string;
  amendRounds: number;
  startedAt: number;
  renderInterval: number | null;
  cached: boolean;
  done: boolean;
  error: boolean;
  log: LogLine[];
  status: "running" | "done" | "error";
}

let progressState: ProgressState | null = null;

// Clock-skew-safe anchors for the running rows' live timers. Keyed by stage id, valued with the
// CLIENT Date.now() observed when the row first became running (kept across re-derivations). This
// avoids subtracting server startedAtMs from client Date.now() (which breaks under clock skew); on
// completion the row snaps to the accurate server endedAtMs - startedAtMs.
const runningAnchors = new Map<string, number>();

// Mounted stage rows, keyed by stage id. The per-tick render reconciles this map in place
// (upsert + drop) instead of rebuilding the list, so the animated spinner <span> of a
// running stage is created once and lives until that stage changes state. Recreating it
// every tick — the old replaceChildren path — restarted the CSS animation from 0° and
// made the icon flicker instead of spinning smoothly.
interface StageRow {
  li: HTMLLIElement;
  iconEl: HTMLSpanElement;
  nameEl: HTMLSpanElement;
  timeEl: HTMLSpanElement;
  state: StageState | null;
}
const stageRows = new Map<string, StageRow>();

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

// The terminal done/cached rows show only their ✓ — no timer. Done rows show the real server
// span; running rows tick from their client anchor; pending rows show the ~estimate.
function formatStageTime(s: Stage, now: number): string {
  if (s.id === "done" || s.id === "cached") return "";
  if (s.state === "done" && s.startedAtMs !== null && s.endedAtMs !== null) {
    return formatDuration((s.endedAtMs - s.startedAtMs) / 1000);
  }
  if (s.state === "running") {
    const anchor = runningAnchors.get(s.id);
    if (anchor !== undefined) return formatDuration((now - anchor) / 1000);
    return "";
  }
  if (s.state === "failed" && s.startedAtMs !== null && s.endedAtMs !== null) {
    return formatDuration((s.endedAtMs - s.startedAtMs) / 1000);
  }
  if (s.state === "failed") return "";
  return s.estimatedSeconds > 0 ? `~${s.estimatedSeconds}s` : "";
}

function startProgress(jobId: string, amendRounds: number): void {
  progressState = {
    jobId,
    amendRounds,
    startedAt: Date.now(),
    renderInterval: window.setInterval(updateProgressDisplay, RENDER_TICK_MS),
    cached: false,
    done: false,
    error: false,
    log: [],
    status: "running",
  };
  runningAnchors.clear();
  runIdEl.textContent = jobId;
  progressPanel.hidden = false;
  cachedBadge.hidden = true;
  stageListEl.replaceChildren();
  stageRows.clear();
  updateProgressDisplay();
}

function stopProgress(): void {
  if (progressState?.renderInterval) {
    window.clearInterval(progressState.renderInterval);
    progressState.renderInterval = null;
  }
}

function updateProgressDisplay(): void {
  if (!progressState) return;
  const state = progressState;
  const now = Date.now();
  elapsedEl.textContent = `Elapsed: ${formatDuration((now - state.startedAt) / 1000)}`;

  const stages = deriveStages(state.log, state.amendRounds, state.status);

  // Maintain client anchors for running rows (set once per stage; dropped when it leaves running
  // or is no longer in the list — e.g. fix[r] dropped by a clean round).
  const currentIds = new Set(stages.map((s) => s.id));
  for (const id of [...runningAnchors.keys()]) {
    if (!currentIds.has(id)) runningAnchors.delete(id);
  }
  for (const s of stages) {
    if (s.state === "running") {
      if (!runningAnchors.has(s.id)) runningAnchors.set(s.id, now);
    } else if (runningAnchors.has(s.id)) {
      runningAnchors.delete(s.id);
    }
  }

  // Progress bar: completed stages + a partial for each running stage from its client anchor.
  let units = 0;
  for (const s of stages) {
    if (s.state === "done" || s.state === "failed") {
      units += 1;
    } else if (s.state === "running") {
      const anchor = runningAnchors.get(s.id);
      if (anchor !== undefined && s.estimatedSeconds > 0) {
        units += Math.min((now - anchor) / 1000 / s.estimatedSeconds, 1);
      }
    }
  }
  let fraction = stages.length > 0 ? units / stages.length : 0;
  if (state.done || state.cached) fraction = 1;
  progressFill.style.width = `${Math.min(fraction, 1) * 100}%`;
  progressFill.classList.toggle("error", state.error);
  progressFill.classList.toggle("cached", state.cached && !state.error);
  cachedBadge.hidden = !state.cached;

  // Reconcile the stage list in place, keyed by stage id: upsert each row and rewrite
  // only its changed fields — never rebuild a row that already exists. This keeps the
  // animated spinner <span> of a running stage alive across ticks (the old
  // replaceChildren-every-tick path recreated it each tick, restarting the CSS animation
  // from 0° and making the icon flicker). Several assets spin concurrently; every stage
  // kind — plan/assets/layout/render/fix/done alike — gets the same treatment.
  const seen = new Set<string>();
  let ref: Element | null = null;
  for (const s of stages) {
    seen.add(s.id);
    let row: StageRow | undefined = stageRows.get(s.id);
    if (!row) {
      const li = document.createElement("li");
      const iconEl = document.createElement("span");
      iconEl.className = "stage-icon";
      const nameEl = document.createElement("span");
      nameEl.className = "stage-name";
      const timeEl = document.createElement("span");
      timeEl.className = "stage-time";
      li.append(iconEl, nameEl, timeEl);
      row = { li, iconEl, nameEl, timeEl, state: null };
      stageRows.set(s.id, row);
    }

    // Keep DOM order matching stage order, but only move a row when it is actually out of
    // place — a running spinner already in position is never disturbed.
    const expectedPos: Element | null = ref ? ref.nextElementSibling : stageListEl.firstElementChild;
    if (expectedPos !== row.li) {
      stageListEl.insertBefore(row.li, expectedPos);
    }
    ref = row.li;

    // A state transition is the only time the row's class or icon changes; while a stage
    // stays running its .spinner <span> is left entirely alone so its animation runs on.
    if (row.state !== s.state) {
      row.state = s.state;
      row.li.className = `stage-row stage-state-${s.state}`;
      row.iconEl.className = "stage-icon";
      if (s.state === "running") {
        row.iconEl.classList.add("spinner");
        row.iconEl.textContent = "";
      } else if (s.state === "done") {
        row.iconEl.classList.add("done");
        row.iconEl.textContent = "✓";
      } else if (s.state === "failed") {
        row.iconEl.classList.add("failed");
        row.iconEl.textContent = "✕";
      } else {
        row.iconEl.classList.add("pending");
        row.iconEl.textContent = "·";
      }
    }

    // An asset's name gains its label once "Starting asset i/N: label" arrives.
    if (row.nameEl.textContent !== s.name) {
      row.nameEl.textContent = s.name;
      row.nameEl.title = s.name;
    }

    row.timeEl.textContent = formatStageTime(s, now);
  }

  // Drop rows whose id is no longer present (e.g. clean drops the round's fix row, or a
  // cache-hit collapses to one row).
  for (const [id, row] of stageRows) {
    if (!seen.has(id)) {
      row.li.remove();
      stageRows.delete(id);
    }
  }
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function showBanner(text: string): void {
  bannerEl.textContent = text;
  bannerEl.hidden = false;
}

function clearBanner(): void {
  bannerEl.textContent = "";
  bannerEl.hidden = true;
}

// Drive the Generate button's "Generating…" state: disabled + an always-visible inline spinner,
// covering the plan phase and the brief cached-hit flash. Restored on done/error.
function setGenerating(running: boolean): void {
  generateBtn.disabled = running;
  generateBtn.classList.toggle("loading", running);
  generateBtn.textContent = running ? "Generating…" : "Generate";
}

// Resolve a preset's prompt by id, failing loud on an unknown id — that only happens if
// scene-presets.json and DEFAULT_PRESET_ID drift apart. One lookup behind both the first-load
// placeholder and the empty-box Generate fallback, which surface the curated default prompt.
function promptForPreset(id: string): string {
  const preset = scenePresets.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`scene-presets.json has no preset with id "${id}"`);
  }
  return preset.prompt;
}

// Prior SENT prompts, newest-first, kept in localStorage so the <datalist> can suggest them across
// sessions. Cap the list so it can't grow without bound.
const HISTORY_KEY = "dream3d.promptHistory";
const HISTORY_CAP = 20;

// Read saved history; a missing key yields []. A corrupt value (unparseable, or not an array of strings)
// is logged and discarded rather than thrown — the one tolerated-and-reported failure here, mirroring the
// GLB-404 banner above (logged, not silently swallowed); every other path in this file stays fail-loud.
function loadHistory(): string[] {
  const raw = localStorage.getItem(HISTORY_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item: unknown) => typeof item === "string")) {
      throw new Error("promptHistory is not an array of strings");
    }
    return parsed;
  } catch (err) {
    console.warn("[studio] discarding corrupt promptHistory", err);
    return [];
  }
}

function saveHistory(list: string[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

// Record a just-sent prompt at the front, de-duped case-insensitively, capped at HISTORY_CAP entries.
function addToHistory(prompt: string): void {
  const p = prompt.trim();
  if (!p) return;
  const list = loadHistory().filter((entry) => entry.toLowerCase() !== p.toLowerCase());
  list.unshift(p);
  saveHistory(list.slice(0, HISTORY_CAP));
}

// Rebuild the <datalist> suggestions: the curated presets first (file order), then prior sent prompts
// (newest-first) that aren't already a preset, so a sent prompt identical to a preset isn't listed twice.
function rebuildPromptOptions(): void {
  promptOptions.replaceChildren();
  const appendOption = (text: string): void => {
    const o = document.createElement("option");
    o.value = text;
    promptOptions.append(o);
  };
  for (const preset of scenePresets) {
    appendOption(preset.prompt);
  }
  const presetPrompts = new Set(scenePresets.map((preset) => preset.prompt.trim().toLowerCase()));
  for (const entry of loadHistory()) {
    if (!presetPrompts.has(entry.trim().toLowerCase())) {
      appendOption(entry);
    }
  }
}

// Rebuild the side panel from a pass's objects: one row per object showing id · label · status · glbUrl.
function renderObjectList(scene: SceneState): void {
  objectList.replaceChildren();
  if (scene.objects.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "(no objects in this pass)";
    objectList.append(empty);
    return;
  }
  for (const obj of scene.objects) {
    const row = document.createElement("li");

    const title = document.createElement("div");
    title.className = "row-title";
    const idCode = document.createElement("code");
    idCode.textContent = obj.id;
    const badge = document.createElement("span");
    badge.className = `badge badge-${obj.status}`;
    badge.textContent = obj.status;
    title.append(idCode, document.createTextNode(obj.label), badge);

    const url = document.createElement("div");
    url.className = "row-url";
    url.textContent = obj.glbUrl ?? "(no glbUrl)";

    row.append(title, url);
    objectList.append(row);
  }
}

// Show pass i (clamped). The label / stepper state / object list are updated BEFORE awaiting loadScene
// so they stay usable even when the render throws (e.g. a missing or unloadable glbUrl).
async function renderPass(i: number): Promise<void> {
  if (passes.length === 0) return;
  current = Math.min(Math.max(i, 0), passes.length - 1);
  const scene = passes[current].sceneState;

  // Pass 0 is the draft; pass k>=1 is the scene after amend round k. Show the round total either way.
  passLabel.textContent =
    current === 0
      ? `Draft — 0 / ${passes.length - 1} rounds`
      : `After round ${current} / ${passes.length - 1}`;
  prevBtn.disabled = current === 0;
  nextBtn.disabled = current === passes.length - 1;
  renderObjectList(scene);

  try {
    await viewer.loadScene(scene);
    clearBanner();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showBanner(`Scene render failed: ${message}.`);
  }
}

// Append log lines beyond `shown` to #log, auto-scroll to the newest, and mirror the latest line into
// the status text; return the new shown-count so the next poll only renders fresh entries.
function appendLogLines(log: LogLine[], shown: number): number {
  for (let i = shown; i < log.length; i++) {
    logEl.append(document.createTextNode(`${log[i].text}\n`));
  }
  if (log.length > shown) {
    logEl.scrollTop = logEl.scrollHeight;
    setStatus(log[log.length - 1].text);
  }
  return log.length;
}

function appendLogText(text: string): void {
  logEl.append(document.createTextNode(`${text}\n`));
  logEl.scrollTop = logEl.scrollHeight;
}

// Fail loud: surface the error in the status line + log + console, and re-enable Generate.
function failGenerate(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  setStatus(`Error: ${message}`);
  appendLogText(`Error: ${message}`);
  console.error("[studio] generate failed:", err);
  setGenerating(false);
}

async function onGenerate(): Promise<void> {
  // An empty box runs the default preset (the curated StarCraft demo, shown as the placeholder); reflect
  // the resolved prompt back into the input so the UI shows what actually ran, then record it.
  const prompt = promptInput.value.trim() || promptForPreset(DEFAULT_PRESET_ID);
  promptInput.value = prompt;
  addToHistory(prompt);
  rebuildPromptOptions();
  setGenerating(true);
  setStatus("Generating…");
  clearBanner();
  logEl.replaceChildren();

  // Clear the previous 3D scene + pass UI immediately so Generate starts from a clean canvas — the old
  // scene and its metadata vanish the instant Generate is clicked.
  viewer.clear();
  passes = [];
  current = 0;
  stepperEl.hidden = true;
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  passLabel.textContent = "";
  objectList.replaceChildren();

  let jobId: string;
  try {
    // Clamp/validate the control to a non-negative integer (empty/invalid input -> 0 = draft only).
    const parsedRounds = Number.parseInt(amendRoundsInput.value, 10);
    const amendRounds = Number.isNaN(parsedRounds) ? 0 : Math.max(0, parsedRounds);
    const body: GenerateRequest = { prompt, amendRounds };
    const res = await fetch(apiUrl("/api/generate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Surface the server's error body verbatim — do not swallow.
      throw new Error(`/api/generate ${res.status}: ${await res.text()}`);
    }
    const started = (await res.json()) as JobStartResponse;
    if (typeof started.jobId !== "string" || started.jobId.length === 0) {
      const got = JSON.stringify(started).slice(0, 300);
      throw new Error(`malformed /api/generate response: expected { jobId }, got ${got}`);
    }
    jobId = started.jobId;
    startProgress(jobId, amendRounds);
  } catch (err) {
    failGenerate(err);
    return;
  }

  // Poll the job on a RECURSIVE setTimeout (never setInterval, so a slow poll never overlaps the
  // next). Each tick stores the full job snapshot (deriveStages recomputes the stages from it) and
  // appends only the new log lines to #log, tracked via `shown`.
  let shown = 0;
  const poll = async (): Promise<void> => {
    try {
      const res = await fetch(apiUrl(`/api/generate/${jobId}`));
      if (!res.ok) {
        throw new Error(`/api/generate/${jobId} ${res.status}: ${await res.text()}`);
      }
      const status = (await res.json()) as JobStatus;
      if (progressState) {
        progressState.log = status.log;
        progressState.status = status.status;
        if (status.cached) progressState.cached = true;
      }
      shown = appendLogLines(status.log, shown);
      updateProgressDisplay();

      if (status.status === "error") {
        if (progressState) progressState.error = true;
        stopProgress();
        updateProgressDisplay();
        failGenerate(new Error(status.error ?? "job failed with no error message"));
        return;
      }

      if (status.status === "running") {
        window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        return;
      }
      // status === "done": render the result's passes (fail loud if missing/empty).
      if (progressState) progressState.done = true;
      stopProgress();
      updateProgressDisplay();
      const result = status.result;
      if (!result || !Array.isArray(result.passes) || result.passes.length === 0) {
        const got = JSON.stringify(result).slice(0, 300);
        throw new Error(`malformed job result: expected non-empty passes[], got ${got}`);
      }
      passes = result.passes;
      for (const pass of passes) {
        resolveSceneStateAssets(pass.sceneState);
      }
      current = 0;
      stepperEl.hidden = false;
      setStatus(`Done — ${passes.length} pass${passes.length === 1 ? "" : "es"} for “${prompt}”.`);
      await renderPass(0);
      setGenerating(false);
    } catch (err) {
      failGenerate(err);
    }
  };
  void poll();
}

generateBtn.addEventListener("click", () => void onGenerate());
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void onGenerate();
});
copyRunIdBtn.addEventListener("click", async () => {
  const id = runIdEl.textContent ?? "";
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    const original = copyRunIdBtn.textContent;
    copyRunIdBtn.textContent = "Copied";
    window.setTimeout(() => (copyRunIdBtn.textContent = original), 1200);
  } catch (err) {
    console.error("[studio] failed to copy run id:", err);
  }
});
prevBtn.addEventListener("click", () => void renderPass(current - 1));
nextBtn.addEventListener("click", () => void renderPass(current + 1));

// First load: leave the prompt input empty so opening the <datalist> shows ALL presets (a prefilled
// value makes the browser filter the suggestions down to the one matching preset). Surface the default
// StarCraft prompt as the placeholder instead — one click of Generate on the empty box still runs the
// demo (see onGenerate) — then seed the <datalist> with the presets + any saved prompt history.
promptInput.placeholder = promptForPreset(DEFAULT_PRESET_ID);
rebuildPromptOptions();
