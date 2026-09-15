import type { StatementTransaction } from './rows.js';

export type ValidationStatus = 'passed' | 'failed' | 'skipped';

export type Validation = {
  status: ValidationStatus;
  /** Row order the balance column implies, when it could be determined. */
  order?: 'ascending' | 'descending';
  /** Number of consecutive pairs checked. */
  checked: number;
  matched: number;
  issues: string[];
};

/** Half a paisa — comfortably inside any rounding a bank applies. */
const EPSILON = 0.005;

/**
 * Verify parsed amounts against the statement's running balance.
 *
 * Almost every Indian statement carries a closing-balance column, which makes
 * the parse self-checkable: each transaction must equal the change in balance
 * it caused. This is the difference between "the numbers look plausible" and
 * "the numbers are provably right", and it catches precisely the failure modes
 * of geometric PDF extraction — inverted debit/credit signs, dropped rows, and
 * columns read one position across.
 *
 * Statements come in both date orders, so both interpretations are scored and
 * the better one wins:
 *   ascending  (oldest first): amount[i] === balance[i] - balance[i-1]
 *   descending (newest first): amount[i] === balance[i] - balance[i+1]
 */
export function validateBalances(
  transactions: StatementTransaction[],
): Validation {
  const withBalance = transactions.filter(
    transaction => transaction.balance !== undefined,
  );

  if (withBalance.length < 2) {
    return {
      status: 'skipped',
      checked: 0,
      matched: 0,
      issues: [
        withBalance.length === 0
          ? 'No balance column found — amounts could not be cross-checked.'
          : 'Only one row carried a balance — not enough to cross-check.',
      ],
    };
  }

  const ascending: string[] = [];
  const descending: string[] = [];
  let ascendingMatches = 0;
  let descendingMatches = 0;

  for (let index = 1; index < withBalance.length; index += 1) {
    const current = withBalance[index];
    const previous = withBalance[index - 1];
    if (!current || !previous) {
      continue;
    }

    // Ascending: this row's balance moved by this row's amount.
    const ascDelta = (current.balance ?? 0) - (previous.balance ?? 0);
    if (Math.abs(ascDelta - current.amount) < EPSILON) {
      ascendingMatches += 1;
    } else {
      ascending.push(describe(current, ascDelta));
    }

    // Descending: the *previous* row is the later transaction, so its amount
    // explains the gap between the two balances.
    const descDelta = (previous.balance ?? 0) - (current.balance ?? 0);
    if (Math.abs(descDelta - previous.amount) < EPSILON) {
      descendingMatches += 1;
    } else {
      descending.push(describe(previous, descDelta));
    }
  }

  const checked = withBalance.length - 1;
  const isDescending = descendingMatches > ascendingMatches;
  const matched = isDescending ? descendingMatches : ascendingMatches;
  const failures = isDescending ? descending : ascending;

  if (matched === checked) {
    return {
      status: 'passed',
      order: isDescending ? 'descending' : 'ascending',
      checked,
      matched,
      issues: [],
    };
  }

  return {
    status: 'failed',
    order: isDescending ? 'descending' : 'ascending',
    checked,
    matched,
    issues: [
      `${checked - matched} of ${checked} rows do not agree with the balance column.`,
      // A handful of examples is enough to diagnose; the full list is noise.
      ...failures.slice(0, 5),
    ],
  };
}

function describe(
  transaction: StatementTransaction,
  observedDelta: number,
): string {
  const expected = observedDelta.toFixed(2);
  const actual = transaction.amount.toFixed(2);
  return `${transaction.date} "${truncate(transaction.raw)}": balance moved by ${expected} but the parsed amount is ${actual}`;
}

function truncate(value: string, limit = 60): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
