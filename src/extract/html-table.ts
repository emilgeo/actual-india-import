import { readFile } from 'node:fs/promises';

import { parse } from 'node-html-parser';
import type { HTMLElement } from 'node-html-parser';

import type { Table } from './types.js';

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

/**
 * Bank exports lean on `&nbsp;` for empty cells and `&amp;` in merchant names,
 * and an undecoded `&nbsp;` is not whitespace — it would survive a `.trim()`
 * and make an empty cell look populated.
 */
function decodeEntities(value: string): string {
  return value
    .replace(
      /&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#39;/g,
      match => ENTITIES[match] ?? match,
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function cellsOf(row: HTMLElement): string[] {
  const cells: string[] = [];

  for (const node of row.childNodes) {
    const element = node as HTMLElement;
    const tag = element.tagName?.toUpperCase();
    if (tag !== 'TD' && tag !== 'TH') {
      continue;
    }

    const text = decodeEntities(element.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    cells.push(text);

    // Expand colspan so later columns keep their index. Without this a
    // merged header cell shifts every column after it by one, and amounts get
    // read out of the wrong column.
    const span = Number.parseInt(element.getAttribute('colspan') ?? '1', 10);
    for (
      let extra = 1;
      extra < (Number.isFinite(span) ? span : 1);
      extra += 1
    ) {
      cells.push('');
    }
  }

  return cells;
}

function rowsOf(table: HTMLElement): string[][] {
  return table.querySelectorAll('tr').map(cellsOf);
}

/** Rows with enough populated cells to plausibly be transaction data. */
function density(rows: string[][]): number {
  return rows.filter(row => row.filter(cell => cell.trim()).length >= 3).length;
}

export function tableFromHtml(html: string, path = 'inline'): Table {
  const root = parse(html);

  // Bank exports nest the data table inside layout tables. No special handling
  // is needed for that: `querySelectorAll('tr')` walks descendants, so an
  // outer table's row list already contains the inner table's rows, each
  // parsed from its own cells. Picking the table with the most dense rows
  // therefore lands on a row set containing the real data, and the surrounding
  // layout rows are dropped later by requiring a parseable date and amount.
  const candidates = root.querySelectorAll('table');

  let best: string[][] = [];
  let bestDensity = -1;

  for (const candidate of candidates) {
    const rows = rowsOf(candidate);
    const score = density(rows);
    if (score > bestDensity) {
      bestDensity = score;
      best = rows;
    }
  }

  return { rows: best, source: { path, format: 'xlsx', part: 'html-table' } };
}

export async function extractHtmlTable(path: string): Promise<Table> {
  const contents = await readFile(path, 'utf8');
  return tableFromHtml(contents, path);
}
