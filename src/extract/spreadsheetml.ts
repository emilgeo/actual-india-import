import { readFile } from 'node:fs/promises';

import { XMLParser } from 'fast-xml-parser';

import type { Table } from './types.js';

/**
 * Excel 2003 XML (SpreadsheetML). Shape, once namespace prefixes are stripped:
 *
 *   <Workbook>
 *     <Worksheet Name="Sheet1">
 *       <Table>
 *         <Row>
 *           <Cell><Data Type="String">Date</Data></Cell>
 *           <Cell Index="3"><Data Type="Number">450.5</Data></Cell>
 *         </Row>
 *
 * `Index` is the load-bearing detail: it is a 1-based absolute column, emitted
 * when a run of cells is empty. Ignoring it silently shifts every following
 * value left, which reads amounts out of the wrong column — the kind of bug
 * that produces plausible numbers rather than an error.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Strips `ss:` from both tags and attributes, so `ss:Index` -> `@_Index`.
  removeNSPrefix: true,
  // Keep everything as text; the interpreter handles coercion.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;

function toArray(value: unknown): Node[] {
  if (value === undefined || value === null) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]) as Node[];
}

function dataText(cell: Node): string {
  const data = cell['Data'];

  if (data === undefined || data === null) {
    // Some writers put the value directly on the Cell.
    const direct = cell['#text'];
    return direct === undefined || direct === null ? '' : String(direct);
  }

  if (typeof data === 'object') {
    const text = (data as Node)['#text'];
    return text === undefined || text === null ? '' : String(text);
  }

  return String(data);
}

function rowsOf(table: Node): string[][] {
  const rows: string[][] = [];

  for (const row of toArray(table['Row'])) {
    const cells: string[] = [];

    for (const cell of toArray(row['Cell'])) {
      const index = Number.parseInt(String(cell['@_Index'] ?? ''), 10);
      if (Number.isFinite(index) && index >= 1) {
        // Pad out the columns this cell skipped over.
        while (cells.length < index - 1) {
          cells.push('');
        }
      }
      cells.push(dataText(cell).trim());
    }

    rows.push(cells);
  }

  return rows;
}

export function tableFromSpreadsheetMl(xml: string, path = 'inline'): Table {
  const parsed = parser.parse(xml) as Node;
  const workbook = (parsed['Workbook'] ?? parsed) as Node;

  let best: { rows: string[][]; name: string } | null = null;

  for (const worksheet of toArray(workbook['Worksheet'])) {
    const name = String(worksheet['@_Name'] ?? 'Sheet');
    for (const table of toArray(worksheet['Table'])) {
      const rows = rowsOf(table);
      if (!best || rows.length > best.rows.length) {
        best = { rows, name };
      }
    }
  }

  return {
    rows: best?.rows ?? [],
    source: {
      path,
      format: 'xlsx',
      part: best ? `${best.name} (SpreadsheetML)` : 'SpreadsheetML',
    },
  };
}

export async function extractSpreadsheetMl(path: string): Promise<Table> {
  const contents = await readFile(path, 'utf8');
  return tableFromSpreadsheetMl(contents, path);
}
