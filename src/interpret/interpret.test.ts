import { describe, expect, it } from 'vitest';

import type { Table } from '../extract/types.js';

import { findHeader } from './header.js';
import { interpretTable } from './rows.js';
import type { StatementTransaction } from './rows.js';
import { validateBalances } from './validate.js';
import { parseAmount, parseStatementDate } from './values.js';

function table(rows: string[][]): Table {
  return { rows, source: { path: 'test.csv', format: 'csv' } };
}

describe('parseAmount', () => {
  it('parses Indian lakh grouping', () => {
    expect(parseAmount('1,23,456.78')).toBe(123456.78);
    expect(parseAmount('12,34,567')).toBe(1234567);
  });

  it('strips currency decoration', () => {
    expect(parseAmount('₹1,234.50')).toBe(1234.5);
    expect(parseAmount('Rs. 1,234.50')).toBe(1234.5);
    expect(parseAmount('INR 1,234.50')).toBe(1234.5);
  });

  it('handles the several ways a statement marks money out', () => {
    expect(parseAmount('-1,234.50')).toBe(-1234.5);
    expect(parseAmount('(1,234.50)')).toBe(-1234.5);
    expect(parseAmount('1,234.50 Dr')).toBe(-1234.5);
    expect(parseAmount('1,234.50 Cr')).toBe(1234.5);
  });

  it('treats blanks and placeholders as absent', () => {
    for (const value of ['', '   ', '-', 'NIL', 'NA']) {
      expect(parseAmount(value)).toBeNull();
    }
  });
});

describe('parseStatementDate', () => {
  it('defaults to day-first, the Indian convention', () => {
    expect(parseStatementDate('01/04/2024')).toBe('2024-04-01');
    expect(parseStatementDate('01-04-24')).toBe('2024-04-01');
    expect(parseStatementDate('01.04.2024')).toBe('2024-04-01');
  });

  it('reads month names', () => {
    expect(parseStatementDate('01-Apr-2024')).toBe('2024-04-01');
    expect(parseStatementDate('1 April 24')).toBe('2024-04-01');
  });

  it('reads ISO regardless of the configured order', () => {
    expect(parseStatementDate('2024-04-01', 'dmy')).toBe('2024-04-01');
  });

  it('ignores a trailing time component', () => {
    expect(parseStatementDate('01/04/2024 00:00:00')).toBe('2024-04-01');
  });

  it('rejects impossible and unparseable dates', () => {
    expect(parseStatementDate('31/02/2024')).toBeNull();
    expect(parseStatementDate('Opening Balance')).toBeNull();
    expect(parseStatementDate('')).toBeNull();
  });
});

describe('findHeader', () => {
  it('finds the header below a statement preamble', () => {
    const match = findHeader([
      ['HDFC BANK LTD'],
      ['Statement of account'],
      [],
      [
        'Date',
        'Narration',
        'Chq./Ref.No.',
        'Value Dt',
        'Withdrawal Amt.',
        'Deposit Amt.',
        'Closing Balance',
      ],
      [
        '01/04/24',
        'UPI/DR/1/X/Y/z@ybl/Payment',
        '',
        '01/04/24',
        '1.00',
        '',
        '2.00',
      ],
    ]);

    expect(match?.index).toBe(3);
    expect(match?.map).toMatchObject({
      date: 0,
      description: 1,
      ref: 2,
      valueDate: 3,
      debit: 4,
      credit: 5,
      balance: 6,
    });
  });

  it('handles the ICICI vocabulary and its two date columns', () => {
    const match = findHeader([
      [
        'S No.',
        'Value Date',
        'Transaction Date',
        'Cheque Number',
        'Transaction Remarks',
        'Withdrawal Amount (INR)',
        'Deposit Amount (INR)',
        'Balance (INR)',
      ],
    ]);

    expect(match?.map).toMatchObject({
      valueDate: 1,
      date: 2,
      ref: 3,
      description: 4,
      debit: 5,
      credit: 6,
      balance: 7,
    });
  });

  it('handles the terse Axis vocabulary', () => {
    const match = findHeader([
      ['Tran Date', 'CHQNO', 'PARTICULARS', 'DR', 'CR', 'BAL'],
    ]);

    expect(match?.map).toMatchObject({
      date: 0,
      ref: 1,
      description: 2,
      debit: 3,
      credit: 4,
      balance: 5,
    });
  });

  it('returns null when there is no transaction table', () => {
    expect(findHeader([['Account Holder'], ['Mr. A N Other']])).toBeNull();
  });
});

const hdfcStatement = table([
  ['HDFC BANK LTD'],
  ['Statement of account'],
  [],
  [
    'Date',
    'Narration',
    'Chq./Ref.No.',
    'Value Dt',
    'Withdrawal Amt.',
    'Deposit Amt.',
    'Closing Balance',
  ],
  [
    '01/04/24',
    'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment',
    '',
    '01/04/24',
    '450.50',
    '',
    '1,23,456.78',
  ],
  [
    '02/04/24',
    'SALARY ACME CONSULTING',
    '',
    '02/04/24',
    '',
    '50,000.00',
    '1,73,456.78',
  ],
  [
    '03/04/24',
    'ATW/1234/CASH WDL/BANGALORE',
    '',
    '03/04/24',
    '2,000.00',
    '',
    '1,71,456.78',
  ],
  ['', '*** End of statement ***'],
]);

