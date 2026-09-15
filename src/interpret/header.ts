import { roleForHeader } from './synonyms.js';
import type { ColumnRole } from './synonyms.js';

/** Column index for each role we could identify. */
export type ColumnMap = Partial<Record<ColumnRole, number>>;

export type HeaderMatch = {
  /** Row index of the header within the table. */
  index: number;
  map: ColumnMap;
  /** Number of roles identified — used to choose between candidate rows. */
  score: number;
};

/** How far into the file to look before giving up. */
const MAX_HEADER_SCAN = 40;

/**
 * A table is only usable if we can find a date, something to use as a payee,
 * and at least one amount column.
 */
export function isUsable(map: ColumnMap): boolean {
  const hasDate = map.date !== undefined || map.valueDate !== undefined;
  const hasDescription = map.description !== undefined;
  const hasAmount =
    map.debit !== undefined ||
    map.credit !== undefined ||
    map.amount !== undefined;

  return hasDate && hasDescription && hasAmount;
}

function mapRow(row: string[]): ColumnMap {
  const map: ColumnMap = {};

  for (const [index, cell] of row.entries()) {
    const role = roleForHeader(cell);
    // First occurrence wins: ICICI repeats `Value Date` and `Transaction
    // Date`, and the leftmost match is the one the bank leads with.
    if (role && map[role] === undefined) {
      map[role] = index;
    }
  }

  return map;
}

/**
 * Locate the transaction table's header row.
 *
 * Indian statements put a variable number of preamble rows above the table
 * (branch address, account holder, statement period), so the header cannot be
 * assumed to be row 0. Instead every row in range is scored by how many known
 * columns it contains, and the best usable row wins.
 */
export function findHeader(rows: string[][]): HeaderMatch | null {
  let best: HeaderMatch | null = null;

  const limit = Math.min(rows.length, MAX_HEADER_SCAN);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }

    const map = mapRow(row);
    if (!isUsable(map)) {
      continue;
    }

    const score = Object.keys(map).length;
    // Strictly greater, so the earliest of equally-good rows wins. Some banks
    // repeat the header on every page; the first one is the real table start.
    if (!best || score > best.score) {
      best = { index, map, score };
    }
  }

  return best;
}
