import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobStatus } from "../api/contract";

// Persistent job status store. Every job's full JobStatus is written to
// ~/.cache/dream3d/uuid/<jobId>/status.json so the dev server can return completed
// or errored jobs even after a Vite restart. Writes are fire-and-forget: a failure is
// logged but never thrown into the request path.
const uuidDir = join(homedir(), ".cache", "dream3d", "uuid");

function statusPath(jobId: string): string {
  return join(uuidDir, jobId, "status.json");
}

export function persistJob(jobId: string, job: JobStatus): void {
  try {
    const path = statusPath(jobId);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(job, null, 2));
  } catch (err) {
    console.warn("[dream3d-job] failed to persist job status:", err);
  }
}

export function loadHistoricalJobs(): Map<string, JobStatus> {
  const jobs = new Map<string, JobStatus>();
  try {
    if (!existsSync(uuidDir)) {
      return jobs;
    }
    for (const entry of readdirSync(uuidDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const jobId = entry.name;
      const path = statusPath(jobId);
      if (!existsSync(path)) {
        continue;
      }
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as JobStatus;
        if (parsed.status === "running") {
          parsed.status = "error";
          parsed.error = "server restarted while job was running";
          persistJob(jobId, parsed);
        }
        jobs.set(jobId, parsed);
      } catch (err) {
        console.warn("[dream3d-job] failed to load historical job", jobId, err);
      }
    }
  } catch (err) {
    console.warn("[dream3d-job] failed to scan historical jobs:", err);
  }
  return jobs;
}
