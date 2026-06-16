// Studio page: prompt -> POST /api/generate (starts a job) -> poll GET /api/generate/<jobId>,
// streaming a live progress log into the panel, then render each returned pass in the SceneViewer
// with a Prev/Next stepper. Frontend wiring over the existing pipeline + viewer; no SceneViewer
// changes. `three` is pulled in only transitively via SceneViewer.
//
// Failure policy (matches the repo's fail-fast principle): network / non-2xx / malformed-shape errors
// are surfaced loudly in the status line and console — never swallowed. The single tolerated-and-
// reported failure is a per-pass GLB load: SceneViewer.loadScene is fail-loud, so a missing or
// unloadable glbUrl throws. We catch THAT (and only that) and show a banner, while the stepper +
// object list stay usable because they are updated before loadScene is awaited.
import { SceneViewer } from "./viewer/SceneViewer";
import type { GenerateRequest, JobStartResponse, JobStatus, LogLine, Pass } from "./api/contract";
import type { SceneState } from "./scene/schema";
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

// Poll cadence for the generate job's progress (a real run is minute-scale).
const POLL_INTERVAL_MS = 1000;

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
const estimatedTotalEl = requireEl("estimated-total", HTMLElement);
const stepListEl = requireEl("step-list", HTMLElement);
const cachedBadge = requireEl("cached-badge", HTMLElement);

const viewer = new SceneViewer(canvas);

let passes: Pass[] = [];
let current = 0;

// Progress panel state: tracks the Run ID, the list of pipeline steps, and the active step so the
// right-hand panel can show a progress bar, elapsed/estimated time, and a cached/error badge.
interface Step {
  name: string;
  estimatedSeconds: number;
}

interface ProgressState {
  jobId: string;
  amendRounds: number;
  objectCount: number | null;
  steps: Step[];
  currentStepIndex: number;
  lastAdvanceAt: number;
  startedAt: number;
  elapsedInterval: number | null;
  cached: boolean;
  done: boolean;
  error: boolean;
}

let progressState: ProgressState | null = null;

function buildSteps(amendRounds: number, objectCount: number | null): Step[] {
  const steps: Step[] = [{ name: "plan", estimatedSeconds: 25 }];
  const count = objectCount ?? 1;
  for (let i = 0; i < count; i++) {
    steps.push({ name: `asset ${i + 1}`, estimatedSeconds: 30 });
  }
  steps.push({ name: "layout", estimatedSeconds: 1 });
  for (let r = 1; r <= amendRounds; r++) {
    steps.push({ name: `render ${r}`, estimatedSeconds: 20 });
    steps.push({ name: `critique ${r}`, estimatedSeconds: 45 });
    steps.push({ name: `fix ${r}`, estimatedSeconds: 1 });
  }
  steps.push({ name: "done", estimatedSeconds: 0 });
  return steps;
}

