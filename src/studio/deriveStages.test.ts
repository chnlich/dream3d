// Unit tests for the pure stage reducer. deriveStages touches no DOM and no clock, so it
// runs under node:test directly. Synthetic logs use explicit timestamps so stage states
// AND measured durations are asserted exactly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LogLine } from "../api/contract";
import { deriveStages, type Stage } from "./deriveStages";

function L(ts: number, text: string): LogLine {
  return { ts, text };
}

function byId(stages: Stage[], id: string): Stage {
  const s = stages.find((x) => x.id === id);
  assert.ok(s, `expected stage "${id}" to exist`);
  return s;
}

function assertIds(stages: Stage[], ids: string[]): void {
  assert.equal(
    stages.map((s) => s.id).join(","),
    ids.join(","),
  );
}

describe("deriveStages — amendRounds=0 (draft only)", () => {
  const log: LogLine[] = [
    L(1000, "Planning scene…"),
    L(2000, "Plan ready — 2 object(s)"),
    L(3000, "Starting asset 1/2: chair"),
    L(3100, "Starting asset 2/2: table"),
    L(5000, "Generating asset 1/2: chair"),
    L(6000, "Generating asset 2/2: table"),
    L(6100, "Arranging layout…"),
    L(6200, "Done — 1 pass(es)"),
  ];
  const stages = deriveStages(log, 0, "done");

  it("emits the planned skeleton (no amend rows)", () => {
    assertIds(stages, ["plan", "asset-0", "asset-1", "layout", "done"]);
  });

  it("measures plan from Planning to Plan ready", () => {
    const plan = byId(stages, "plan");
    assert.equal(plan.state, "done");
    assert.equal(plan.startedAtMs, 1000);
    assert.equal(plan.endedAtMs, 2000);
  });

  it("appends the label to asset rows and pairs completions by label", () => {
    const chair = byId(stages, "asset-0");
    assert.equal(chair.name, "Asset 1: chair");
    assert.equal(chair.state, "done");
    assert.equal(chair.startedAtMs, 3000);
    assert.equal(chair.endedAtMs, 5000);

    const table = byId(stages, "asset-1");
    assert.equal(table.name, "Asset 2: table");
    assert.equal(table.state, "done");
    assert.equal(table.startedAtMs, 3100);
    assert.equal(table.endedAtMs, 6000);
  });

  it("runs layout into Done when no amend rounds follow", () => {
    const layout = byId(stages, "layout");
    assert.equal(layout.state, "done");
    assert.equal(layout.startedAtMs, 6100);
    assert.equal(layout.endedAtMs, 6200);

    const done = byId(stages, "done");
    assert.equal(done.state, "done");
    assert.equal(done.endedAtMs, 6200);
    assert.equal(done.startedAtMs, null);
  });
});

describe("deriveStages — amendRounds=1 with issues (render+critique -> fix, 2 passes)", () => {
  const log: LogLine[] = [
    L(1000, "Planning scene…"),
    L(2000, "Plan ready — 1 object(s)"),
    L(3000, "Starting asset 1/1: mug"),
    L(5000, "Generating asset 1/1: mug"),
    L(5100, "Arranging layout…"),
    L(6000, "Amend 1: rendering"),
    L(9000, "Amend 1: 2 issue(s) found"),
    L(9500, "Amend 1: applied fixes"),
    L(9600, "Done — 2 pass(es)"),
  ];
  const stages = deriveStages(log, 1, "done");

  it("keeps the full skeleton including render-1 and fix-1", () => {
    assertIds(stages, ["plan", "asset-0", "layout", "render-1", "fix-1", "done"]);
  });

  it("ends layout at the render boundary", () => {
    const layout = byId(stages, "layout");
    assert.equal(layout.state, "done");
    assert.equal(layout.startedAtMs, 5100);
    assert.equal(layout.endedAtMs, 6000);
  });

  it("measures render+critique span from rendering to issues-found", () => {
    const render = byId(stages, "render-1");
    assert.equal(render.name, "Render+critique 1");
    assert.equal(render.state, "done");
    assert.equal(render.startedAtMs, 6000);
    assert.equal(render.endedAtMs, 9000);
  });

  it("measures fix span from issues-found to applied-fixes", () => {
    const fix = byId(stages, "fix-1");
    assert.equal(fix.state, "done");
    assert.equal(fix.startedAtMs, 9000);
    assert.equal(fix.endedAtMs, 9500);
  });
});

