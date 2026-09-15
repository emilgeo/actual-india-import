import { readFile } from 'node:fs/promises';

import type { MerchantRule } from './narration/merchants.js';

type RawRule = { pattern?: unknown; name?: unknown };

/**
 * Load user merchant rules from JSON:
 *
 *   [
 *     { "pattern": "^mylocalkirana", "name": "Kirana Store" },
 *     { "pattern": "^acmecorp",      "name": "Acme Payroll" }
 *   ]
 *
 * Patterns are matched against a lowercased, separator-stripped form of the
 * VPA local-part or merchant name, so write them without spaces or
 * punctuation. Loaded rules take precedence over the built-in map.
 */
export async function loadMerchantRules(path: string): Promise<MerchantRule[]> {
  const contents = await readFile(path, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain an array of { pattern, name } rules`);
  }

  return parsed.map((entry: RawRule, index) => {
    const { pattern, name } = entry ?? {};

    if (typeof pattern !== 'string' || typeof name !== 'string' || !name) {
      throw new Error(
        `${path}: rule ${index + 1} needs a string "pattern" and a non-empty string "name"`,
      );
    }

    try {
      // Case-insensitive to match how the built-in rules are applied.
      return { pattern: new RegExp(pattern, 'i'), name };
    } catch (error) {
      throw new Error(
        `${path}: rule ${index + 1} has an invalid regular expression (${pattern}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}
