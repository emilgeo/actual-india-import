import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { roleForHeader } from '../interpret/synonyms.js';
import { parseStatementDate } from '../interpret/values.js';

import type { Table } from './types.js';

export type PdfExtractOptions = {
  password?: string;
};

export type Item = { x: number; right: number; y: number; text: string };
/**
 * `page` matters for more than reporting: y coordinates restart on every page,
 * so two lines' y values are only comparable within the same page.
 */
export type Line = { y: number; page: number; items: Item[] };

/** A fragment of one cell, contributed by one line. */
type Fragment = { text: string; right: number };

/**
 * Text items on the same visual line can differ slightly in baseline, so
 * y values are clustered rather than compared exactly.
 */
const LINE_TOLERANCE = 2;

/**
 * How far above its own row a wrapped cell's first line may sit.
 *
 * Statement PDFs render a multi-line description cell centred on its row, so
 * its first line can begin slightly *above* the line carrying the date and
 * amounts. Without this, that line would attach to the previous transaction.
 */
const ATTACH_ABOVE = 6;

/**
 * How far short of its column's wrap width a fragment must end to count as a
 * deliberate line break rather than a wrap.
 */
const SHORT_LINE_MARGIN = 8;

/**
 * How far below its row a wrapped line may sit and still belong to it.
 *
 * Page footers live well below the last transaction on a page, and without a
 * limit they are folded into it — which is how ICICI's `www.icici.bank.in`
 * and its toll-free number ended up inside a narration and an amount.
 */
const MAX_CONTINUATION_BELOW = 40;

async function readLines(
  path: string,
  options: PdfExtractOptions,
): Promise<{ lines: Line[]; pages: number }> {
  const doc = await getDocument({
    url: path,
    useSystemFonts: true,
    ...(options.password ? { password: options.password } : {}),
  }).promise;

  const lines: Line[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();

    const items: Item[] = [];
    for (const raw of content.items) {
      if (!('str' in raw) || !raw.str.trim()) {
        continue;
      }
      const x = raw.transform[4] as number;
      const width = typeof raw.width === 'number' ? raw.width : 0;
      items.push({
        x,
        right: x + width,
        y: raw.transform[5] as number,
        text: raw.str,
      });
    }

    // Pages are independent: y coordinates restart, so lines must not be
    // clustered across a page boundary.
    lines.push(...clusterLines(items, pageNumber));
  }

  return { lines, pages: doc.numPages };
}

/** Group items into lines, top of page first. */
function clusterLines(items: Item[], page: number): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const lines: Line[] = [];

  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.y - item.y) <= LINE_TOLERANCE) {
      current.items.push(item);
    } else {
      lines.push({ y: item.y, page, items: [item] });
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }

  return lines;
}

/**
 * Does this line start a transaction?
 *
 * Judged from the raw items rather than from assembled cells, because column
 * inference depends on this and must not depend on columns in turn.
 */
function isAnchorLine(line: Line): boolean {
  return line.items.some(item => parseStatementDate(item.text) !== null);
}

/**
 * Is this a summary row rather than a transaction?
 *
 * Statements bracket the table with totals and carried-forward balances:
 * Federal prints `GRAND TOTAL` with per-column sums, and an
 * `Opening Balance` row above the first transaction. Neither has a date, so
 * both would otherwise be folded into the nearest transaction — the grand
 * total's column sums landing in an amount field, which the balance check
 * then rejects.
 */
function isSummaryLine(line: Line): boolean {
  const text = line.items
    .map(item => item.text)
    .join(' ')
    .trim();

  return /^(grand\s*total|sub\s*total|total|opening\s*balance|closing\s*balance|balance\s*(carried|brought)\s*forward|[bc]\/f)\b/i.test(
    text,
  );
}

/** Does this line contribute column labels? */
function isHeaderLine(line: Line): boolean {
  if (isAnchorLine(line) || isSummaryLine(line)) {
    return false;
  }
  return (
    line.items.filter(item => roleForHeader(item.text) !== null).length >= 2
  );
}

/** A column, as the horizontal span its text occupies. */
export type Band = { left: number; right: number };

