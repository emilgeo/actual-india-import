import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { loadEnvironmentFile, setting } from './env-file.js';

const KEYS = ['IIT_FROM_FILE', 'IIT_ALREADY_SET'] as const;

function writeEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iit-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const key of KEYS) {
    delete env[key];
  }
});

describe('loadEnvironmentFile', () => {
  it('loads values from the file', () => {
    const path = writeEnv('IIT_FROM_FILE=value-from-file\n');

    expect(loadEnvironmentFile(path)).toEqual({ loaded: true, path });
    expect(env.IIT_FROM_FILE).toBe('value-from-file');
  });

  it('does not overwrite a variable already in the environment', () => {
    // This is the whole reason for using Node's loader rather than assigning
    // into process.env ourselves: a one-off `ACTUAL_SYNC_ID=other ...` in front
    // of the command has to win over the file, or overriding a single setting
    // would mean editing .env every time.
    env.IIT_ALREADY_SET = 'from-environment';
    const path = writeEnv('IIT_ALREADY_SET=from-file\n');

    loadEnvironmentFile(path);

    expect(env.IIT_ALREADY_SET).toBe('from-environment');
  });

  it('treats a missing file as absent rather than an error', () => {
    // Converting a statement to CSV needs no configuration at all, so most
    // runs have no .env. Throwing here would break the common case.
    const path = join(tmpdir(), 'iit-definitely-not-here', '.env');

    expect(loadEnvironmentFile(path)).toEqual({
      loaded: false,
      path,
      reason: 'missing',
    });
  });

  it('reports a file it cannot read, naming the path', () => {
    // A directory where a file was expected. Staying silent would leave the
    // user believing their settings had been applied.
    const dir = mkdtempSync(join(tmpdir(), 'iit-env-dir-'));

    expect(() => loadEnvironmentFile(dir)).toThrow(dir);
  });

  it('trims surrounding whitespace', () => {
    // Node's own .env parser already trims, so this covers the other source:
    // a real environment variable, where `export ACTUAL_SYNC_ID=' abc '` keeps
    // its spaces and would be sent to the server verbatim.
    env.IIT_ALREADY_SET = '  abc  ';

    expect(setting('IIT_ALREADY_SET')).toBe('abc');
  });

  it('treats a key present but blank as absent', () => {
    // The case a copied .env.example actually produces. `ACTUAL_DATA_DIR=`
    // leaves an empty string, which is not nullish — so a `??` default would
    // not fire and the Actual API would receive '' as its data directory.
    const path = writeEnv('IIT_FROM_FILE=\n');

    loadEnvironmentFile(path);

    expect(env.IIT_FROM_FILE).toBe('');
    expect(setting('IIT_FROM_FILE')).toBeUndefined();
    expect(setting('IIT_FROM_FILE') ?? 'fallback').toBe('fallback');
  });

  it('ignores comments and blank lines', () => {
    // .env.example is mostly comments, and users copy it wholesale.
    const path = writeEnv('# a comment\n\nIIT_FROM_FILE=kept\n');

    loadEnvironmentFile(path);

    expect(env.IIT_FROM_FILE).toBe('kept');
  });
});
