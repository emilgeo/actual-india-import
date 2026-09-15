import ExcelJS from 'exceljs';

import type { Table } from './types.js';

/**
 * Render a cell as the text a human would see.
 *
 * Dates are the reason this exists: a date-formatted cell comes back as a
 * `Date`, and stringifying it naively yields a locale-dependent form that the
 * day-first date parser would then misread. Emitting ISO makes it unambiguous.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'object') {
    // Formula cells carry their computed result; hyperlinks and rich text
    // carry display text.
    if ('result' in value && value.result !== undefined) {
      return cellText(value.result as ExcelJS.CellValue);
    }
    if ('text' in value && value.text !== undefined) {
      return String(value.text);
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map(part => part.text).join('');
    }
    if ('hyperlink' in value) {
      return '';
    }
    return '';
  }

  return String(value);
}

export async function extractXlsx(path: string): Promise<Table> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);

  // Statement workbooks occasionally carry a cover or summary sheet, so the
  // densest sheet is a better bet than the first one.
  let best: { rows: string[][]; name: string } | null = null;

  for (const worksheet of workbook.worksheets) {
    const rows: string[][] = [];

    worksheet.eachRow({ includeEmpty: true }, row => {
      const cells: string[] = [];
      // `row.cellCount` counts to the last populated cell, which is what keeps
      // column indexes aligned with the header.
      for (let column = 1; column <= row.cellCount; column += 1) {
        cells.push(cellText(row.getCell(column).value).trim());
      }
      rows.push(cells);
    });

    if (!best || rows.length > best.rows.length) {
      best = { rows, name: worksheet.name };
    }
  }

  if (!best) {
    return { rows: [], source: { path, format: 'xlsx' } };
  }

  return {
    rows: best.rows,
    source: { path, format: 'xlsx', part: best.name },
  };
}