/**
 * Narrowest run of horizontal whitespace that separates two columns.
 *
 * Measured against real statements: Federal's tightest genuine gutter is 7
 * points and ICICI's is 5, while gaps *within* a column are smaller still.
 */
const MIN_GUTTER = 4;

/** Index of the first line contributing column labels, or -1. */
function firstHeaderIndex(lines: Line[]): number {
  return lines.findIndex(isHeaderLine);
}

/**
 * The lines making up the transaction table: the header, plus the dated rows
 * below it.
 *
 * Anchors are restricted to lines *after* the header because statement
 * preambles contain dates of their own — Federal prints `Address Last Updated
 * On : 13/08/2024` and `Account Open Date : 25/03/2013` above the table, and
 * without this each becomes a phantom transaction.
 */
function tableLines(lines: Line[]): Line[] {
  const header = firstHeaderIndex(lines);

  return lines.filter((line, index) => {
    if (isHeaderLine(line)) {
      return true;
    }
    return isAnchorLine(line) && (header < 0 || index > header);
  });
}

/**
 * Infer columns from the vertical whitespace that separates them.
 *
 * Every column of a statement table is divided from its neighbour by a gutter
 * that stays empty on every row, so accumulating the horizontal extent of all
 * table text and splitting on runs of emptiness recovers the columns directly.
 *
 * This is markedly more robust than comparing where text starts or merging
 * overlapping spans, both of which were tried first and failed on real files:
 *
 * - Start positions alone split a right-aligned amount from its own header,
 *   which can begin 36 points to its left.
 * - Merging overlapping spans bridges columns whenever a header label is wider
 *   than the column spacing. Federal packs columns 45 points apart with labels
 *   nearly that wide, collapsing `Withdrawals` and `Deposits` into one cell.
 *
 * Only header and dated rows take part. Wrapped narration lines and page
 * furniture would otherwise bridge gutters — ICICI's footer URL spans the gap
 * between the serial-number and date columns.
 */
export function inferBands(lines: Line[]): Band[] {
  const source = tableLines(lines);
  const items = (source.length ? source : lines).flatMap(line => line.items);

  if (!items.length) {
    return [];
  }

  const width = Math.ceil(Math.max(...items.map(item => item.right))) + MIN_GUTTER;
  const occupancy = new Uint32Array(width + 1);

  for (const item of items) {
    const from = Math.max(0, Math.floor(item.x));
    const to = Math.min(width, Math.ceil(Math.max(item.right, item.x + 1)));
    for (let x = from; x < to; x += 1) {
      occupancy[x] = (occupancy[x] ?? 0) + 1;
    }
  }

  const bands: Band[] = [];
  let x = 0;

  while (x < width) {
    if (!occupancy[x]) {
      x += 1;
      continue;
    }

    const left = x;
    let right = x;

    while (x < width) {
      if (occupancy[x]) {
        x += 1;
        right = x;
        continue;
      }

      // Bridge gaps too narrow to be a column separator.
      let gapEnd = x;
      while (gapEnd < width && !occupancy[gapEnd]) {
        gapEnd += 1;
      }
      if (gapEnd - x < MIN_GUTTER && gapEnd < width) {
        x = gapEnd;
        continue;
      }
      break;
    }

    bands.push({ left, right });
  }

  return bands;
}

/**
 * Assign an item to a column.
 *
 * Normally the band it overlaps most. When it overlaps none, it goes to the
 * first band starting at or after it, because a cell's text begins at the
 * cell's left edge, which sits left of the header label naming it — ICICI's
 * description cell starts at x=192 while its `Transaction Remarks` header
 * starts at x=247. Choosing the merely *nearest* band would instead drop a
 * short wrapped line such as `9f03689dd` (x=192..237) into the preceding
 * column, whose right edge is closer to it.
 */
function bandOf(item: { x: number; right: number }, bands: Band[]): number {
  let bestIndex = -1;
  let bestOverlap = 0;

  for (const [index, band] of bands.entries()) {
    const overlap =
      Math.min(item.right, band.right) - Math.max(item.x, band.left);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = index;
    }
  }

  if (bestIndex >= 0) {
    return bestIndex;
  }

  const toTheRight = bands.findIndex(band => band.left >= item.x);
  return toTheRight >= 0 ? toTheRight : Math.max(0, bands.length - 1);
}

