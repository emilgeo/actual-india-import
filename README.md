# actual-india-import

Convert Indian bank statements into [Actual Budget](https://actualbudget.org)
transactions, with **real merchant names instead of UPI reference strings**.

> **Status: early.** CSV input works. XLS/XLSX and PDF are not implemented yet.
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

npx tsx src/cli.ts statement.csv --stdout   # preview without writing
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
| `--force`                    | Write even if the balance check fails.                                                    |
| `--quiet`                    | Only report problems.                                                                     |

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

## Duplicate handling

When a narration contains a 12-digit UPI reference (UTR/RRN), it is emitted in
the `Reference` column. Via the future API path this becomes Actual's
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
- [ ] XLS/XLSX input (ICICI and others ship `.xls` by default)
- [ ] PDF input, including password-protected statements (Federal and others
      are PDF-only via mobile)
- [ ] Direct push via `@actual-app/api`, with `--dry-run`

## Limitations, honestly

- **PDF extraction will be the least reliable path.** Reconstructing a table
  from positioned text needs per-bank tuning and can break when a bank changes
  its template. The balance check is there to make such breakage loud rather
  than silent.
- **The merchant map is not authoritative.** Payment aggregators (Paytm,
  PhonePe, Razorpay) often mask the real merchant; the tool gives you a
  consistent payee, which is better than one per transaction, but not always
  the actual shop.
- **Notes carry the raw narration on the CSV path.** Actual's CSV field mapping
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
