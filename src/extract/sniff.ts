/**
 * What a file actually is, as opposed to what its extension claims.
 *
 * This distinction is not pedantry for Indian bank statements: a file named
 * `.xls` is very often an HTML table or a SpreadsheetML document rather than a
 * real Excel workbook, because that is the cheapest thing for a bank's
 * reporting layer to emit. Trusting the extension gets you a parser error on a
 * perfectly readable file.
 */
export type DetectedFormat =
  | 'xlsx' // Real OOXML workbook (a ZIP container).
  | 'html' // HTML `<table>` wearing an .xls extension.
  | 'spreadsheetml' // Excel 2003 XML.
  | 'biff' // Legacy binary .xls (OLE2 compound document).
  | 'text'; // CSV/TSV or anything else line-oriented.

/** OOXML/ZIP: `PK\x03\x04`. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** OLE2 compound document, used by legacy .xls and .doc. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWithBytes(buffer: Buffer, magic: number[]): boolean {
  if (buffer.length < magic.length) {
    return false;
  }
  return magic.every((byte, index) => buffer[index] === byte);
}

export function detectFormat(buffer: Buffer): DetectedFormat {
  if (startsWithBytes(buffer, ZIP_MAGIC)) {
    return 'xlsx';
  }
  if (startsWithBytes(buffer, OLE2_MAGIC)) {
    return 'biff';
  }

  // Only the head matters, and only as text. A binary file decoded this way
  // produces junk that matches none of the patterns below, which is fine.
  const head = buffer.subarray(0, 4096).toString('utf8').toLowerCase();

  // Excel 2003 XML declares this namespace. Checked before the HTML test
  // because such files can also contain table-ish markup.
  if (
    head.includes('urn:schemas-microsoft-com:office:spreadsheet') ||
    /<workbook[\s>]/.test(head)
  ) {
    return 'spreadsheetml';
  }

  if (
    /<table[\s>]/.test(head) ||
    /<html[\s>]/.test(head) ||
    head.includes('<!doctype html')
  ) {
    return 'html';
  }

  return 'text';
}

export function describeFormat(format: DetectedFormat): string {
  switch (format) {
    case 'xlsx':
      return 'Excel workbook (xlsx)';
    case 'html':
      return 'HTML table (a .xls file that is really HTML)';
    case 'spreadsheetml':
      return 'Excel 2003 XML (SpreadsheetML)';
    case 'biff':
      return 'legacy binary Excel (.xls, OLE2)';
    case 'text':
      return 'delimited text';
    default:
      return format;
  }
}
