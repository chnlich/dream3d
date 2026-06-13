// Hand-written type declarations for cache.mjs (the runtime is plain ESM so the
// CLI needs no build step; these types let the TypeScript pipeline consume it).

/** One generated candidate, as persisted in a per-candidate sidecar and the index. */
export interface Candidate {
  taskId: string;
  prompt: string;
  mode: string;
  key: string;
  status: string;
  savedAt: number;
  /** Absolute path to the downloaded .glb on disk. Optional: a candidate may predate its download. */
  glb?: string;
  bytes?: number;
  thumb?: string;
  seed?: number | null;
  consumedCredits?: number | null;
}

/** One cache entry: the pool of candidates generated for a given prompt+mode key. */
export interface CacheEntry {
  prompt: string;
  mode: string;
  key: string;
  winner: string | null;
  candidates: Candidate[];
}

/** The on-disk index.json: maps cache key -> entry. */
export type CacheIndex = Record<string, CacheEntry>;

/** Payload for the human-readable <key>/meta.json directory marker. */
export interface DirMeta {
  prompt: string;
  normalizedPrompt: string;
  mode: string;
}

export const DEFAULT_CACHE_DIR: string;
export const CHECKPOINT_PROMPT: string;
export const CHECKPOINT_PARAM_SIG: string;
export const CHECKPOINT_KEY: string;

export function normalizePrompt(prompt: string): string;
/** sha256(normalizedPrompt + "::" + mode + "::" + paramSig), first 16 hex chars. */
export function deriveKey(prompt: string, mode: string, paramSig: string): string;
export function assertKeySchemeIsStable(): void;

export function serializeCache(value: unknown): string;

export function readIndex(cacheDir: string): Promise<CacheIndex>;
export function writeIndex(cacheDir: string, index: CacheIndex): Promise<void>;

export function validCandidatesOnDisk(candidates: Candidate[]): Candidate[];
export function selectCandidate(entry: CacheEntry): Candidate;

export function ensureDirMeta(cacheDir: string, key: string, meta: DirMeta): Promise<void>;
export function rebuildEntry(cacheDir: string, key: string): Promise<CacheIndex>;