/** Split one line into per-column fragments. */
function toFragments(
  line: Line,
  bands: Band[],
): Array<Fragment | undefined> {
  const fragments: Array<Fragment | undefined> = [];

  for (const item of line.items) {
    const column = bandOf(item, bands);
    const existing = fragments[column];
    fragments[column] = existing
      ? {
          text: `${existing.text} ${item.text}`,
          right: Math.max(existing.right, item.right),
        }
      : { text: item.text, right: item.right };
  }

  return fragments;
}

/**
 * The right-hand edge each column's text reaches, i.e. its wrap width.
 * Used to tell a wrapped line from a deliberate line break.
 */
function wrapWidths(rows: Array<Array<Fragment | undefined>>): number[] {
  const widths: number[] = [];

  for (const row of rows) {
    for (const [column, fragment] of row.entries()) {
      if (!fragment) {
        continue;
      }
      widths[column] = Math.max(widths[column] ?? 0, fragment.right);
    }
  }

  return widths;
}

/**
 * Join a cell's fragments back into one string.
 *
 * A fragment ending well short of its column's wrap width was a deliberate
 * line break, so the next fragment starts a new word and needs a space. One
 * that runs to the wrap width was broken mid-flow, where inserting a space
 * would corrupt a reference split across lines (`...837e576` + `b9cc0dd2ee`).
 *
 * Statement PDFs need this distinction: ICICI prints a short descriptor line
 * (`NACH trxn`) above each wrapped narration, and joining that without a
 * separator yields `NACH trxnACH/HDFC...`.
 *
 * A space lost at a wrap that happened to fall on a word boundary is not
 * recoverable from the PDF, so `FEDERAL BA` can come back as `FEDERALBA`.
 */
function joinFragments(fragments: Fragment[], wrapWidth: number): string {
  let text = '';
  let previous: Fragment | undefined;

  for (const fragment of fragments) {
    if (previous && previous.right < wrapWidth - SHORT_LINE_MARGIN) {
      text += ' ';
    }
    text += fragment.text;
    previous = fragment;
  }

  return text;
}

function mergeHeader(rows: Array<Array<Fragment | undefined>>): string[] {
  const merged: string[] = [];

  for (const row of rows) {
    for (const [column, fragment] of row.entries()) {
      if (!fragment) {
        continue;
      }
      merged[column] = merged[column]
        ? `${merged[column]} ${fragment.text}`
        : fragment.text;
    }
  }

  for (let index = 0; index < merged.length; index += 1) {
    merged[index] ??= '';
  }

  return merged;
}

