# actual-india-import

Convert Indian bank statements into [Actual Budget](https://actualbudget.org)
transactions, with **real merchant names instead of UPI reference strings**.

> **Status: early.** CSV, Excel, HTML-disguised `.xls` and PDF input all work.
> Verified end to end against real ICICI and Federal Bank statements, with
> every amount cross-checked against the statement's own balance column.
> See [Roadmap](#roadmap).

## The problem this solves

Actual's CSV importer already handles Indian statements better than you might
expect — lakh grouping (`1,23,456.78`), `DD/MM/YYYY` dates, and separate
Withdrawal/Deposit columns all work, and it remembers your column mapping per
account. That is not the gap.

The gap is the narration column. Indian bank narrations embed a unique
reference in every single transaction:

```
UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment
UPI/DR/419876543210/SWIGGY/YESB/swiggy@ybl/Payment
```

Map that column to Payee and you get two different payees for the same
merchant. After a few months you have hundreds of junk payees, spending-by-payee
is meaningless, and category learning has nothing to learn from.

This tool reads the structure hiding in those narrations:

```
UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment
       └─ reference ─┘  └name┘      └─ VPA ─┘
```

and turns the statement into something importable:

| Date       | Payee          | Notes                                                | Amount   |
| ---------- | -------------- | ---------------------------------------------------- | -------- |
| 2024-04-01 | Swiggy         | `UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment` | -450.50  |
| 2024-04-03 | ATM Withdrawal | `ATW/1234/CASH WDL/BANGALORE`                        | -2000.00 |
| 2024-04-04 | DMart          | `POS 1234XXXX5678 DMART BANGALORE`                   | -3250.75 |
| 2024-04-05 | John Doe       | `UPI/412345678903/JOHN DOE/johndoe@oksbi`            | 1500.00  |

The original narration is always preserved, never discarded.

## Install

```bash
git clone https://github.com/emilgeo/actual-india-import.git
cd actual-india-import
npm install
```

## Usage

```bash
npx tsx src/cli.ts statement.csv
# writes statement.actual.csv next to the input

npx tsx src/cli.ts statement.xls --stdout   # preview without writing
```

### Supported input

The format is detected by **inspecting the file**

| Actually is                         | Supported                         |
| ----------------------------------- | --------------------------------- |
| CSV / TSV (delimiter auto-detected) | yes                               |
| Excel `.xlsx` (OOXML)               | yes                               |
| HTML table named `.xls`             | yes                               |
| Excel 2003 XML (SpreadsheetML)      | yes                               |
| PDF (including password-protected)  | yes                               |
| Legacy binary `.xls` (OLE2)         | no — re-save as `.xlsx` or `.csv` |

**Note for ICICI:** the `.xls` the app gives you is legacy binary Excel, which
is the one format not supported. Use the PDF instead — it works directly.

**Note for Federal Bank:** statements are PDF-only from the app and are
password-protected. Put the password in your `.env` as `STATEMENT_PASSWORD`
(see [Settings](#settings)).

```
Read statement.xls as HTML table (a .xls file that is really HTML)
Header on row 3; columns: date=0, description=1, debit=2, credit=3, balance=4
```

Then import the generated CSV through Actual's normal
**Import transactions** dialog, mapping `Date`, `Payee`, `Notes` and `Amount`.
Actual remembers that mapping per account, so you only do it once.

### Options

| Option                       | Purpose                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `--out <path>`               | Where to write the CSV. Default `<input>.actual.csv`.                                     |
| `--stdout`                   | Write to stdout instead of a file.                                                        |
| `--date-order dmy\|mdy\|ymd` | Only affects all-numeric dates, where `01/02/2024` is genuinely ambiguous. Default `dmy`. |
| `--delimiter <char>`         | Force the CSV delimiter instead of detecting it.                                          |
| `--merchants <path>`         | Your own merchant rules (see below).                                                      |
| `--env-file <path>`          | Read settings from this file instead of `./.env`.                                         |
| `--force`                    | Write even if the balance check fails.                                                    |
| `--quiet`                    | Only report problems.                                                                     |

### Settings

Passwords and server details are read from a `.env` file in the current
directory, never from command-line flags — a flag ends up in your shell history
and in process listings.

```bash
cp .env.example .env
$EDITOR .env
```

Real environment variables take precedence over the file, so a one-off override
still works without editing it, and CI can inject secrets with no file present:

```bash
ACTUAL_SYNC_ID=other-budget npx tsx src/cli.ts statement.pdf --push --account Savings
```

| Setting                      | Purpose                                               |
| ---------------------------- | ----------------------------------------------------- |
| `STATEMENT_PASSWORD`         | Password on an encrypted statement PDF.               |
| `ACTUAL_SERVER_URL`          | Your Actual sync server.                              |
| `ACTUAL_PASSWORD`            | Password for that server. Not the statement password. |
| `ACTUAL_SYNC_ID`             | Budget to import into: Settings > Advanced > Sync ID. |
| `ACTUAL_ENCRYPTION_PASSWORD` | Only for end-to-end encrypted budgets.                |
| `ACTUAL_DATA_DIR`            | Local budget cache. Default `./.actual-cache`.        |

None of this is needed to convert a statement to CSV, unencrypted PDFs
included.

## Pushing straight into Actual

Instead of writing a CSV, the tool can send transactions to Actual directly.
This needs the API package:

```bash
npm install @actual-app/api
```

Set `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD` and `ACTUAL_SYNC_ID` in your `.env`
(see [Settings](#settings)), then:

```bash
# Always preview first:
npx tsx src/cli.ts statement.xls --push --account "ICICI Savings" --dry-run
# [dry run] ICICI Savings: would add 34, would update 0.

npx tsx src/cli.ts statement.xls --push --account "ICICI Savings"
```

`--dry-run` maps onto Actual's own preview mode, so nothing is written.

The API path is better than the CSV path in two ways:

- **`imported_payee` is set properly.** The cleaned merchant goes to
  `payee_name` and the original narration to both `imported_payee` and `notes`.
  The CSV path can only fill Notes, because Actual's CSV field mapping has no
  `imported_payee` slot — and that field is what Actual's payee matching
  learns from.
- **`imported_id` enables real deduplication**, so re-importing an overlapping
  date range does not create duplicates.

It also passes `payeeNameNormalization: 'original'`. Actual title-cases
imported payees by default, and that lowercases first — which would turn
`DMart` into `Dmart` and `HDFC Mutual Fund SIP` into `Hdfc Mutual Fund Sip`,
undoing the naming work.

## The balance check

Almost every Indian statement carries a running balance column, which makes the
parse self-verifying: each transaction must equal the change in balance it
caused. The tool checks every row and **refuses to write a statement that does
not reconcile**:

```
Balance check FAILED (4/5 rows agree).
  1 of 5 rows do not agree with the balance column.
  2024-04-03 "ATW/1234/CASH WDL/BANGALORE": balance moved by -2000.00 but the parsed amount is -9000.00
Refusing to write a statement that does not reconcile. Re-run with --force to write it anyway.
```

This catches inverted debit/credit signs, dropped rows and misaligned columns —
the exact ways statement parsing goes wrong. It matters most for PDFs, where
extraction is inherently less certain. Statements are also checked in both date
orders, so newest-first exports are handled.

## PDF statements

PDF tables are reconstructed from the position of each piece of text, which is
harder than it sounds and is why the balance check matters most here. Handled:

- **Headers split across several lines.** ICICI prints `Transaction Date` as
  `Transaction` on one baseline and `Date` on the next, and
  `Withdrawal Amount (INR)` across three.
- **Column detection from whitespace.** Columns are found by accumulating the
  horizontal extent of all table text and splitting on the gutters that stay
  empty on every row. Two simpler approaches were tried first and both failed
  on real files: comparing where text starts splits a right-aligned amount
  from its own header (which can begin 36 points to its left), and merging
  overlapping spans bridges columns whenever a header label is wider than the
  column spacing (Federal packs columns 45 points apart with labels nearly
  that wide, collapsing `Withdrawals` and `Deposits` into one cell).
- **Narrations wrapped over several lines**, reassembled in reading order.
- **Descriptor lines.** ICICI prints a label above each row (`NACH trxn`,
  `Debit trxn`) that is not part of the bank's narration — the source
  spreadsheet contains no occurrence of "trxn" — so it is dropped.
- **Page headers and footers**, which otherwise fold into the nearest
  transaction. One toll-free number landed inside an amount before this was
  fixed; the balance check caught it.
- **Summary rows.** `GRAND TOTAL` and `Opening Balance` carry no date, so they
  would attach to the nearest transaction — a grand total's column sums
  landing in an amount field.
- **Dates in the preamble.** Federal prints `Account Open Date : 25/03/2013`
  above the table, so transactions are only read from below the header row.

For an encrypted PDF, put the password in your `.env` as
`STATEMENT_PASSWORD` (see [Settings](#settings)) so it stays out of your shell
history, then run the tool normally:

```bash
npx tsx src/cli.ts statement.pdf
```

### Known limitation

Whether a line break was a word wrap or a deliberate break cannot always be
decided from a PDF, so a space is occasionally introduced inside a long
reference, or lost between two words (`FEDERAL BA` becoming `FEDERALBA`). This
is cosmetic: dates, amounts, payees and the deduplication reference are all
derived from fields that do not depend on it, and amounts are independently
checked against the balance column.

## Custom merchant rules

The built-in map covers common Indian merchants. Add your own in JSON:

```json
[
  { "pattern": "^mylocalkirana", "name": "Kirana Store" },
  { "pattern": "^acmecorp", "name": "Acme Payroll" }
]
```

```bash
npx tsx src/cli.ts statement.csv --merchants my-merchants.json
```

Patterns are matched against a lowercased, punctuation-stripped form of the VPA
local-part or merchant name, so write them without spaces or dots. Your rules
take precedence over the built-ins.

**Naming recurring mandates.** A NACH narration contains no name — only the
collecting bank and a mandate reference, followed by a sequence number that
changes every month. Those collections are grouped under the stable mandate
reference, e.g. `NACH ICIC0000000000000001`, so give each one a real name once:

```json
[{ "pattern": "icic0000000000000001", "name": "Home Loan EMI" }]
```

**Indian bank quirk worth knowing.** ICICI truncates each narration field to
about ten characters, so the same counterparty can arrive as `Mr A N OTHE`,
`A N OTHER` or `OTHER` depending on the payment route. A rule per variant
collapses them.

## Duplicate handling

When a narration contains a 12-digit UPI reference (UTR/RRN), it is emitted in
the `Reference` column. With `--push` this becomes Actual’s
`imported_id`, making re-imports of overlapping date ranges genuinely
idempotent.

References are deliberately conservative:

- Only exactly-12-digit values are accepted. Account and card numbers also
  appear in narrations at other lengths and are **not** unique per transaction.
- Any reference that occurs more than once in a file is discarded, since a real
  bank reference cannot repeat.

This matters because a non-unique `imported_id` makes Actual treat distinct
transactions as the same one and silently drop them — worse than having no
reference, where Actual's own date-and-amount matching takes over.

## Getting statements out of your bank

**Prefer internet banking over the mobile app.** Bank apps often only offer
PDF, while the web portal usually offers XLS or CSV for the same account. CSV
is by far the most reliable input here, and PDF the least — if the web portal
gives you a spreadsheet, use it.

## Roadmap

- [x] CSV/TSV input, generic column detection, balance validation
- [x] UPI/NEFT/IMPS/POS/ACH/ATM narration parsing
- [x] Excel `.xlsx`, HTML tables named `.xls`, and Excel 2003 XML
- [ ] Legacy binary `.xls` (OLE2) — currently refused with instructions to
      re-save; no maintained permissive Node reader exists for it
- [x] PDF input, including password-protected statements
- [x] Direct push via `@actual-app/api`, with `--dry-run`

## Limitations, honestly

- **PDF extraction will be the least reliable path.** Reconstructing a table
  from positioned text needs per-bank tuning and can break when a bank changes
  its template. The balance check is there to make such breakage loud rather
  than silent.
- **The merchant map is not authoritative.** Payment aggregators (Paytm,
  PhonePe, Razorpay) often mask the real merchant; the tool gives you a
  consistent payee, which is better than one per transaction, but not always
  the actual shop.
- **Notes carry the raw narration on the CSV path.** Actual’s CSV field mapping
  has no `imported_payee` slot, so the original goes into Notes. The API path
  will set `imported_payee` properly.
- **No automatic fetching, and there cannot be.** India's Account Aggregator
  framework requires FIU registration and a commercial contract, so a free
  always-on connector like Actual's European bank sync is not possible. This is
  a converter you run on a statement you downloaded.

## Contributing

Adding a bank usually means adding column synonyms or narration token shapes —
both small, contained changes. Real narration strings are the most useful thing
to contribute (the description column alone; no amounts or account numbers
needed).

## Development

```bash
npm test          # vitest
npm run typecheck
```

No real statement data is committed to this repository; all fixtures are
synthetic.

## License

MIT
