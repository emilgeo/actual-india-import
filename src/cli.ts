#!/usr/bin/env node
import { basename, dirname, extname, join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

import { extractCsv } from './extract/csv.js';
import type { Table } from './extract/types.js';
import { interpretTable } from './interpret/rows.js';
import { validateBalances } from './interpret/validate.js';
import type { DateOrder } from './interpret/values.js';
import { loadMerchantRules } from './merchants-file.js';
import type { MerchantRule } from './narration/merchants.js';
import { toCsv, writeCsv } from './out/csv.js';

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

Currently supported input: CSV/TSV. XLS/XLSX and PDF are not implemented yet.
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

  return options;
}

async function extract(path: string, delimiter?: string): Promise<Table> {
  const extension = extname(path).toLowerCase();

  switch (extension) {
    case '.csv':
    case '.tsv':
    case '.txt':
      return extractCsv(path, delimiter ? { delimiter } : {});
    case '.xls':
    case '.xlsx':
      throw new Error(
        'Spreadsheet support is not implemented yet. For now, open the file ' +
          'and save it as CSV, then run this again.',
      );
    case '.pdf':
      throw new Error(
        'PDF support is not implemented yet. If your bank offers XLS or CSV ' +
          'through internet banking, prefer that — it is far more reliable ' +
          'than extracting tables from a PDF.',
      );
    default:
      throw new Error(`Unsupported file type: ${extension || path}`);
  }
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

  const table = await extract(options.input, options.delimiter);
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

  if (options.useStdout) {
    stdout.write(toCsv(transactions));
    return 0;
  }

  const outPath = options.out ?? defaultOutPath(options.input);
  await writeCsv(outPath, transactions);
  log(`Wrote ${outPath}`);

  return 0;
}

run(argv.slice(2))
  .then(code => exit(code))
  .catch((error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
