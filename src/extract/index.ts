import { readFile } from 'node:fs/promises';

import { extractCsv } from './csv.js';
import { extractHtmlTable } from './html-table.js';
import { extractPdf } from './pdf.js';
import { describeFormat, detectFormat } from './sniff.js';
import type { DetectedFormat } from './sniff.js';
import { extractSpreadsheetMl } from './spreadsheetml.js';
import type { Table } from './types.js';
import { extractXlsx } from './xlsx.js';

export type ExtractOptions = {
  /** Only used for delimited text. */
  delimiter?: string;
  /** Only used for encrypted PDFs. */
  password?: string;
};

export type Extraction = {
  table: Table;
  /** What the file turned out to be, which is often not what it is named. */
  format: DetectedFormat;
};

/**
 * Read a statement file into a table, choosing the parser by inspecting the
 * contents rather than the extension.
 */
export async function extractTable(
  path: string,
  options: ExtractOptions = {},
): Promise<Extraction> {
  const buffer = await readFile(path);
  const format = detectFormat(buffer);

  switch (format) {
    case 'xlsx':
      return { table: await extractXlsx(path), format };
    case 'html':
      return { table: await extractHtmlTable(path), format };
    case 'spreadsheetml':
      return { table: await extractSpreadsheetMl(path), format };
    case 'pdf':
      return {
        table: await extractPdf(
          path,
          options.password ? { password: options.password } : {},
        ),
        format,
      };
    case 'biff':
      // Legacy BIFF has no maintained, permissively licensed reader for Node,
      // and re-saving is a one-step fix, so this stays an explicit refusal
      // rather than a half-working parser.
      throw new Error(
        `${path} is a ${describeFormat(format)}, which is not supported.\n` +
          'Open it in Excel or LibreOffice and "Save As" .xlsx or .csv, then ' +
          'run this again. If your bank offers CSV through internet banking, ' +
          'that is the most reliable option.',
      );
    case 'text':
    default:
      return {
        table: await extractCsv(
          path,
          options.delimiter ? { delimiter: options.delimiter } : {},
        ),
        format: 'text',
      };
  }
}

export { describeFormat, detectFormat };
export type { DetectedFormat, Table };
