import { readFile } from 'node:fs/promises';

import { parse } from 'csv-parse/sync';

import type { Table } from './types.js';

const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const;

/**
 * Guess the delimiter by counting candidates across the first few lines.
 *
 * Counting per-line and taking the most *consistent* candidate rather than the
 * most frequent one matters here: Indian statements carry preamble lines
 * (branch address, account holder name) whose punctuation would otherwise
 * outvote the real delimiter.
 */
export function sniffDelimiter(contents: string): string {
  const lines = contents
    .split(/\r?\n/)
    .filter(line => line.trim())
    .slice(0, 30);

  let best = ',';
  let bestScore = -1;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = lines
      .map(line => line.split(delimiter).length - 1)
      .filter(count => count > 0);

    if (counts.length < 2) {
      continue;
    }

    // Reward the delimiter that appears the same number of times on the most
    // lines — that is the signature of a real column structure.
    const tally = new Map<number, number>();
    for (const count of counts) {
      tally.set(count, (tally.get(count) ?? 0) + 1);
    }

    for (const [count, lineCount] of tally) {
      const score = count * lineCount;
      if (score > bestScore) {
        bestScore = score;
        best = delimiter;
      }
    }
  }

  return best;
}

export async function extractCsv(
  path: string,
  options: { delimiter?: string } = {},
): Promise<Table> {
  const contents = await readFile(path, 'utf8');
  const delimiter = options.delimiter ?? sniffDelimiter(contents);

  const rows = parse(contents, {
    delimiter,
    bom: true,
    // Statement preambles and footers have different column counts than the
    // transaction table, so ragged rows are expected, not an error.
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }) as string[][];

  return {
    rows: rows.map(row => row.map(cell => (cell ?? '').toString().trim())),
    source: { path, format: 'csv' },
  };
}
