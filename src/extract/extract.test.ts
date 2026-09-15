import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';

import { interpretTable } from '../interpret/rows.js';

import { tableFromHtml } from './html-table.js';
import { detectFormat } from './sniff.js';
import { tableFromSpreadsheetMl } from './spreadsheetml.js';

import { extractTable } from './index.js';

const HEADER = [
  'Date',
  'Narration',
  'Chq./Ref.No.',
  'Withdrawal Amt.',
  'Deposit Amt.',
  'Closing Balance',
];

const DATA_ROWS = [
  [
    '01/04/24',
    'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment',
    '',
    '450.50',
    '',
    '1,23,456.78',
  ],
  ['02/04/24', 'SALARY ACME CONSULTING', '', '', '50,000.00', '1,73,456.78'],
];

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'aii-'));
});

describe('detectFormat', () => {
  it('identifies a real xlsx by its ZIP signature', () => {
    expect(detectFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(
      'xlsx',
    );
  });

  it('identifies legacy binary .xls by its OLE2 signature', () => {
    expect(
      detectFormat(
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      ),
    ).toBe('biff');
  });

  it('identifies an HTML table regardless of the .xls extension', () => {
    expect(detectFormat(Buffer.from('<html><body><table><tr><td>x'))).toBe(
      'html',
    );
  });

  it('identifies Excel 2003 XML', () => {
    expect(
      detectFormat(
        Buffer.from(
          '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">',
        ),
      ),
    ).toBe('spreadsheetml');
  });

  it('falls back to text for delimited data', () => {
    expect(
      detectFormat(Buffer.from('Date,Narration,Debit\n01/04/24,X,1.00')),
    ).toBe('text');
  });
});

describe('xlsx extraction', () => {
  it('reads a workbook and interprets it', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Statement');
    sheet.addRow(['HDFC BANK LTD']);
    sheet.addRow([]);
    sheet.addRow(HEADER);
    for (const row of DATA_ROWS) {
      sheet.addRow(row);
    }

    const path = join(workDir, 'statement.xlsx');
    await workbook.xlsx.writeFile(path);

    const { table, format } = await extractTable(path);
    expect(format).toBe('xlsx');

    const result = interpretTable(table);
    expect(result?.transactions).toHaveLength(2);
    expect(result?.transactions[0]).toMatchObject({
      date: '2024-04-01',
      amount: -450.5,
      payee: 'Swiggy',
    });
  });

  it('emits ISO for date-typed cells so they are not misread as day-first', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Statement');
    sheet.addRow(HEADER);
    // A real Date, as Excel would store it — 4 March, not 3 April.
    sheet.addRow([
      new Date(Date.UTC(2024, 2, 4)),
      'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment',
      '',
      '450.50',
      '',
      '1000.00',
    ]);

    const path = join(workDir, 'dates.xlsx');
    await workbook.xlsx.writeFile(path);

    const { table } = await extractTable(path);
    const result = interpretTable(table);

    expect(result?.transactions[0]?.date).toBe('2024-03-04');
  });
});

