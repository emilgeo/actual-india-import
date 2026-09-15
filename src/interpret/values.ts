/** Date component order, for the genuinely ambiguous cases like `01/02/2024`. */
export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function expandYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

function build(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  // Round-trip through Date to reject impossible days like 31 February.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Parse a statement date into `YYYY-MM-DD`.
 *
 * Handles `01/04/2024`, `01-04-24`, `01.04.2024`, `01-Apr-2024`, `1 Apr 24`,
 * `2024-04-01`, and any of those with a trailing time component.
 *
 * `order` only applies to all-numeric dates, where `01/02/2024` is genuinely
 * ambiguous. It defaults to day-first, which is the Indian convention.
 */
export function parseStatementDate(
  raw: string,
  order: DateOrder = 'dmy',
): string | null {
  const cleaned = raw.trim();
  if (!cleaned) {
    return null;
  }

  // Unambiguous ISO form, regardless of `order`.
  const iso = cleaned.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) {
    return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // Month-name form: `01-Apr-2024`, `1 April 24`.
  const named = cleaned.match(
    /^(\d{1,2})[\s\-/.]+([a-z]{3,})[\s\-/.]+(\d{2,4})/i,
  );
  if (named) {
    const month = MONTHS[(named[2] ?? '').slice(0, 3).toLowerCase()];
    if (month) {
      return build(expandYear(Number(named[3])), month, Number(named[1]));
    }
  }

  // All-numeric. Extra parts (a time component) are ignored.
  const parts = cleaned
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3) {
    return null;
  }

  const [first = 0, second = 0, third = 0] = parts;
  switch (order) {
    case 'ymd':
      return build(expandYear(first), second, third);
    case 'mdy':
      return build(expandYear(third), first, second);
    case 'dmy':
    default:
      return build(expandYear(third), second, first);
  }
}

/**
 * Parse an Indian statement amount into rupees.
 *
 * Handles lakh/crore grouping (`1,23,456.78`), currency prefixes (`₹`, `Rs.`,
 * `INR`), parenthesised negatives, Unicode minus, and `Dr`/`Cr` suffixes.
 *
 * Returns null for blanks and for cells with no digits (`-`, `NIL`), which is
 * how an empty side of a Withdrawal/Deposit pair is signalled.
 */
export function parseAmount(raw: string): number | null {
  let text = raw.trim();
  if (!text) {
    return null;
  }

  let negative = false;

  // `Dr`/`Cr` marker, which can sit either side of the number.
  const marker = text.match(/(^|\s)(dr|cr)\b\.?/i);
  if (marker) {
    negative = (marker[2] ?? '').toLowerCase() === 'dr';
    text = text.replace(marker[0], ' ');
  }

  text = text.replace(/−/g, '-').trim();

  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }

  if (/^\s*-/.test(text)) {
    negative = true;
  }

  // Strip currency markers before touching the number. This has to happen
  // first: the full stop in `Rs.` would otherwise survive the digit filter
  // below and be read as the decimal point, turning `Rs. 1,234.50` into 0.12.
  text = text.replace(/\b(inr|rs)\b\.?/gi, ' ').replace(/[₹$]/g, ' ');

  // Commas are always thousands/lakh separators in Indian statements; the
  // decimal marker is always `.`.
  let digits = text.replace(/[^0-9.]/g, '');
  if (!/\d/.test(digits)) {
    return null;
  }

  // If any separators remain, the last one is the decimal point and the rest
  // are grouping. Belt and braces for decorations we did not anticipate.
  const separators = digits.split('.');
  if (separators.length > 2) {
    const decimals = separators.pop() ?? '';
    digits = `${separators.join('')}.${decimals}`;
  }

  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value)) {
    return null;
  }

  return negative ? -value : value;
}