function estimatedTotalSeconds(steps: Step[]): number {
  return steps.reduce((sum, step) => sum + step.estimatedSeconds, 0);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function startProgress(jobId: string, amendRounds: number): void {
  progressState = {
    jobId,
    amendRounds,
    objectCount: null,
    steps: buildSteps(amendRounds, null),
    currentStepIndex: 0,
    lastAdvanceAt: Date.now(),
    startedAt: Date.now(),
    elapsedInterval: window.setInterval(updateProgressDisplay, 250),
    cached: false,
    done: false,
    error: false,
  };
  runIdEl.textContent = jobId;
  progressPanel.hidden = false;
  cachedBadge.hidden = true;
  updateProgressDisplay();
}

function stopProgress(): void {
  if (progressState?.elapsedInterval) {
    window.clearInterval(progressState.elapsedInterval);
    progressState.elapsedInterval = null;
  }
}

function advanceToStep(index: number): void {
  if (!progressState) return;
  progressState.currentStepIndex = Math.max(progressState.currentStepIndex, index);
  progressState.lastAdvanceAt = Date.now();
  updateProgressDisplay();
}

function applyProgressUpdate(update: {
  objectCount?: number;
  currentStepIndex?: number;
  cached?: boolean;
  done?: boolean;
}): void {
  if (!progressState) return;
  if (update.objectCount !== undefined) {
    progressState.objectCount = update.objectCount;
    progressState.steps = buildSteps(progressState.amendRounds, update.objectCount);
  }
  if (update.currentStepIndex !== undefined) {
    advanceToStep(update.currentStepIndex);
  } else if (update.objectCount !== undefined) {
    updateProgressDisplay();
  }
  if (update.cached) progressState.cached = true;
  if (update.done) progressState.done = true;
}

function parseLogLine(line: string): {
  objectCount?: number;
  currentStepIndex?: number;
  cached?: boolean;
  done?: boolean;
} | null {
  if (!progressState) return null;

  const planDone = line.match(/Plan ready — (\d+) object\(s\)/);
  if (planDone) {
    return { objectCount: parseInt(planDone[1], 10), currentStepIndex: 1 };
  }

  const assetDone = line.match(/Generating asset (\d+)\/(\d+):/);
  if (assetDone) {
    const completed = parseInt(assetDone[1], 10);
    return { currentStepIndex: 1 + completed };
  }

  if (line === "Arranging layout…") {
    const layoutIndex = 1 + (progressState.objectCount ?? 1);
    return { currentStepIndex: layoutIndex + 1 };
  }

  const renderMatch = line.match(/Amend (\d+): rendering/);
  if (renderMatch) {
    const round = parseInt(renderMatch[1], 10);
    const layoutIndex = 1 + (progressState.objectCount ?? 1);
    return { currentStepIndex: layoutIndex + 1 + (round - 1) * 3 };
  }

  const critiqueMatch = line.match(/Amend (\d+): (\d+) issue\(s\) found/);
  if (critiqueMatch) {
    const round = parseInt(critiqueMatch[1], 10);
    const layoutIndex = 1 + (progressState.objectCount ?? 1);
    return { currentStepIndex: layoutIndex + 2 + (round - 1) * 3 };
  }

  const fixMatch = line.match(/Amend (\d+): applied fixes/);
  if (fixMatch) {
    const round = parseInt(fixMatch[1], 10);
    const layoutIndex = 1 + (progressState.objectCount ?? 1);
    return { currentStepIndex: layoutIndex + 3 + (round - 1) * 3 };
  }

  const cleanMatch = line.match(/Amend (\d+): clean/);
  if (cleanMatch) {
    return { done: true };
  }

  if (line.match(/Done — \d+ pass\(es\)/)) {
    return { done: true };
  }

  if (line.includes("served from cache")) {
    return { cached: true, done: true };
  }

  return null;
}

function updateProgressDisplay(): void {
  if (!progressState) return;
  const state = progressState;
  const now = Date.now();
  const elapsedMs = now - state.startedAt;
  elapsedEl.textContent = `Elapsed: ${formatDuration(elapsedMs / 1000)}`;

  if (state.objectCount !== null) {
    const totalEst = estimatedTotalSeconds(state.steps);
    estimatedTotalEl.hidden = false;
    estimatedTotalEl.textContent = `Estimated total: ${formatDuration(totalEst)}`;
  } else {
    estimatedTotalEl.hidden = true;
  }

  const totalUnits = state.steps.length;
  const completedUnits = Math.min(state.currentStepIndex, totalUnits - 1);
  const currentStep = state.steps[state.currentStepIndex];

  let withinCurrent = 0;
  if (currentStep && currentStep.estimatedSeconds > 0 && !state.done && !state.error) {
    const elapsedInStepMs = now - state.lastAdvanceAt;
    withinCurrent = Math.min(elapsedInStepMs / (currentStep.estimatedSeconds * 1000), 1);
  }

  let fraction = (completedUnits + withinCurrent) / totalUnits;
  if (state.done || state.cached) fraction = 1;

  progressFill.style.width = `${fraction * 100}%`;
  progressFill.classList.toggle("error", state.error);
  progressFill.classList.toggle("cached", state.cached && !state.error);
  cachedBadge.hidden = !state.cached;

  stepListEl.replaceChildren();
  for (let i = 0; i < state.steps.length; i++) {
    const step = state.steps[i];
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = step.name;
    const time = document.createElement("span");
    time.textContent = step.estimatedSeconds > 0 ? `~${step.estimatedSeconds}s` : "";
    li.append(name, time);

    if (state.error && i === state.currentStepIndex) {
      li.classList.add("error");
    } else if (i < state.currentStepIndex || state.done || state.cached) {
      li.classList.add("done");
    } else if (i === state.currentStepIndex) {
      li.classList.add("current");
    }
    stepListEl.append(li);
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
  generateBtn.disabled = false;
}

async function onGenerate(): Promise<void> {
  // An empty box runs the default preset (the curated StarCraft demo, shown as the placeholder); reflect
  // the resolved prompt back into the input so the UI shows what actually ran, then record it.
  const prompt = promptInput.value.trim() || promptForPreset(DEFAULT_PRESET_ID);
  promptInput.value = prompt;
  addToHistory(prompt);
  rebuildPromptOptions();
  generateBtn.disabled = true;
  setStatus("Generating…");
  clearBanner();
  logEl.replaceChildren();

  let jobId: string;
  try {
    // Clamp/validate the control to a non-negative integer (empty/invalid input -> 0 = draft only).
    const parsedRounds = Number.parseInt(amendRoundsInput.value, 10);
    const amendRounds = Number.isNaN(parsedRounds) ? 0 : Math.max(0, parsedRounds);
    const body: GenerateRequest = { prompt, amendRounds };
    const res = await fetch("/api/generate", {
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
  // next). Each tick appends only the new log lines, tracked via `shown`.
  let shown = 0;
  const poll = async (): Promise<void> => {
    try {
      const res = await fetch(`/api/generate/${jobId}`);
      if (!res.ok) {
        throw new Error(`/api/generate/${jobId} ${res.status}: ${await res.text()}`);
      }
      const status = (await res.json()) as JobStatus;
      const previouslyShown = shown;
      shown = appendLogLines(status.log, shown);

      for (let i = previouslyShown; i < status.log.length; i++) {
        const update = parseLogLine(status.log[i].text);
        if (update) applyProgressUpdate(update);
      }
      if (status.cached) applyProgressUpdate({ cached: true, done: true });
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
      current = 0;
      stepperEl.hidden = false;
      setStatus(`Done — ${passes.length} pass${passes.length === 1 ? "" : "es"} for “${prompt}”.`);
      await renderPass(0);
      generateBtn.disabled = false;
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
