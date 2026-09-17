import { describe, expect, it } from 'vitest';

import { COLUMNS, toCsv } from '../out/csv.js';

import { interpretConvertedOutput, isConvertedOutput } from './roundtrip.js';
import type { StatementTransaction } from './rows.js';

function table(rows: string[][]) {
  return { rows, source: { path: 'test.csv', format: 'csv' as const } };
}

/** Parse a CSV string back into rows, the way the csv extractor would. */
function rowsOf(csv: string): string[][] {
  return csv
    .trim()
    .split('\n')
    .map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '')));
}

const transactions: StatementTransaction[] = [
  {
    date: '2026-01-04',
    amount: -50000,
    payee: 'A N Other',
    raw: 'IMPS-OPM/100000000001/A N OTHER/FDRL0000001/0000/',
    kind: 'imps',
    ref: '100000000001',
  },
  {
    date: '2026-01-31',
    amount: 1927,
    payee: 'Monthly Savings Interest',
    raw: 'MONTHLY SAVINGS INTEREST CREDIT',
    kind: 'other',
  },
];

describe('isConvertedOutput', () => {
  it('recognises the header this tool writes', () => {
    // Derived from the real writer, so a column rename breaks this test rather
    // than silently disabling the round trip.
    expect(isConvertedOutput(table(rowsOf(toCsv(transactions))))).toBe(true);
    expect(COLUMNS).toEqual(['Date', 'Payee', 'Notes', 'Amount', 'Reference']);
  });

  it('ignores case and surrounding space in the header', () => {
    const rows = [[' date ', 'PAYEE', 'Notes', 'amount', 'Reference']];

    expect(isConvertedOutput(table(rows))).toBe(true);
  });

  it('does not claim a bank CSV that merely has a Payee column', () => {
    // This is the false positive that matters: such a file must still go down
    // the generic path so its narration gets parsed.
    const rows = [['Date', 'Payee', 'Withdrawal', 'Deposit', 'Balance']];

    expect(isConvertedOutput(table(rows))).toBe(false);
  });

  it('does not claim a table with the right names in the wrong order', () => {
    const rows = [['Date', 'Notes', 'Payee', 'Amount', 'Reference']];

    expect(isConvertedOutput(table(rows))).toBe(false);
  });

  it('handles an empty table', () => {
    expect(isConvertedOutput(table([]))).toBe(false);
  });
});

describe('interpretConvertedOutput', () => {
  const roundTrip = () =>
    interpretConvertedOutput(table(rowsOf(toCsv(transactions))));

  it('preserves every field through a full round trip', () => {
    const result = roundTrip();

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      date: '2026-01-04',
      amount: -50000,
      payee: 'A N Other',
      raw: 'IMPS-OPM/100000000001/A N OTHER/FDRL0000001/0000/',
      ref: '100000000001',
    });
  });

  it('keeps a reference so deduplication still works after a round trip', () => {
    // The reference becomes `imported_id`. Losing it here would make a
    // CSV-then-push re-import create duplicates.
    expect(roundTrip().transactions[0]?.ref).toBe('100000000001');
    expect(roundTrip().transactions[1]?.ref).toBeUndefined();
  });

  it('keeps a hand-corrected payee verbatim instead of re-deriving it', () => {
    // The whole reason for a dedicated path. Re-parsing the narration would
    // resolve this back to `A N Other` and throw the correction away.
    const rows = rowsOf(toCsv(transactions));
    rows[1]![1] = 'Rent — landlord';

    const result = interpretConvertedOutput(table(rows));

    expect(result.transactions[0]?.payee).toBe('Rent — landlord');
    expect(result.transactions[0]?.raw).toContain('IMPS-OPM');
  });

  it('does not lower-case or title-case the payee', () => {
    const rows = rowsOf(toCsv(transactions));
    rows[1]![1] = 'DMart';

    expect(interpretConvertedOutput(table(rows)).transactions[0]?.payee).toBe(
      'DMart',
    );
  });

  it('falls back to the narration when a payee has been blanked out', () => {
    const rows = rowsOf(toCsv(transactions));
    rows[1]![1] = '';

    expect(interpretConvertedOutput(table(rows)).transactions[0]?.payee).toBe(
      'IMPS-OPM/100000000001/A N OTHER/FDRL0000001/0000/',
    );
  });

  it('skips rows it cannot read rather than guessing', () => {
    const rows = rowsOf(toCsv(transactions));
    rows.push(['not-a-date', 'Someone', 'note', '100.00', '']);
    rows.push(['2026-02-01', 'Someone', 'note', 'not-an-amount', '']);

    const result = interpretConvertedOutput(table(rows));

    expect(result.transactions).toHaveLength(2);
    expect(result.skipped.map(row => row.reason)).toEqual([
      'no parseable date',
      'no parseable amount',
    ]);
  });

  it('reports no balance data, so the caller can warn', () => {
    // The CSV has no balance column, so a round-tripped run is not
    // independently verified. The CLI says so explicitly.
    expect(
      roundTrip().transactions.every(
        transaction => transaction.balance === undefined,
      ),
    ).toBe(true);
  });
});
