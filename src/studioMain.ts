// Studio page: prompt -> POST /api/generate (starts a job) -> poll GET /api/generate/<jobId>,
// streaming a live progress log into the panel, then render each returned pass in the SceneViewer
// with a Prev/Next stepper. Frontend wiring over the existing pipeline + viewer; no SceneViewer
// changes. `three` is pulled in only transitively via SceneViewer.
//
// Failure policy (matches the repo's fail-fast principle): network / non-2xx / malformed-shape errors
// are surfaced loudly in the status line and console — never swallowed. The single tolerated-and-
// reported failure is a per-pass GLB load: SceneViewer.loadScene is fail-loud, so in MOCK mode its
// placeholder glbUrls 404 and the call throws. We catch THAT (and only that) and show a banner, while
// the stepper + object list stay usable because they are updated before loadScene is awaited.
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

// Poll cadence for the generate job's progress (a real run is minute-scale; mock finishes instantly).
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

const viewer = new SceneViewer(canvas);

let passes: Pass[] = [];
let current = 0;

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
// so they stay usable even when the render throws (e.g. MOCK-mode placeholder GLBs that 404).
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
    showBanner(
      `Scene render failed: ${message}. ` +
        "(In mock mode GLB urls are placeholders and 404; real mode resolves them.)",
    );
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
      shown = appendLogLines(status.log, shown);

      if (status.status === "running") {
        window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        return;
      }
      if (status.status === "error") {
        failGenerate(new Error(status.error ?? "job failed with no error message"));
        return;
      }
      // status === "done": render the result's passes (fail loud if missing/empty).
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
prevBtn.addEventListener("click", () => void renderPass(current - 1));
nextBtn.addEventListener("click", () => void renderPass(current + 1));

// First load: leave the prompt input empty so opening the <datalist> shows ALL presets (a prefilled
// value makes the browser filter the suggestions down to the one matching preset). Surface the default
// StarCraft prompt as the placeholder instead — one click of Generate on the empty box still runs the
// demo (see onGenerate) — then seed the <datalist> with the presets + any saved prompt history.
promptInput.placeholder = promptForPreset(DEFAULT_PRESET_ID);
rebuildPromptOptions();
