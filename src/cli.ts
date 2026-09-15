#!/usr/bin/env node
import { basename, dirname, extname, join } from 'node:path';
import { argv, cwd, env, exit, stderr, stdout } from 'node:process';

import { describeFormat, extractTable } from './extract/index.js';
import { interpretTable } from './interpret/rows.js';
import { validateBalances } from './interpret/validate.js';
import type { DateOrder } from './interpret/values.js';
import { loadMerchantRules } from './merchants-file.js';
import type { MerchantRule } from './narration/merchants.js';
import { toCsv, writeCsv } from './out/csv.js';
import { pushTransactions } from './out/push.js';
import type { PushConfig } from './out/push.js';

const USAGE = `
actual-india-import — convert Indian bank statements for Actual Budget

Usage:
  actual-india-import <statement-file> [options]

Options:
  --out <path>          Where to write the normalised CSV.
                        Default: <input>.actual.csv next to the input file.
  --stdout              Write the CSV to stdout instead of a file.
  --date-order <order>  dmy (default), mdy or ymd. Only affects all-numeric
                        dates, where 01/02/2024 is genuinely ambiguous.
  --delimiter <char>    Force the CSV delimiter instead of detecting it.
  --merchants <path>    JSON file of { pattern, name } merchant rules, which
                        take precedence over the built-in map.
  --force               Write the CSV even if the balance check fails.
  --quiet               Only report problems.
  --help                Show this message.

Pushing straight into Actual (instead of writing a CSV):
  --push                Send the transactions to Actual via its API.
  --account <name|id>   Which Actual account to import into. Required for --push.
  --dry-run             With --push, report what would change without writing.

  Credentials come from the environment, never from flags (a flag would end up
  in your shell history):
    ACTUAL_SERVER_URL           e.g. https://actual.example.com
    ACTUAL_PASSWORD             your server password
    ACTUAL_SYNC_ID              the budget's sync id (Settings > Advanced)
    ACTUAL_ENCRYPTION_PASSWORD  only if the budget file is encrypted
    ACTUAL_DATA_DIR             local cache dir (default: ./.actual-cache)

  --push needs the API package: npm install @actual-app/api

Input is detected by content, not by extension, because banks routinely name
HTML tables ".xls". Supported: CSV/TSV, Excel .xlsx, HTML tables, and Excel
2003 XML. Legacy binary .xls must be re-saved as .xlsx or .csv first. PDF is
not implemented yet.
`.trim();

type Options = {
  input: string;
  out?: string;
  useStdout: boolean;
  dateOrder: DateOrder;
  delimiter?: string;
  merchants?: string;
  force: boolean;
  quiet: boolean;
  push: boolean;
  account?: string;
  dryRun: boolean;
};

function parseArgs(args: string[]): Options | null {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    return null;
  }

  const options: Options = {
    input: '',
    useStdout: false,
    dateOrder: 'dmy',
    force: false,
    quiet: false,
    push: false,
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--out':
        options.out = next();
        break;
      case '--stdout':
        options.useStdout = true;
        break;
      case '--date-order': {
        const value = next();
        if (value !== 'dmy' && value !== 'mdy' && value !== 'ymd') {
          throw new Error('--date-order must be dmy, mdy or ymd');
        }
        options.dateOrder = value;
        break;
      }
      case '--delimiter':
        options.delimiter = next();
        break;
      case '--merchants':
        options.merchants = next();
        break;
      case '--push':
        options.push = true;
        break;
      case '--account':
        options.account = next();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      default:
        if (arg === undefined || arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (options.input) {
          throw new Error('Only one input file at a time');
        }
        options.input = arg;
    }
  }

  if (!options.input) {
    throw new Error('No input file given');
  }

  if (options.push && !options.account) {
    throw new Error('--push also needs --account <name|id>');
  }

  if (options.dryRun && !options.push) {
    throw new Error('--dry-run only applies to --push');
  }

  return options;
}

function defaultOutPath(input: string): string {
  const extension = extname(input);
  const name = basename(input, extension);
  return join(dirname(input), `${name}.actual.csv`);
}

