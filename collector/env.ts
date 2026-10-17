/**
 * Environment handling.
 *
 * Load order: real environment variables always win; a repo-root `.env` fills
 * the gaps when it exists (locally). In GitHub Actions the secrets are already
 * in the environment and there is no `.env`, so `loadEnv()` is a no-op.
 *
 * Deliberately dependency-free — a `.env` parser is ~20 lines and adding a
 * package for it would be more surface area than value.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads KEY=VALUE lines from `path` into process.env without overwriting. */
export function loadEnv(path: string = resolve(repoRoot, '.env')): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // No .env (CI) — the environment is expected to be pre-populated.
  }

  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key === undefined) continue;
    if (process.env[key] !== undefined) continue; // real env wins
    let value = (match[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** Trimmed env var, or undefined when unset/blank. */
export function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Env var as a number, falling back when unset or unparseable. */
export function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Env var that must be present; throws a useful message when it is not. */
export function requireEnv(name: string): string {
  const value = env(name);
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Set it in the environment, or place it in the repo-root .env file.',
    );
  }
  return value;
}

/** True when the calling module is the CLI entrypoint (ESM has no __main__). */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return metaUrl === pathToFileURL(entry).href;
}
