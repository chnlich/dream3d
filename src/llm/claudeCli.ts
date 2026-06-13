import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { logClaudeCall, newId } from "../log/audit";

const execFileAsync = promisify(execFile);

// Headless driver for the already-authenticated local `claude` CLI (v2.x), used in
// place of an SDK — this box has no Anthropic API key, only the logged-in CLI.
// `--output-format json` wraps the run in an envelope whose `result` field is the
// assistant's final text; we return it RAW and let callers parse/validate it. Fails
// loud (throws) on a non-zero exit, a timeout, unparseable stdout, or an empty result.
const CLAUDE_BIN = "claude";
const MODEL = "claude-opus-4-8";
const TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

// Shape of the execFile rejection we read when the CLI fails (non-zero exit or timeout).
type ExecError = { code?: number | string; signal?: NodeJS.Signals | null; killed?: boolean; stderr?: string };

export async function runClaude(
  prompt: string,
  opts: { imagePaths?: string[]; caller?: string } = {},
): Promise<string> {
  const imagePaths = opts.imagePaths ?? [];
  const caller = opts.caller ?? "claude";
  const enableImages = imagePaths.length > 0;

  // With images we let Claude Code read them off disk (Read tool) and point it at the
  // absolute paths in the prompt; otherwise no tools are allowed at all.
  const fullPrompt = enableImages
    ? `${prompt}\n\nRead these image file(s) as part of this task:\n${imagePaths.join("\n")}`
    : prompt;
  const allowedTools = enableImages ? "Read" : "";

  const args = [
    "-p", fullPrompt,
    "--model", MODEL,
    "--output-format", "json",
    "--allowedTools", allowedTools,
    "--permission-mode", "bypassPermissions",
  ];

  // Audit every call: mint an id and start the wall clock before spawning so both the
  // success and failure paths log a complete record (best-effort; see ../log/audit).
  const callId = newId();
  const startedAt = Date.now();

  try {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(CLAUDE_BIN, args, {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "utf8",
      }));
    } catch (cause) {
      const err = cause as ExecError;
      const reason = err.killed
        ? `timed out after ${TIMEOUT_MS}ms (signal ${err.signal})`
        : `exited with code ${err.code}`;
      const stderr = err.stderr ? `; stderr: ${err.stderr.trim()}` : "";
      throw new Error(`runClaude: \`${CLAUDE_BIN}\` ${reason}${stderr}`, { cause });
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout);
    } catch (cause) {
      throw new Error(`runClaude: stdout was not valid JSON: ${stdout.slice(0, 1000)}`, { cause });
    }
    if (typeof envelope !== "object" || envelope === null) {
      throw new Error(`runClaude: expected a JSON object from --output-format json, got ${typeof envelope}`);
    }

    const env = envelope as Record<string, unknown>;
    const result = env.result;
    if (typeof result !== "string" || result.trim().length === 0) {
      throw new Error("runClaude: envelope.result is missing or empty");
    }

    // Capture the full envelope verbatim plus call metadata + the convenience fields the
    // audit summary reads (session_id / total_cost_usd / usage present when the CLI emits them).
    logClaudeCall({
      ...env,
      callId,
      caller,
      model: MODEL,
      prompt: fullPrompt,
      imagePaths,
      ok: true,
      durationMs: Date.now() - startedAt,
      result,
      session_id: env.session_id,
      total_cost_usd: env.total_cost_usd,
      duration_ms: env.duration_ms,
      duration_api_ms: env.duration_api_ms,
      num_turns: env.num_turns,
      usage: env.usage,
    });
    return result;
  } catch (err) {
    // Every failure path (exec error, unparseable stdout, non-object, empty result) is
    // audited before it propagates — then rethrow exactly as before (stay fail-loud).
    logClaudeCall({
      callId,
      caller,
      model: MODEL,
      prompt: fullPrompt,
      imagePaths,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
