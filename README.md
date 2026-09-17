# actual-india-import

Convert Indian bank statements into [Actual Budget](https://actualbudget.org)
transactions, with **real merchant names instead of UPI reference strings**.

CSV, Excel, HTML-disguised `.xls` and PDF input all work. Every amount is
cross-checked against the statement's own balance column.

## The problem this solves

Actual's CSV importer already handles Indian statements well: lakh grouping
(`1,23,456.78`), `DD/MM/YYYY` dates and separate Withdrawal/Deposit columns all
work, and it remembers your column mapping per account.

The gap is the narration column, which embeds a unique reference in every
transaction:

```
UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment
UPI/DR/419876543210/SWIGGY/YESB/swiggy@ybl/Payment
```

Map that to Payee and the same merchant becomes two payees. Within months you
have hundreds of junk payees, spending-by-payee is meaningless, and category
learning has nothing to work with.

This tool reads the structure inside the narration:

```
UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment
       reference      name         VPA
```

and produces something importable:

| Date       | Payee          | Notes                                                | Amount   |
| ---------- | -------------- | ---------------------------------------------------- | -------- |
| 2024-04-01 | Swiggy         | `UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment` | -450.50  |
| 2024-04-03 | ATM Withdrawal | `ATW/1234/CASH WDL/BANGALORE`                        | -2000.00 |
| 2024-04-04 | DMart          | `POS 1234XXXX5678 DMART BANGALORE`                   | -3250.75 |
| 2024-04-05 | John Doe       | `UPI/412345678903/JOHN DOE/johndoe@oksbi`            | 1500.00  |

The original narration is always preserved, never discarded.

## Install

Needs Node 22 or newer.

```bash
git clone https://github.com/emilgeo/actual-india-import.git
cd actual-india-import
npm install
```

## Usage

```bash
npx tsx src/cli.ts statement.csv          # writes statement.actual.csv
npx tsx src/cli.ts statement.pdf --stdout # preview without writing
```

Then import the generated CSV through Actual's **Import transactions** dialog,
mapping `Date`, `Payee`, `Notes` and `Amount`. Actual remembers that mapping per
account, so you only do it once. Leave `Reference` unmapped.

Or skip the CSV and [push straight into Actual](#pushing-straight-into-actual).

### Supported input

The format is detected by inspecting the file, not by its extension, because
banks routinely name an HTML table `.xls`.

| Actually is                         | Supported                     |
| ----------------------------------- | ----------------------------- |
| CSV / TSV (delimiter auto-detected) | yes                           |
| Excel `.xlsx` (OOXML)               | yes                           |
| HTML table named `.xls`             | yes                           |
| Excel 2003 XML (SpreadsheetML)      | yes                           |
| PDF, including password-protected   | yes                           |
| Legacy binary `.xls` (OLE2)         | no, re-save as `.xlsx` or CSV |

Columns are detected from the header row, using the synonyms Indian banks use
for the same seven fields (date, narration, debit, credit, amount, balance,
reference). Preamble and footer rows are skipped automatically.

### Options

| Option                       | Purpose                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `--out <path>`               | Where to write the CSV. Default `<input>.actual.csv`.                           |
| `--stdout`                   | Write to stdout instead of a file.                                              |
| `--date-order dmy\|mdy\|ymd` | Only affects all-numeric dates, where `01/02/2024` is ambiguous. Default `dmy`. |
| `--delimiter <char>`         | Force the CSV delimiter instead of detecting it.                                |
| `--merchants <path>`         | Your own merchant rules. See [below](#custom-merchant-rules).                   |
| `--env-file <path>`          | Read settings from this file instead of `./.env`.                               |
| `--push`                     | Send to Actual via its API instead of writing a CSV.                            |
| `--account <name\|id>`       | Which Actual account to import into. Required with `--push`.                    |
| `--dry-run`                  | With `--push`, report what would change without writing.                        |
| `--force`                    | Write even if the balance check fails.                                          |
| `--quiet`                    | Only report problems.                                                           |

### Settings

Passwords and server details come from a `.env` file in the current directory,
never from command-line flags, which would end up in your shell history.

```bash
cp .env.example .env
```

Real environment variables take precedence over the file, so a one-off override
works without editing it:

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

Needs the API package: `npm install @actual-app/api`.

```bash
# Always preview first.
npx tsx src/cli.ts statement.pdf --push --account "ICICI Savings" --dry-run
# [dry run] ICICI Savings: would add 34, would update 0.

npx tsx src/cli.ts statement.pdf --push --account "ICICI Savings"
```

`--dry-run` maps onto Actual's own preview mode, so nothing is written.

The API path does two things the CSV path cannot:

- Sets `imported_payee` to the raw narration, which is what Actual's payee
  matching learns from, while `payee_name` gets the cleaned merchant. The CSV
  field mapping has no `imported_payee` slot.
- Sets `imported_id` from the bank reference, making re-imports of overlapping
  date ranges idempotent.

### Review before you push

The tool reads its own output, so you can check and correct the CSV before
anything reaches your budget:

```bash
npx tsx src/cli.ts statement.pdf
$EDITOR statement.actual.csv
npx tsx src/cli.ts statement.actual.csv --push --account "ICICI Savings"
```

Payees you edited are kept verbatim; converted output is passed through, not
re-parsed. The `Reference` column survives, so deduplication still works.

One caveat: the CSV has no balance column, so a run over converted output
cannot re-verify the amounts and will say so. The check that matters already ran
when the CSV was produced.

## The balance check

Almost every Indian statement carries a running balance, which makes the parse
self-verifying: each transaction must equal the change in balance it caused. The
tool **refuses to write a statement that does not reconcile**:

```
Balance check FAILED (4/5 rows agree).
  1 of 5 rows do not agree with the balance column.
  2024-04-03 "ATW/1234/CASH WDL/BANGALORE": balance moved by -2000.00 but the parsed amount is -9000.00
Refusing to write a statement that does not reconcile. Re-run with --force to write it anyway.
```

This catches inverted debit and credit signs, dropped rows and misaligned
columns. Both date orders are scored, so newest-first exports work too. It
matters most for PDFs, where the table is reconstructed from the position of
each piece of text and so is inherently less certain.

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

Patterns match a lowercased, punctuation-stripped form of the VPA local-part or
merchant name, so write them without spaces or dots. Your rules take precedence
over the built-ins.

**Naming recurring mandates.** A NACH narration contains no name, only the
collecting bank and a mandate reference, followed by a sequence number that
changes every month. Those collections are grouped under the stable mandate
reference, for example `NACH ICIC0000000000000001`, so name each one once:

```json
[{ "pattern": "icic0000000000000001", "name": "Home Loan EMI" }]
```

**Truncated name fields.** Some banks cut each narration field to about ten
characters, so one counterparty can arrive as `Mr A N OTHE`, `A N OTHER` or
`OTHER` depending on the payment route. A rule per variant collapses them.

## Duplicate handling

A 12-digit UPI reference (UTR or RRN) found in the narration is emitted in the
`Reference` column, and becomes Actual's `imported_id` with `--push`.

References are deliberately conservative: only exactly-12-digit values are
accepted, and any value occurring more than once in a file is discarded. Account
and card numbers appear in narrations at other lengths and are not unique per
transaction, and a repeated `imported_id` makes Actual treat distinct
transactions as the same one and drop them. Where no reference is set, Actual's
own date and amount matching takes over.

## Getting statements out of your bank

Prefer internet banking over the mobile app. Bank apps often offer only PDF,
while the web portal usually offers XLS or CSV for the same account. CSV is the
most reliable input here and PDF the least, so use a spreadsheet if offered one.

## Limitations

- **PDF is the least reliable path.** Reconstructing a table from positioned
  text can break when a bank changes its template. The balance check exists to
  make that loud rather than silent.
- **Line breaks inside a PDF are ambiguous.** A wrap and a deliberate break are
  not always distinguishable, so a space can appear inside a long reference, or
  be lost between two words. Dates, amounts, payees and the deduplication
  reference do not depend on it.
- **The merchant map is not authoritative.** Payment aggregators often mask the
  real merchant. You get a consistent payee, which beats one per transaction,
  but not always the actual shop.
- **No automatic fetching, and there cannot be.** India's Account Aggregator
  framework requires FIU registration and a commercial contract, so a free
  always-on connector like Actual's European bank sync is not possible. This is
  a converter you run on a statement you downloaded.

## Contributing

Adding a bank usually means adding column synonyms or narration token shapes,
both small and contained. Narration strings are the most useful thing to
contribute: the description column only, with names, account numbers and
references replaced by realistic fakes.

No real statement data belongs in this repository. Fixtures are synthetic.

## Development

```bash
npm test
npm run typecheck
```

## License

MIT
