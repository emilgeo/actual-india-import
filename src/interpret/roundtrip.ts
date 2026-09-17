/**
 * Read this tool's own CSV output back in.
 *
 * Convert, review the CSV, correct a payee or two, then push is a sensible
 * workflow — and the safest way to use `--push`, since you see exactly what
 * will land before it does. Without this the tool cannot read its own output:
 * generic header detection requires a *description* column, and neither
 * `Payee` nor `Notes` matches any bank's narration vocabulary.
 *
 * Adding `payee`/`notes` to that vocabulary would have been the smaller
 * change, and the wrong one. It would feed the Notes column back through
 * narration parsing and overwrite the Payee column — discarding exactly the
 * manual corrections that make the round trip worth doing.
 *
 * So converted output is recognised by its exact header and passed through:
 * payees are kept verbatim, never re-derived.
 */

import type { Table } from '../extract/types.js';

import type { ColumnMap } from './header.js';
import type { Interpreted, StatementTransaction } from './rows.js';
import { parseAmount, parseStatementDate } from './values.js';

/** The header `toCsv` writes. Must stay in step with `COLUMNS` there. */
const CONVERTED_HEADER = ['date', 'payee', 'notes', 'amount', 'reference'];

/**
 * Column map describing converted output, for reporting only.
 *
 * `description: 2` points at Notes because that is where the narration lives,
 * even though it is not re-parsed.
 */
const CONVERTED_MAP: ColumnMap = {
  date: 0,
  description: 2,
  amount: 3,
  ref: 4,
};

function normalize(cell: string): string {
  return cell.trim().toLowerCase();
}

/**
 * Does this table look like output we produced?
 *
 * Deliberately strict — an exact header match, in order. A bank CSV that
 * happens to have a `Payee` column must still go down the generic path, where
 * its narration gets parsed. Requiring all five columns in the same order
 * makes a false positive essentially impossible.
 */
export function isConvertedOutput(table: Table): boolean {
  const header = table.rows[0];
  if (!header) {
    return false;
  }

  const cells = header.map(normalize);
  return (
    cells.length >= CONVERTED_HEADER.length &&
    CONVERTED_HEADER.every((name, index) => cells[index] === name)
  );
}

/**
 * Interpret converted output, taking every field at face value.
 *
 * The amount is already signed, the date already ISO, and the payee already
 * resolved — possibly by hand. Nothing here re-derives any of it.
 */
export function interpretConvertedOutput(table: Table): Interpreted {
  const transactions: StatementTransaction[] = [];
  const skipped: Interpreted['skipped'] = [];

  for (let index = 1; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (!row || row.every(value => !value.trim())) {
      continue;
    }

    const date = parseStatementDate(row[0] ?? '', 'ymd');
    if (!date) {
      skipped.push({ index, reason: 'no parseable date', row });
      continue;
    }

    const amount = parseAmount(row[3] ?? '');
    if (amount === null) {
      skipped.push({ index, reason: 'no parseable amount', row });
      continue;
    }

    const notes = (row[2] ?? '').trim();
    const payee = (row[1] ?? '').trim();
    const ref = (row[4] ?? '').trim();

    transactions.push({
      date,
      amount,
      // A row whose Payee was blanked out still needs a payee, and the
      // narration is the best available answer — the same fallback the
      // narration parser uses.
      payee: payee || notes || 'Unknown',
      raw: notes,
      // Already-converted rows carry no narration to classify, and the kind is
      // only used for reporting.
      kind: 'other',
      ...(ref ? { ref } : {}),
    });
  }

  return {
    transactions,
    skipped,
    header: { index: 0, map: CONVERTED_MAP },
    // References were already checked for uniqueness when the CSV was written.
    droppedRefs: 0,
  };
}
