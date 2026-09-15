import { writeFile } from 'node:fs/promises';

import { stringify } from 'csv-stringify/sync';

import type { StatementTransaction } from '../interpret/rows.js';

/**
 * Columns chosen to match what Actual's import dialog can actually map:
 * date, payee, notes and amount.
 *
 * Note the deliberate compromise on notes. Actual's CSV field mapping has no
 * `imported_payee` slot (only date, amount, payee, notes, category, in/out and
 * inflow/outflow), so the raw narration goes into Notes to keep it visible.
 * The API path does not have this limitation and sets `imported_payee`
 * properly — this is the one place the CSV route is lossier.
 *
 * `Reference` is emitted for human inspection; leave it unmapped on import.
 */
const COLUMNS = ['Date', 'Payee', 'Notes', 'Amount', 'Reference'] as const;

export function toCsv(transactions: StatementTransaction[]): string {
  const rows = transactions.map(transaction => [
    transaction.date,
    transaction.payee,
    transaction.raw,
    transaction.amount.toFixed(2),
    transaction.ref ?? '',
  ]);

  return stringify(rows, { header: true, columns: [...COLUMNS] });
}

export async function writeCsv(
  path: string,
  transactions: StatementTransaction[],
): Promise<void> {
  await writeFile(path, toCsv(transactions), 'utf8');
}
