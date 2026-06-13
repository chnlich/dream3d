// Studio page: prompt -> POST /api/generate -> render each returned pass in the SceneViewer with a
// Prev/Next stepper. Purely additive frontend wiring over the existing pipeline + viewer; no backend
// or SceneViewer changes. `three` is pulled in only transitively via SceneViewer.
//
// Failure policy (matches the repo's fail-fast principle): network / non-2xx / malformed-shape errors
// are surfaced loudly in the status line and console — never swallowed. The single tolerated-and-
// reported failure is a per-pass GLB load: SceneViewer.loadScene is fail-loud, so in MOCK mode its
// placeholder glbUrls 404 and the call throws. We catch THAT (and only that) and show a banner, while
// the stepper + object list stay usable because they are updated before loadScene is awaited.
import { SceneViewer } from "./viewer/SceneViewer";
import type { GenerateRequest, GenerateResponse, Pass } from "./api/contract";
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

// amend/review loop not wired yet — pinned to 0; re-expose an input when it ships.
const AMEND_ROUNDS = 0;

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
const presetSelect = requireEl("preset", HTMLSelectElement);
const generateBtn = requireEl("generate", HTMLButtonElement);
const statusEl = requireEl("status", HTMLElement);
const bannerEl = requireEl("banner", HTMLElement);
const stepperEl = requireEl("stepper", HTMLElement);
const prevBtn = requireEl("prev", HTMLButtonElement);
const nextBtn = requireEl("next", HTMLButtonElement);
const passLabel = requireEl("pass-label", HTMLElement);
const objectList = requireEl("object-list", HTMLElement);

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

// Fill the prompt input with a preset's prompt (it stays freely editable afterwards). Fail loud on an
// unknown id — that only happens if scene-presets.json and DEFAULT_PRESET_ID drift apart.
function applyPreset(id: string): void {
  const preset = scenePresets.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`scene-presets.json has no preset with id "${id}"`);
  }
  promptInput.value = preset.prompt;
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

  passLabel.textContent = `Pass ${current + 1} / ${passes.length}`;
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

async function onGenerate(): Promise<void> {
  const prompt = promptInput.value.trim();
  if (prompt.length === 0) {
    setStatus("enter a prompt");
    return;
  }
  generateBtn.disabled = true;
  setStatus("Generating…");
  clearBanner();
  try {
    const body: GenerateRequest = { prompt, amendRounds: AMEND_ROUNDS };
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Surface the server's error body verbatim — do not swallow.
      throw new Error(`/api/generate ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as GenerateResponse;
    if (!Array.isArray(data.passes) || data.passes.length === 0) {
      const got = JSON.stringify(data).slice(0, 300);
      throw new Error(`malformed /api/generate response: expected non-empty passes[], got ${got}`);
    }
    passes = data.passes;
    current = 0;
    stepperEl.hidden = false;
    setStatus(`Done — ${passes.length} pass${passes.length === 1 ? "" : "es"} for “${prompt}”.`);
    await renderPass(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`Error: ${message}`);
    console.error("[studio] generate failed:", err);
  } finally {
    generateBtn.disabled = false;
  }
}

generateBtn.addEventListener("click", () => void onGenerate());
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void onGenerate();
});
prevBtn.addEventListener("click", () => void renderPass(current - 1));
nextBtn.addEventListener("click", () => void renderPass(current + 1));

// Populate the preset dropdown, default-select the demo, and pre-fill its prompt so one click of
// Generate runs the demo. Changing the selection refills the prompt (which stays freely editable).
for (const preset of scenePresets) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.label;
  presetSelect.append(option);
}
presetSelect.value = DEFAULT_PRESET_ID;
applyPreset(presetSelect.value);
presetSelect.addEventListener("change", () => applyPreset(presetSelect.value));