describe('interpretTable', () => {
  it('reads an HDFC-shaped statement end to end', () => {
    const result = interpretTable(hdfcStatement);

    expect(result).not.toBeNull();
    expect(result?.transactions).toHaveLength(3);

    expect(result?.transactions[0]).toMatchObject({
      date: '2024-04-01',
      amount: -450.5,
      payee: 'Swiggy',
      ref: '412345678901',
      balance: 123456.78,
    });
    expect(result?.transactions[1]).toMatchObject({
      date: '2024-04-02',
      amount: 50000,
    });
    expect(result?.transactions[2]).toMatchObject({
      amount: -2000,
      payee: 'ATM Withdrawal',
      kind: 'atm',
    });
  });

  it('keeps the raw narration for imported_payee', () => {
    const result = interpretTable(hdfcStatement);

    expect(result?.transactions[0]?.raw).toBe(
      'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment',
    );
  });

  it('skips the footer rather than guessing at it', () => {
    const result = interpretTable(hdfcStatement);

    expect(result?.skipped).toHaveLength(1);
    expect(result?.skipped[0]?.reason).toBe('no parseable date');
  });

  it('returns null when no transaction table can be found', () => {
    expect(
      interpretTable(table([['Account Holder'], ['Mr. A N Other']])),
    ).toBeNull();
  });

  it('drops references that repeat, which cannot be real bank references', () => {
    // Both rows carry the same value in the reference column — a padded
    // placeholder, not a per-transaction id. Keeping it would make Actual
    // treat the second transaction as a duplicate of the first.
    const result = interpretTable(
      table([
        ['Date', 'Narration', 'Ref No', 'Debit', 'Credit', 'Balance'],
        ['01/04/24', 'PAYMENT ONE', '999999999', '100.00', '', '900.00'],
        ['02/04/24', 'PAYMENT TWO', '999999999', '100.00', '', '800.00'],
      ]),
    );

    expect(result?.droppedRefs).toBe(2);
    expect(result?.transactions.every(t => t.ref === undefined)).toBe(true);
  });

  it('applies a Dr/Cr indicator column over the amount sign', () => {
    const result = interpretTable(
      table([
        ['Date', 'Particulars', 'Amount', 'DR/CR', 'Balance'],
        ['01/04/24', 'PAYMENT ONE', '100.00', 'DR', '900.00'],
        ['02/04/24', 'REFUND', '50.00', 'CR', '950.00'],
      ]),
    );

    expect(result?.transactions.map(t => t.amount)).toEqual([-100, 50]);
  });
});

function transactionsOf(
  entries: Array<[amount: number, balance: number]>,
): StatementTransaction[] {
  return entries.map(([amount, balance], index) => ({
    date: `2024-04-0${index + 1}`,
    amount,
    balance,
    payee: 'Test',
    raw: 'TEST NARRATION',
    kind: 'other' as const,
  }));
}

describe('validateBalances', () => {
  it('passes when every amount agrees with the balance column', () => {
    const result = validateBalances(
      transactionsOf([
        [-450.5, 1000],
        [50000, 51000],
        [-2000, 49000],
      ]),
    );

    expect(result.status).toBe('passed');
    expect(result.order).toBe('ascending');
    expect(result.matched).toBe(2);
  });

  it('recognises a newest-first statement', () => {
    const result = validateBalances(
      transactionsOf([
        [-2000, 49000],
        [50000, 51000],
        [-450.5, 1000],
      ]),
    );

    expect(result.status).toBe('passed');
    expect(result.order).toBe('descending');
  });

  it('catches an inverted sign', () => {
    // The middle amount should be +50000; a debit/credit mix-up flips it.
    const result = validateBalances(
      transactionsOf([
        [-450.5, 1000],
        [-50000, 51000],
        [-2000, 49000],
      ]),
    );

    expect(result.status).toBe('failed');
    expect(result.issues[0]).toContain('do not agree with the balance column');
  });

  it('catches a dropped row', () => {
    // 51000 -> 49000 needs a -2000 row; without it the jump is unexplained.
    const result = validateBalances(
      transactionsOf([
        [-450.5, 1000],
        [50000, 51000],
        [-10, 49000],
      ]),
    );

    expect(result.status).toBe('failed');
  });

  it('reports honestly when there is nothing to check against', () => {
    const result = validateBalances([
      {
        date: '2024-04-01',
        amount: -1,
        payee: 'Test',
        raw: 'TEST',
        kind: 'other',
      },
    ]);

    expect(result.status).toBe('skipped');
    expect(result.issues[0]).toContain('No balance column');
  });
});
