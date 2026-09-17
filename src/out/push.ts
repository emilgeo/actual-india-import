import type { StatementTransaction } from '../interpret/rows.js';

/**
 * The subset of Actual's `ImportTransactionEntity` we populate. Declared
 * locally so this module type-checks without `@actual-app/api` installed —
 * it is an optional peer dependency, since the CSV path is the default and
 * the API package pulls in a native SQLite build.
 */
export type ActualImportTransaction = {
  date: string;
  /** Integer paise. */
  amount: number;
  payee_name: string;
  imported_payee: string;
  notes: string;
  imported_id?: string;
  cleared: boolean;
};

export type PushConfig = {
  serverURL: string;
  password: string;
  syncId: string;
  dataDir: string;
  /** End-to-end encryption password, for encrypted budget files. */
  encryptionPassword?: string;
  /** Account name (case-insensitive) or id. */
  account: string;
  dryRun: boolean;
};

export type PushResult = {
  accountName: string;
  accountId: string;
  added: number;
  updated: number;
  errors: string[];
  dryRun: boolean;
};

/** Rupees to integer paise, matching Actual's own `amountToInteger`. */
export function toPaise(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Map parsed statement rows onto Actual's import shape.
 *
 * Two deliberate choices:
 *
 * - `payee_name` gets the cleaned merchant and `imported_payee` the original
 *   narration, which is exactly what those fields are for: the payee collapses
 *   correctly while Actual's payee matching still sees the raw text. This is
 *   the one thing the CSV output cannot do, since Actual's CSV field mapping
 *   has no `imported_payee` slot.
 * - `notes` also gets the narration, duplicating `imported_payee`. That
 *   duplication looked redundant and was originally left out, which was wrong:
 *   `imported_payee` is not a column you can read at a glance, whereas Notes
 *   is one you can see, search and filter. Without it the narration is
 *   effectively invisible after a push.
 * - `imported_id` is only set when a reference survived the uniqueness checks.
 *   Omitting it is the safe default: Actual falls back to matching on date and
 *   amount within a week, whereas a non-unique id makes it treat distinct
 *   transactions as the same one and drop them.
 */
export function toImportEntities(
  transactions: StatementTransaction[],
): ActualImportTransaction[] {
  return transactions.map(transaction => ({
    date: transaction.date,
    amount: toPaise(transaction.amount),
    payee_name: transaction.payee,
    imported_payee: transaction.raw,
    notes: transaction.raw,
    ...(transaction.ref ? { imported_id: transaction.ref } : {}),
    // Statement rows have already settled at the bank.
    cleared: true,
  }));
}

type ActualAccount = { id: string; name: string; closed?: boolean };

/**
 * The slice of `@actual-app/api` we use, described structurally.
 *
 * Declared here rather than imported so this file type-checks whether or not
 * the optional peer dependency is installed.
 */
type ActualApi = {
  init(config: {
    dataDir: string;
    serverURL: string;
    password: string;
  }): Promise<unknown>;
  downloadBudget(
    syncId: string,
    options?: { password: string },
  ): Promise<unknown>;
  getAccounts(): Promise<ActualAccount[]>;
  importTransactions(
    accountId: string,
    transactions: ActualImportTransaction[],
    opts: {
      dryRun?: boolean;
      defaultCleared?: boolean;
      payeeNameNormalization?: 'original' | 'title-case';
    },
  ): Promise<{
    added?: string[];
    updated?: string[];
    errors?: Array<{ message: string }>;
  }>;
  shutdown(): Promise<void>;
};

export function resolveAccount(
  accounts: ActualAccount[],
  wanted: string,
): ActualAccount {
  const needle = wanted.trim().toLowerCase();

  const match =
    accounts.find(account => account.id === wanted) ??
    accounts.find(account => account.name.trim().toLowerCase() === needle);

  if (!match) {
    const available = accounts
      .filter(account => !account.closed)
      .map(account => `  ${account.name}`)
      .join('\n');
    throw new Error(
      `No account matching "${wanted}". Open accounts:\n${available || '  (none)'}`,
    );
  }

  return match;
}

/**
 * Send transactions to Actual.
 *
 * `@actual-app/api` is imported dynamically so the converter works without it
 * installed, and so a missing install produces an actionable message rather
 * than a module-resolution error at startup.
 */
export async function pushTransactions(
  transactions: StatementTransaction[],
  config: PushConfig,
): Promise<PushResult> {
  let api: ActualApi;
  try {
    // Non-literal specifier on purpose: it keeps TypeScript from trying to
    // resolve an optional dependency that may not be installed.
    const specifier = '@actual-app/api';
    api = (await import(specifier)) as unknown as ActualApi;
  } catch {
    throw new Error(
      'The --push option needs the Actual API package:\n' +
        '  npm install @actual-app/api',
    );
  }

  await api.init({
    dataDir: config.dataDir,
    serverURL: config.serverURL,
    password: config.password,
  });

  try {
    await api.downloadBudget(
      config.syncId,
      config.encryptionPassword
        ? { password: config.encryptionPassword }
        : undefined,
    );

    const accounts = await api.getAccounts();
    const account = resolveAccount(accounts, config.account);

    const result = await api.importTransactions(
      account.id,
      toImportEntities(transactions),
      {
        dryRun: config.dryRun,
        defaultCleared: true,
        // Actual title-cases imported payees by default, which lowercases
        // first: `DMart` would become `Dmart` and `HDFC ... SIP` would become
        // `Hdfc ... Sip`. The names here are already deliberately cased.
        payeeNameNormalization: 'original',
      },
    );

    return {
      accountName: account.name,
      accountId: account.id,
      added: result.added?.length ?? 0,
      updated: result.updated?.length ?? 0,
      errors: (result.errors ?? []).map(error => error.message),
      dryRun: config.dryRun,
    };
  } finally {
    // Always shut down: this flushes the sync and closes the budget, and
    // leaving it open corrupts the local cache for the next run.
    await api.shutdown();
  }
}