async function run(args: string[]): Promise<number> {
  const options = parseArgs(args);
  if (!options) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  const log = (message: string) => {
    if (!options.quiet) {
      stderr.write(`${message}\n`);
    }
  };

  let merchantRules: MerchantRule[] = [];
  if (options.merchants) {
    merchantRules = await loadMerchantRules(options.merchants);
    log(
      `Loaded ${merchantRules.length} merchant rule(s) from ${options.merchants}`,
    );
  }

  if (extname(options.input).toLowerCase() === '.pdf') {
    throw new Error(
      'PDF support is not implemented yet. If your bank offers XLS or CSV ' +
        'through internet banking, prefer that — it is far more reliable than ' +
        'extracting tables from a PDF.',
    );
  }

  // Resolved before any parsing work so a missing credential or account fails
  // immediately rather than after processing the whole statement.
  const pushConfig = options.push ? pushConfigFromEnv(options) : null;

  const { table, format } = await extractTable(
    options.input,
    options.delimiter ? { delimiter: options.delimiter } : {},
  );
  log(`Read ${options.input} as ${describeFormat(format)}`);

  const result = interpretTable(table, {
    dateOrder: options.dateOrder,
    ...(merchantRules.length ? { merchantRules } : {}),
  });

  if (!result) {
    stderr.write(
      'Could not find a transaction table in this file.\n' +
        'Expected columns resembling: Date, Narration/Particulars, ' +
        'Withdrawal/Debit, Deposit/Credit, Balance.\n',
    );
    return 1;
  }

  const { transactions, skipped, header, droppedRefs } = result;

  log(
    `Header on row ${header.index + 1}; columns: ${Object.entries(header.map)
      .map(([role, column]) => `${role}=${column}`)
      .join(', ')}`,
  );
  log(
    `Parsed ${transactions.length} transaction(s), skipped ${skipped.length} row(s)`,
  );

  if (droppedRefs) {
    log(
      `Discarded ${droppedRefs} non-unique reference(s); those rows will rely ` +
        `on Actual's date and amount matching instead.`,
    );
  }

  if (!transactions.length) {
    stderr.write('No transactions were parsed — nothing to write.\n');
    return 1;
  }

  // The balance column is the only independent check we have that the parse is
  // right, so a failure blocks the write unless explicitly overridden.
  const validation = validateBalances(transactions);
  if (validation.status === 'failed') {
    stderr.write(
      `Balance check FAILED (${validation.matched}/${validation.checked} rows agree).\n`,
    );
    for (const issue of validation.issues) {
      stderr.write(`  ${issue}\n`);
    }
    if (!options.force) {
      stderr.write(
        'Refusing to write a statement that does not reconcile. ' +
          'Re-run with --force to write it anyway.\n',
      );
      return 2;
    }
    stderr.write('Writing anyway because --force was given.\n');
  } else if (validation.status === 'passed') {
    log(
      `Balance check passed (${validation.matched}/${validation.checked} rows, ` +
        `${validation.order} order).`,
    );
  } else {
    log(`Balance check skipped: ${validation.issues[0] ?? 'no balance data'}`);
  }

  if (pushConfig) {
    const result = await pushTransactions(transactions, pushConfig);

    const verb = result.dryRun ? 'would add' : 'added';
    const alsoVerb = result.dryRun ? 'would update' : 'updated';
    stderr.write(
      `${result.dryRun ? '[dry run] ' : ''}${result.accountName}: ` +
        `${verb} ${result.added}, ${alsoVerb} ${result.updated}.\n`,
    );

    for (const error of result.errors) {
      stderr.write(`  error: ${error}\n`);
    }

    return result.errors.length ? 1 : 0;
  }

  if (options.useStdout) {
    stdout.write(toCsv(transactions));
    return 0;
  }

  const outPath = options.out ?? defaultOutPath(options.input);
  await writeCsv(outPath, transactions);
  log(`Wrote ${outPath}`);

  return 0;
}

/**
 * Build the push configuration from the environment.
 *
 * Credentials are read from the environment rather than accepted as flags so
 * they do not end up in shell history or process listings.
 */
function pushConfigFromEnv(options: Options): PushConfig {
  if (!options.account) {
    throw new Error('--push also needs --account <name|id>');
  }

  const missing = (
    ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID'] as const
  ).filter(name => !env[name]);
  if (missing.length) {
    throw new Error(
      `--push needs these environment variables: ${missing.join(', ')}\n` +
        'See --help for the full list.',
    );
  }

  const encryptionPassword = env.ACTUAL_ENCRYPTION_PASSWORD;

  return {
    serverURL: env.ACTUAL_SERVER_URL as string,
    password: env.ACTUAL_PASSWORD as string,
    syncId: env.ACTUAL_SYNC_ID as string,
    dataDir: env.ACTUAL_DATA_DIR ?? join(cwd(), '.actual-cache'),
    account: options.account,
    dryRun: options.dryRun,
    ...(encryptionPassword ? { encryptionPassword } : {}),
  };
}

run(argv.slice(2))
  .then(code => exit(code))
  .catch((error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