export function assembleRows(lines: Line[], bands: Band[]): string[][] {
  const fragmentsFor = lines.map(line => toFragments(line, bands));
  const isAnchor = lines.map(isAnchorLine);
  const isHeader = lines.map(isHeaderLine);
  const widths = wrapWidths(fragmentsFor);

  const rows: string[][] = [];

  // Only the first run of header lines is used. Statement PDFs repeat the
  // header on every page, and merging all of them would produce labels like
  // "Balance (INR) Balance (INR) Balance (INR)".
  const firstHeader = isHeader.indexOf(true);
  if (firstHeader >= 0) {
    const group: Array<Array<Fragment | undefined>> = [];
    for (let index = firstHeader; index < lines.length; index += 1) {
      if (isAnchor[index]) {
        break;
      }
      if (isHeader[index]) {
        group.push(fragmentsFor[index] ?? []);
      }
    }
    rows.push(mergeHeader(group));
  }

  // Restricted to lines below the header for the same reason as in
  // `tableLines`: dates in the statement preamble are not transactions.
  const anchorIndexes = isAnchor
    .map((anchor, index) => (anchor ? index : -1))
    .filter(index => index >= 0 && (firstHeader < 0 || index > firstHeader));

  // Which transaction each continuation line belongs to. Lines left unowned
  // are discarded, which is what removes the statement preamble.
  const owner = new Map<number, number>();

  for (const [position, anchorIndex] of anchorIndexes.entries()) {
    const previousAnchor = anchorIndexes[position - 1];
    const start = previousAnchor === undefined ? 0 : previousAnchor + 1;
    const anchor = lines[anchorIndex];
    if (!anchor) {
      continue;
    }

    for (let index = start; index < anchorIndex; index += 1) {
      const line = lines[index];
      if (!line || isHeader[index] || isSummaryLine(line)) {
        continue;
      }

      const previous =
        previousAnchor === undefined ? undefined : lines[previousAnchor];
      const gap = line.y - anchor.y;

      // Requiring the same page, and a small *positive* gap, is what keeps a
      // page footer off the next page's first transaction: across a page
      // boundary y restarts, making the gap wildly negative and so trivially
      // "just above".
      if (line.page === anchor.page && gap >= 0 && gap <= ATTACH_ABOVE) {
        owner.set(index, anchorIndex);
      } else if (
        previousAnchor !== undefined &&
        previous &&
        previous.page === line.page &&
        previous.y - line.y <= MAX_CONTINUATION_BELOW
      ) {
        owner.set(index, previousAnchor);
      }
      // Otherwise it belongs to no transaction on this page — a preamble,
      // page header or footer — and is dropped.
    }
  }

  // Lines after the last anchor continue it, but only on its own page and
  // only while they are close enough to be part of its cell.
  const lastAnchor = anchorIndexes[anchorIndexes.length - 1];
  const lastAnchorLine =
    lastAnchor === undefined ? undefined : lines[lastAnchor];
  if (lastAnchor !== undefined && lastAnchorLine) {
    for (let index = lastAnchor + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (
        !isHeader[index] &&
        line &&
        !isSummaryLine(line) &&
        line.page === lastAnchorLine.page &&
        lastAnchorLine.y - line.y <= MAX_CONTINUATION_BELOW
      ) {
        owner.set(index, lastAnchor);
      }
    }
  }

  const continuations = new Map<number, number[]>();
  for (const [index, anchorIndex] of owner) {
    const list = continuations.get(anchorIndex) ?? [];
    list.push(index);
    continuations.set(anchorIndex, list);
  }

  for (const anchorIndex of anchorIndexes) {
    // Document order, so wrapped text reassembles in reading order.
    const lineIndexes = [
      anchorIndex,
      ...(continuations.get(anchorIndex) ?? []).filter(
        index => index !== anchorIndex,
      ),
    ].sort((a, b) => a - b);

    // Split by position relative to the anchor. ICICI prints a descriptor
    // above each row (`Debit trxn`, `NACH trxn`) that is *not* part of the
    // bank's narration — the source spreadsheet contains no occurrence of
    // "trxn" at all. Where such a line does carry real text, that text also
    // appears in the wrapped narration below. So below-anchor content wins,
    // and the line above is used only when there is nothing below it.
    const main = new Map<number, Fragment[]>();
    const above = new Map<number, Fragment[]>();

    for (const index of lineIndexes) {
      const target = index < anchorIndex ? above : main;
      for (const [column, fragment] of (fragmentsFor[index] ?? []).entries()) {
        if (!fragment) {
          continue;
        }
        const list = target.get(column) ?? [];
        list.push(fragment);
        target.set(column, list);
      }
    }

    const cells: string[] = [];
    for (const [column, fragments] of main) {
      cells[column] = joinFragments(fragments, widths[column] ?? 0);
    }
    for (const [column, fragments] of above) {
      if (!cells[column]) {
        cells[column] = joinFragments(fragments, widths[column] ?? 0);
      }
    }
    for (let index = 0; index < cells.length; index += 1) {
      cells[index] ??= '';
    }

    rows.push(cells);
  }

  return rows;
}

export async function extractPdf(
  path: string,
  options: PdfExtractOptions = {},
): Promise<Table> {
  const { lines, pages } = await readLines(path, options);
  const bands = inferBands(lines);

  return {
    rows: assembleRows(lines, bands),
    source: { path, format: 'pdf', part: `${pages} page(s)` },
  };
}
