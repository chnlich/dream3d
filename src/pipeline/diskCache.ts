// diskCache.ts — generic on-disk JSON cache shared by responseCache and planCache.
//
// Both caches store one value per request inside a versioned envelope under
// ~/.cache/dream3d/<dirName>/<key>.json, derive the key as a sha256 prefix with the
// CACHE_VERSION folded in, read with a strict "throw on corruption / null on expected
// staleness" split, and write atomically (a .tmp sibling renamed into place). That
// boilerplate lives here once; each cache supplies only its specifics (dir, version,
// the envelope field its value lives under, and an optional value validator).
//
// Fail loud: a corrupt cache file is a bug, not a miss — read() THROWS. Only EXPECTED
// staleness (absent file, version bump, or a validator-reported eviction) yields a
// clean null so the caller regenerates.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface DiskCache<T> {
  // sha256 of [version, ...parts].join("::"), first 16 hex chars. Callers pass the
  // request-identifying parts (e.g. [mode, normalizedPrompt]); version is folded in
  // here so a bump makes every old entry unreachable.
  deriveKey(parts: string[]): string;
  // Cached value for `key`, or null on an EXPECTED miss (no file, stale version, or a
  // validator-reported eviction). THROWS on a corrupt file.
  read(key: string): T | null;
  // Persists `value` under `key` inside an envelope carrying the version plus the
  // caller's human-readable provenance fields. Atomic (.tmp sibling then rename).
  write(key: string, provenance: Record<string, unknown>, value: T): void;
}

export interface DiskCacheOptions<T> {
  dirName: string; // subdirectory under ~/.cache/dream3d (e.g. "responses", "plans")
  label: string; // singular noun for error messages (e.g. "response", "plan")
  // Envelope field the value is stored under (e.g. "response", "plan"). Kept distinct
  // from `label` and explicit so the on-disk shape is preserved exactly per cache.
  valueKey: string;
  // Folded into the key (old entries become unreachable) AND checked on read (a stale
  // version regenerates instead of deserializing a wrong shape).
  version: number;
  // Optional value check, run AFTER the generic envelope checks and BEFORE the
  // version-match check — so a malformed value THROWS even when the version is also
  // stale, matching the original modules' precedence. Contract: THROW to signal
  // corruption; return false for EXPECTED staleness (read() -> null); return true if
  // the value is good. This is where responseCache plugs in its glbUrl-on-disk check.
  validate?: (value: unknown, path: string) => boolean;
}

export function createDiskCache<T>(options: DiskCacheOptions<T>): DiskCache<T> {
  const { dirName, label, valueKey, version, validate } = options;
  const dir = join(homedir(), ".cache", "dream3d", dirName);

  function pathFor(key: string): string {
    return join(dir, `${key}.json`);
  }

  function deriveKey(parts: string[]): string {
    return createHash("sha256").update([String(version), ...parts].join("::")).digest("hex").slice(0, 16);
  }

  function read(key: string): T | null {
    const path = pathFor(key);
    if (!existsSync(path)) {
      return null; // clean miss — nothing cached for this request yet
    }

    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Corrupt ${label} cache ${path}: JSON parse failed (${(error as Error).message})`);
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Corrupt ${label} cache ${path}: envelope is not a JSON object`);
    }
    const envelope = parsed as { version?: unknown; [field: string]: unknown };

    if (typeof envelope.version !== "number") {
      throw new Error(`Corrupt ${label} cache ${path}: missing numeric "version"`);
    }

    // Validate the value BEFORE the version check: a malformed value is corruption and
    // must throw even if the version is also stale (preserves the original precedence).
    const value = envelope[valueKey];
    if (validate && !validate(value, path)) {
      return null; // validator reported expected staleness — regenerate
    }

    if (envelope.version !== version) {
      return null; // expected staleness — regenerate under the current version
    }

    return value as T;
  }

  function write(key: string, provenance: Record<string, unknown>, value: T): void {
    mkdirSync(dir, { recursive: true });
    const envelope = {
      version,
      key,
      ...provenance,
      savedAt: Math.floor(Date.now() / 1000),
      [valueKey]: value,
    };
    const finalPath = pathFor(key);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    renameSync(tmpPath, finalPath);
  }

  return { deriveKey, read, write };
}
