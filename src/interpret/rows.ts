import type { Table } from '../extract/types.js';
import type { MerchantRule } from '../narration/merchants.js';
import { parseNarration } from '../narration/parse.js';
import type { NarrationKind } from '../narration/types.js';

import { findHeader } from './header.js';
import type { ColumnMap } from './header.js';
import { parseAmount, parseStatementDate } from './values.js';
import type { DateOrder } from './values.js';

export type StatementTransaction = {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed rupees: negative for money out. */
  amount: number;
  /** Cleaned merchant, for Actual's `payee_name`. */
  payee: string;
  /** Original narration, for Actual's `imported_payee`. */
  raw: string;
  kind: NarrationKind;
  /** Only set when safe to use as `imported_id` — see `dropRepeatedRefs`. */
  ref?: string;
  /** Running balance, when the statement has one. Used only for validation. */
  balance?: number;
};

export type SkippedRow = {
  /** Row index in the original table. */
  index: number;
  reason: string;
  row: string[];
};

export type InterpretResult = {
  transactions: StatementTransaction[];
  skipped: SkippedRow[];
  header: { index: number; map: ColumnMap };
};

export type InterpretOptions = {
  dateOrder?: DateOrder;
  merchantRules?: MerchantRule[];
  /** Force a column map instead of detecting one (per-bank override). */
  columnMap?: ColumnMap;
  /** Force the header row index. */
  headerIndex?: number;
};

function cell(row: string[], index: number | undefined): string {
  if (index === undefined) {
    return '';
  }
  return row[index] ?? '';
}

/**
 * A zero in a Withdrawal/Deposit pair means "not this side", not a zero-rupee
 * transaction, so it is treated as absent.
 */
function presentAmount(value: number | null): number | null {
  if (value === null || value === 0) {
    return null;
  }
  return value;
}

function resolveAmount(row: string[], map: ColumnMap): number | null {
  const debit = presentAmount(parseAmount(cell(row, map.debit)));
  const credit = presentAmount(parseAmount(cell(row, map.credit)));

  if (map.debit !== undefined || map.credit !== undefined) {
    if (credit !== null) {
      return Math.abs(credit);
    }
    if (debit !== null) {
      return -Math.abs(debit);
    }
    // Fall through: some banks carry both a Dr/Cr pair and a single amount
    // column, and only populate one of them.
  }

  const amount = presentAmount(parseAmount(cell(row, map.amount)));
  if (amount === null) {
    return null;
  }

  // An explicit indicator column overrides whatever sign the amount carried.
  const indicator = cell(row, map.drcr).trim().toLowerCase();
  if (indicator) {
    if (/^d/.test(indicator)) {
      return -Math.abs(amount);
    }
    if (/^c/.test(indicator)) {
      return Math.abs(amount);
    }
  }

  return amount;
}

/** Reference-column values that carry no information. */
function usableColumnRef(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 6) {
    return null;
  }
  // `0`, `000000`, `-`, `NA`.
  if (/^[0\s\-.]*$/.test(trimmed) || /^na$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Strip references that occur more than once in the file.
 *
 * A genuine bank reference is unique per transaction, so a repeat means we
 * picked up something else — an account number, a padded placeholder, a
 * recurring mandate id. Leaving it in place would make Actual treat distinct
 * transactions as the same one and silently drop them, which is strictly worse
 * than having no reference at all (where Actual's date+amount fuzzy matching
 * takes over).
 */
function dropRepeatedRefs(transactions: StatementTransaction[]): number {
  const counts = new Map<string, number>();
  for (const transaction of transactions) {
    if (transaction.ref) {
      counts.set(transaction.ref, (counts.get(transaction.ref) ?? 0) + 1);
    }
  }

  let dropped = 0;
  for (const transaction of transactions) {
    if (transaction.ref && (counts.get(transaction.ref) ?? 0) > 1) {
      delete transaction.ref;
      dropped += 1;
    }
  }

  return dropped;
}

export type Interpreted = InterpretResult & {
  /** How many references were discarded as non-unique. */
  droppedRefs: number;
};

/**
 * Turn an extracted table into transactions.
 *
 * Rows that lack a parseable date or amount are skipped rather than guessed
 * at — that is what removes statement preambles, page headers repeated
 * mid-file, and footer totals without needing to know how many there are.
 */
export function interpretTable(
  table: Table,
  options: InterpretOptions = {},
): Interpreted | null {
  let headerIndex = options.headerIndex;
  let map = options.columnMap;

  if (headerIndex === undefined || !map) {
    const detected = findHeader(table.rows);
    if (!detected) {
      return null;
    }
    headerIndex = headerIndex ?? detected.index;
    map = map ?? detected.map;
  }

  const transactions: StatementTransaction[] = [];
  const skipped: SkippedRow[] = [];

  for (let index = headerIndex + 1; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (!row || row.every(value => !value.trim())) {
      continue;
    }

    const dateCell = cell(row, map.date) || cell(row, map.valueDate);
    const date = parseStatementDate(dateCell, options.dateOrder);
    if (!date) {
      skipped.push({ index, reason: 'no parseable date', row });
      continue;
    }

    const amount = resolveAmount(row, map);
    if (amount === null) {
      skipped.push({ index, reason: 'no parseable amount', row });
      continue;
    }

    const narration = cell(row, map.description);
    const parsed = parseNarration(narration, {
      ...(options.merchantRules
        ? { merchantRules: options.merchantRules }
        : {}),
    });

    // The narration's UTR is the most trustworthy reference; the reference
    // column is a fallback and is subject to the uniqueness guard below.
    const ref = parsed.ref ?? usableColumnRef(cell(row, map.ref));
    const balance = parseAmount(cell(row, map.balance));

    transactions.push({
      date,
      amount,
      payee: parsed.merchant,
      raw: parsed.raw,
      kind: parsed.kind,
      ...(ref ? { ref } : {}),
      ...(balance !== null ? { balance } : {}),
    });
  }

  const droppedRefs = dropRepeatedRefs(transactions);

  return {
    transactions,
    skipped,
    header: { index: headerIndex, map },
    droppedRefs,
  };
}