describe("deriveStages — amendRounds=1 clean (fix dropped, no later rounds)", () => {
  const log: LogLine[] = [
    L(1000, "Planning scene…"),
    L(2000, "Plan ready — 1 object(s)"),
    L(3000, "Starting asset 1/1: mug"),
    L(5000, "Generating asset 1/1: mug"),
    L(5100, "Arranging layout…"),
    L(6000, "Amend 1: rendering"),
    L(9000, "Amend 1: 0 issue(s) found"),
    L(9100, "Amend 1: clean"),
    L(9200, "Done — 1 pass(es)"),
  ];
  const stages = deriveStages(log, 1, "done");

  it("drops fix-1 (the loop broke) but keeps render-1 done and the terminal done", () => {
    assertIds(stages, ["plan", "asset-0", "layout", "render-1", "done"]);
  });

  it("marks render-1 done at the critique line (clean is idempotent)", () => {
    const render = byId(stages, "render-1");
    assert.equal(render.state, "done");
    assert.equal(render.startedAtMs, 6000);
    assert.equal(render.endedAtMs, 9000);
  });
});

describe("deriveStages — amendRounds=2 clean at round 1 drops all later rounds", () => {
  const log: LogLine[] = [
    L(1000, "Planning scene…"),
    L(2000, "Plan ready — 1 object(s)"),
    L(3000, "Starting asset 1/1: mug"),
    L(5000, "Generating asset 1/1: mug"),
    L(5100, "Arranging layout…"),
    L(6000, "Amend 1: rendering"),
    L(9000, "Amend 1: 0 issue(s) found"),
    L(9100, "Amend 1: clean"),
    L(9200, "Done — 1 pass(es)"),
  ];
  const stages = deriveStages(log, 2, "done");

  it("drops fix-1, render-2 and fix-2 (scaffolded but never run)", () => {
    assertIds(stages, ["plan", "asset-0", "layout", "render-1", "done"]);
  });
});

describe("deriveStages — cache hit collapses to a single row", () => {
  const log: LogLine[] = [L(1234, "Response served from cache")];
  const stages = deriveStages(log, 2, "done");

  it("emits one cached stage and no pipeline skeleton", () => {
    assert.equal(stages.length, 1);
    const cached = stages[0];
    assert.equal(cached.id, "cached");
    assert.equal(cached.name, "Served from cache");
    assert.equal(cached.state, "done");
    assert.equal(cached.startedAtMs, 1234);
    assert.equal(cached.endedAtMs, 1234);
  });
});

describe("deriveStages — error mid-asset fails the in-flight stage, rest pending", () => {
  const log: LogLine[] = [
    L(1000, "Planning scene…"),
    L(2000, "Plan ready — 1 object(s)"),
    L(3000, "Starting asset 1/1: mug"),
  ];
  const stages = deriveStages(log, 0, "error");

  it("fails the running asset at the last log timestamp", () => {
    const asset = byId(stages, "asset-0");
    assert.equal(asset.state, "failed");
    assert.equal(asset.startedAtMs, 3000);
    assert.equal(asset.endedAtMs, 3000);
  });

  it("leaves plan done and the not-yet-started stages pending", () => {
    const plan = byId(stages, "plan");
    assert.equal(plan.state, "done");
    const layout = byId(stages, "layout");
    assert.equal(layout.state, "pending");
    assert.equal(layout.startedAtMs, null);
    const done = byId(stages, "done");
    assert.equal(done.state, "pending");
  });
});

describe("deriveStages — concurrent asset completion order", () => {
  // Assets start out of order and complete in a different order; the label on each
  // "Generating asset c/N: label" line pairs the completion to the right running row.
  const log: LogLine[] = [
    L(1000, "Planning scene…"),
    L(2000, "Plan ready — 2 object(s)"),
    L(3000, "Starting asset 2/2: table"),
    L(3100, "Starting asset 1/2: chair"),
    L(5000, "Generating asset 1/2: chair"),
    L(6000, "Generating asset 2/2: table"),
    L(6100, "Arranging layout…"),
    L(6200, "Done — 1 pass(es)"),
  ];
  const stages = deriveStages(log, 0, "done");

  it("pairs each completion to its label regardless of start order", () => {
    const chair = byId(stages, "asset-0");
    assert.equal(chair.name, "Asset 1: chair");
    assert.equal(chair.startedAtMs, 3100);
    assert.equal(chair.endedAtMs, 5000);

    const table = byId(stages, "asset-1");
    assert.equal(table.name, "Asset 2: table");
    assert.equal(table.startedAtMs, 3000);
    assert.equal(table.endedAtMs, 6000);
  });
});

describe("deriveStages — partial log before Plan ready", () => {
  it("scaffolds a single asset until the count is known", () => {
    const log: LogLine[] = [L(1000, "Planning scene…")];
    const stages = deriveStages(log, 0, "running");
    assertIds(stages, ["plan", "asset-0", "layout", "done"]);
    assert.equal(byId(stages, "plan").state, "running");
    assert.equal(byId(stages, "plan").startedAtMs, 1000);
    assert.equal(byId(stages, "asset-0").state, "pending");
  });

  it("derives the count from a Starting asset line when Plan ready is absent", () => {
    const log: LogLine[] = [
      L(1000, "Planning scene…"),
      L(2100, "Starting asset 1/3: a"),
    ];
    const stages = deriveStages(log, 0, "running");
    assertIds(stages, ["plan", "asset-0", "asset-1", "asset-2", "layout", "done"]);
  });
});
