"""Headless driver for the already-authenticated local `claude` CLI.

Mirrors src/llm/claudeCli.ts. Spawns `claude -p <prompt> --model claude-opus-4-8
--output-format json --permission-mode bypassPermissions`, parses the JSON
envelope, and returns envelope['result']. Fails loud on any error.
"""

import json
import subprocess

CLAUDE_BIN = "claude"
MODEL = "claude-opus-4-8"
TIMEOUT_SECONDS = 120
MAX_BUFFER_BYTES = 32 * 1024 * 1024


def run_claude(
    prompt: str,
    *,
    image_paths: list[str] | None = None,
    caller: str = "claude",
) -> str:
    """Run the local claude CLI and return the assistant's final text.

    Args:
        prompt: The prompt to send to Claude.
        image_paths: Optional list of image file paths for vision inputs.
        caller: Logical caller name for logging/auditing.

    Returns:
        The contents of envelope['result'] from the CLI JSON output.

    Raises:
        RuntimeError or subprocess.SubprocessError on failure.
    """
    image_paths = image_paths or []
    enable_images = len(image_paths) > 0

    full_prompt = prompt
    if enable_images:
        full_prompt = (
            f"{prompt}\n\nRead these image file(s) as part of this task:\n"
            + "\n".join(image_paths)
        )
    allowed_tools = "Read" if enable_images else ""

    args = [
        "-p",
        full_prompt,
        "--model",
        MODEL,
        "--output-format",
        "json",
        "--allowedTools",
        allowed_tools,
        "--permission-mode",
        "bypassPermissions",
    ]

    # Caller is accepted for API parity but the Python port does not yet audit.
    _ = caller

    try:
        result = subprocess.run(
            [CLAUDE_BIN, *args],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"run_claude: `{CLAUDE_BIN}` timed out after {TIMEOUT_SECONDS}s"
        ) from exc
    except subprocess.SubprocessError:
        raise

    if result.returncode != 0:
        stderr = f"; stderr: {result.stderr.strip()}" if result.stderr else ""
        raise RuntimeError(
            f"run_claude: `{CLAUDE_BIN}` exited with code {result.returncode}{stderr}"
        )

    try:
        envelope = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"run_claude: stdout was not valid JSON: {result.stdout[:1000]}"
        ) from exc

    if not isinstance(envelope, dict):
        raise RuntimeError(
            f"run_claude: expected a JSON object from --output-format json, "
            f"got {type(envelope).__name__}"
        )

    output = envelope.get("result")
    if not isinstance(output, str) or output.strip() == "":
        raise RuntimeError("run_claude: envelope.result is missing or empty")

    return output
