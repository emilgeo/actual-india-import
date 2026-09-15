/**
 * Column vocabulary for Indian bank statements.
 *
 * Every Indian bank ships variations of the same seven columns, which is what
 * makes a generic interpreter viable instead of an adapter per bank:
 *
 *   HDFC    Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance
 *   ICICI   S No. | Value Date | Transaction Date | Cheque Number | Transaction Remarks | Withdrawal Amount (INR) | Deposit Amount (INR) | Balance (INR)
 *   SBI     Txn Date | Value Date | Description | Ref No./Cheque No. | Debit | Credit | Balance
 *   Axis    Tran Date | CHQNO | PARTICULARS | DR | CR | BAL
 *
 * Matching is done on a normalised header cell (lowercased, non-alphanumerics
 * stripped), so `Withdrawal Amt.` becomes `withdrawalamt` and
 * `Deposit Amount (INR)` becomes `depositamountinr`. Prefix/substring patterns
 * then cover the variants without enumerating every spelling.
 */

export type ColumnRole =
  | 'date'
  | 'valueDate'
  | 'description'
  | 'debit'
  | 'credit'
  | 'amount'
  | 'drcr'
  | 'balance'
  | 'ref';

/**
 * Order is significant — the first pattern to match a header cell wins.
 *
 * `valueDate` precedes `date` because `Value Date` also ends in "date", and
 * `drcr` precedes `debit`/`credit` because a `DR/CR` indicator column would
 * otherwise be mistaken for an amount column.
 */
export const COLUMN_PATTERNS: Array<[ColumnRole, RegExp]> = [
  ['valueDate', /^value(date|dt)$/],
  ['drcr', /^(drcr|crdr|debitcredit|drcrindicator)$/],
  ['drcr', /^(transaction)?type$/],
  [
    'date',
    /^(txn|tran|transaction|posting|post|entry|booking|trade)?d(ate|t)$/,
  ],
  ['date', /^dateoftransaction$/],
  ['description', /(narration|particular|description|remark|detail|narrative)/],
  ['debit', /^(withdrawal|debit|dr)/],
  ['credit', /^(deposit|credit|cr)/],
  ['balance', /(balance|^bal$)/],
  ['amount', /^(amount|amt|txnamount|transactionamount)/],
  ['ref', /(chq|cheque|refno|reference|utr|rrn|transactionid)/],
];

export function normalizeHeader(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function roleForHeader(cell: string): ColumnRole | null {
  const normalized = normalizeHeader(cell);
  if (!normalized) {
    return null;
  }

  for (const [role, pattern] of COLUMN_PATTERNS) {
    if (pattern.test(normalized)) {
      return role;
    }
  }

  return null;
}
