import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export async function runClaude(prompt: string, opts: { imagePaths?: string[] } = {}): Promise<string> {
  const imagePaths = opts.imagePaths ?? [];
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

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(CLAUDE_BIN, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf8",
    }));
  } catch (cause) {
    const err = cause as { code?: number | string; signal?: NodeJS.Signals | null; killed?: boolean; stderr?: string };
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

  const result = (envelope as Record<string, unknown>).result;
  if (typeof result !== "string" || result.trim().length === 0) {
    throw new Error("runClaude: envelope.result is missing or empty");
  }
  return result;
}
