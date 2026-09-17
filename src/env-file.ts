import { env, loadEnvFile } from 'node:process';

/**
 * Load a `.env` file into the environment.
 *
 * Uses Node's built-in loader rather than a dependency, which also fixes the
 * precedence at the behaviour we want: variables already present in the
 * environment are *not* overwritten. So a `.env` supplies the defaults while a
 * one-off `ACTUAL_SYNC_ID=other actual-india-import ...` still wins, and CI can
 * inject secrets without a file existing at all.
 *
 * Requires Node >= 22 (see `engines` in package.json).
 */

export type EnvFileResult =
  | { loaded: true; path: string }
  | { loaded: false; path: string; reason: 'missing' };

/**
 * A missing file is not an error: the CSV path needs no configuration, so most
 * runs legitimately have no `.env` at all. Anything else — unreadable, a
 * directory, malformed contents — is reported, because it means the user
 * believes they have configured something that is in fact being ignored. That
 * would otherwise surface much later as a confusing "ACTUAL_SERVER_URL is not
 * set".
 */
export function loadEnvironmentFile(path: string): EnvFileResult {
  try {
    loadEnvFile(path);
    return { loaded: true, path };
  } catch (error) {
    if (isMissingFile(error)) {
      return { loaded: false, path, reason: 'missing' };
    }

    throw new Error(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read a setting, treating blank as absent.
 *
 * `.env.example` ships its keys with empty values for the user to fill in, so
 * a copied-but-unedited file leaves `ACTUAL_DATA_DIR=` set to the empty
 * string. The empty string is not nullish, so a `??` default would not fire
 * and the Actual API would be handed `''` as its data directory. Trimming also
 * catches the trailing space left by `ACTUAL_SYNC_ID= ` .
 */
export function setting(name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