describe('HTML-table extraction', () => {
  const html = `
    <html><body>
      <table><tr><td>
        <table>
          <tr><th>Date</th><th>Narration</th><th>Chq./Ref.No.</th>
              <th>Withdrawal Amt.</th><th>Deposit Amt.</th><th>Closing Balance</th></tr>
          <tr><td>01/04/24</td><td>UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment</td>
              <td>&nbsp;</td><td>450.50</td><td>&nbsp;</td><td>1,23,456.78</td></tr>
          <tr><td>02/04/24</td><td>TATA &amp; SONS SALARY</td>
              <td>&nbsp;</td><td>&nbsp;</td><td>50,000.00</td><td>1,73,456.78</td></tr>
        </table>
      </td></tr></table>
    </body></html>`;

  it('picks the inner data table, not the layout wrapper', () => {
    const table = tableFromHtml(html);
    const result = interpretTable(table);

    expect(result?.transactions).toHaveLength(2);
    expect(result?.transactions[0]?.payee).toBe('Swiggy');
  });

  it('decodes entities so &nbsp; cells are genuinely empty', () => {
    const table = tableFromHtml(html);
    const result = interpretTable(table);

    // The salary row's withdrawal cell is `&nbsp;`. If it were not decoded it
    // would look populated and the amount would resolve as a debit.
    expect(result?.transactions[1]?.amount).toBe(50000);
    expect(result?.transactions[1]?.raw).toBe('TATA & SONS SALARY');
  });

  it('finds the data rows under layout tables carrying account details', () => {
    // A realistic bank export: account details in 3-cell rows wrapping the
    // real transaction table. The layout rows must not be mistaken for
    // transactions, and the nested rows must survive intact.
    const nested = `
      <table>
        <tr><td>Account Number</td><td>:</td><td>XXXXXXXX1234</td></tr>
        <tr><td>Account Holder</td><td>:</td><td>A N OTHER</td></tr>
        <tr><td>Branch</td><td>:</td><td>BANGALORE</td></tr>
        <tr><td>
          <table>
            <tr><th>Date</th><th>Narration</th><th>Withdrawal Amt.</th><th>Closing Balance</th></tr>
            <tr><td>01/04/24</td><td>UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment</td>
                <td>450.50</td><td>1000.00</td></tr>
          </table>
        </td></tr>
      </table>`;

    const result = interpretTable(tableFromHtml(nested));

    expect(result?.transactions).toHaveLength(1);
    expect(result?.transactions[0]?.payee).toBe('Swiggy');
  });

  it('expands colspan so later columns keep their index', () => {
    const table = tableFromHtml(
      '<table><tr><td colspan="3">Statement</td><td>X</td></tr></table>',
    );

    expect(table.rows[0]).toEqual(['Statement', '', '', 'X']);
  });

  it('routes an HTML file named .xls to the HTML parser', async () => {
    const path = join(workDir, 'disguised.xls');
    await writeFile(path, html, 'utf8');

    const { format, table } = await extractTable(path);

    expect(format).toBe('html');
    expect(interpretTable(table)?.transactions).toHaveLength(2);
  });
});

describe('SpreadsheetML extraction', () => {
  const xml = `<?xml version="1.0"?>
    <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
              xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
      <Worksheet ss:Name="Statement">
        <Table>
          <Row>
            <Cell><Data ss:Type="String">Date</Data></Cell>
            <Cell><Data ss:Type="String">Narration</Data></Cell>
            <Cell><Data ss:Type="String">Withdrawal Amt.</Data></Cell>
            <Cell><Data ss:Type="String">Deposit Amt.</Data></Cell>
            <Cell><Data ss:Type="String">Closing Balance</Data></Cell>
          </Row>
          <Row>
            <Cell><Data ss:Type="String">01/04/24</Data></Cell>
            <Cell><Data ss:Type="String">UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment</Data></Cell>
            <Cell><Data ss:Type="Number">450.50</Data></Cell>
            <Cell ss:Index="5"><Data ss:Type="Number">123456.78</Data></Cell>
          </Row>
        </Table>
      </Worksheet>
    </Workbook>`;

  it('honours ss:Index so skipped cells do not shift columns', () => {
    const table = tableFromSpreadsheetMl(xml);

    // The deposit column is skipped, so the balance must land in column 5.
    expect(table.rows[1]).toEqual([
      '01/04/24',
      'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment',
      '450.50',
      '',
      '123456.78',
    ]);
  });

  it('interprets to the right amount and balance', () => {
    const result = interpretTable(tableFromSpreadsheetMl(xml));

    expect(result?.transactions[0]).toMatchObject({
      date: '2024-04-01',
      amount: -450.5,
      balance: 123456.78,
      payee: 'Swiggy',
    });
  });
});

describe('legacy binary .xls', () => {
  it('refuses with instructions rather than failing obscurely', async () => {
    const path = join(workDir, 'legacy.xls');
    await writeFile(
      path,
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
    );

    await expect(extractTable(path)).rejects.toThrow(/Save As/i);
  });
});
