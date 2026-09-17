/**
 * Read this tool's own CSV output back in, so a reviewed and hand-corrected CSV
 * can be pushed.
 *
 * Generic header detection requires a description column, and neither `Payee`
 * nor `Notes` matches any bank's narration vocabulary, so without this path the
 * tool cannot read its own output.
 *
 * Adding `payee`/`notes` to that vocabulary instead would feed the Notes column
 * back through narration parsing and overwrite the Payee column, discarding the
 * manual corrections. Hence an exact-header match with payees kept verbatim.
 */

import type { Table } from '../extract/types.js';

import type { ColumnMap } from './header.js';
import type { Interpreted, StatementTransaction } from './rows.js';
import { parseAmount, parseStatementDate } from './values.js';

/** The header `toCsv` writes. Must stay in step with `COLUMNS` there. */
const CONVERTED_HEADER = ['date', 'payee', 'notes', 'amount', 'reference'];

/** For reporting only. `description: 2` is Notes, though it is not re-parsed. */
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
 * Does this table look like output this tool produced?
 *
 * Strict by design: an exact header match, in order. A bank CSV that happens to
 * have a `Payee` column must still take the generic path so its narration gets
 * parsed.
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
 * resolved, possibly by hand. Nothing here re-derives any of it.
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
      // A blanked-out Payee still needs a value; same fallback as the parser.
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
