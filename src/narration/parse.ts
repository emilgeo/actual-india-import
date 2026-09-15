import { lookupMerchant, lookupPosting } from './merchants.js';
import type { MerchantRule } from './merchants.js';
import type { NarrationKind, ParsedNarration } from './types.js';

/**
 * A VPA as it appears as a standalone token, e.g. `swiggy@ybl`,
 * `paytm-9876@paytm`, `9876543210@ybl`.
 *
 * Deliberately anchored and applied per token rather than searched across the
 * whole narration: `-` is legal inside a VPA local-part, so an unanchored
 * search over `UPI-SWIGGY-swiggy@ybl-...` would happily match
 * `SWIGGY-swiggy@ybl` and pollute the merchant name.
 */
const VPA_TOKEN = /^[a-z0-9][a-z0-9._-]*@[a-z][a-z0-9]+$/i;

/** UPI UTR / RRN. Exactly 12 digits — see `extractRef` for why not 9-16. */
const UTR_TOKEN = /^\d{12}$/;

/** IFSC, e.g. `HDFC0001234`. Routing detail, never a payee. */
const IFSC_TOKEN = /^[A-Z]{4}0[A-Z0-9]{6}$/i;

/**
 * A NACH/ACH mandate reference: a four-letter bank code followed by a long
 * digit run, e.g. `ICIC0000000000000001`.
 *
 * Stable for the life of the mandate, unlike the per-collection sequence
 * number printed beside it, which makes it the only usable payee identity for
 * recurring debits such as loan EMIs and mutual-fund SIPs.
 */
const MANDATE_TOKEN = /^[a-z]{4}\d{8,}$/i;

/** Masked card/account numbers, e.g. `1234XXXX5678`, `XXXXXXXX1234`. */
const MASKED_TOKEN = /^[\dX*]+$/i;

/**
 * Route markers, directions and filler. These carry no payee information but
 * survive tokenisation, so they must be excluded from merchant candidates.
 */
const NOISE_TOKENS = new Set([
  'dr',
  'cr',
  'db',
  'p2a',
  'p2m',
  'p2p',
  'payment',
  'pymt',
  'pay',
  'na',
  'nil',
  'null',
  'upi',
  'neft',
  'imps',
  'rtgs',
  'pos',
  'ach',
  'atw',
  'nwd',
  'atm',
  // ICICI's code for a card autopay debit, e.g. `ATD/Auto Debit CC0xx0000`.
  'atd',
  // Federal's channel codes: `UPIOUT/...`, `MB FTO/...`, `FT IMPS/IFI/...`.
  'upiout',
  'upiin',
  'fto',
  'fti',
  'ft',
  'ifi',
  'impstxn',
  'nre',
  'nro',
  'mmt',
  'ecs',
  'nach',
  'si',
  'ecom',
  'vps',
  'inft',
  'txn',
  'trf',
  'transfer',
  'ref',
  'refno',
  'sent',
  'received',
  'paid',
  'collect',
  'inb',
  'ib',
  'mob',
  'mb',
  'self',
  'other',
  'others',
  'misc',
  'chq',
  'cheque',
  'cash',
  'wdl',
  'to',
  'from',
  'by',
  'via',
]);

/**
 * Bank short codes that appear as their own token in UPI narrations to
 * identify the counterparty's bank. Not payees.
 */
const BANK_CODES = new Set([
  'hdfc',
  'icic',
  'ici',
  'sbin',
  'sbi',
  'utib',
  'axis',
  'fdrl',
  'yesb',
  'yes',
  'ybl',
  'kkbk',
  'kotak',
  'punb',
  'pnb',
  'barb',
  'bob',
  'cnrb',
  'canara',
  'idib',
  'ioba',
  'ubin',
  'mahb',
  'indb',
  'idfb',
  'ratn',
  'aubl',
  'bkid',
  'cbin',
  'dbss',
  'hsbc',
  'scbl',
  'citi',
  'okhdfcbank',
  'okicici',
  'oksbi',
  'okaxis',
  'apl',
  'ptyes',
  'ptsbi',
  'ptaxis',
  'pytm',
  'ibl',
  'axl',
  'jupiteraxis',
  'waaxis',
  'airp',
  'jio',
]);

/**
 * Noise that a fixed word list cannot cover, because banks truncate fields to
 * a fixed width and spell bank names out in full.
 *
 * ICICI cuts every narration field to about ten characters, so `Payment from`
 * arrives as `Payment fr` and `Pay request` as `Pay reques` — prefixes, not
 * whole words. It also names the counterparty's bank in words (`State Bank`,
 * `FEDERAL BA`, `IDFC FIRST`, `HDFC BANK LTD`), and those would otherwise
 * compete with the actual payee for the longest-name-wins rule.
 */
const NOISE_PATTERNS: RegExp[] = [
  // Truncated descriptors.
  /^payment/,
  /^payreq/,
  /^paymentfr/,
  /^debittrxn$/,
  /^credittrxn$/,
  /^autodebit/,
  /^(debit|credit|trxn|txnno)$/,
  /^collectfr/,
  /^fundtransf/,
  // Bank names, including ICICI's truncated forms. Anchored deliberately: a
  // bare /^hdfc/ would also reject `HDFC MUTUAL FUND SIP`, which is a real
  // payee. Only a token that is *entirely* a bank name counts as noise.
  /^[a-z]{3,}bank(ltd|limited)?$/,
  /^federalba(nk)?$/,
  /^idfcfirst$/,
  /^axisbank$/,
  /^yesbank(ltd)?$/,
  /^unionofindia$/,
  /^punjabnational$/,
];

/**
 * Words to leave in upper case when building a display name. Bank codes are
 * included because they legitimately appear in payee names for mutual funds
 * and standing instructions (`HDFC MUTUAL FUND SIP`).
 */
const KNOWN_ACRONYMS = new Set([
  ...BANK_CODES,
  'ikea',
  'bsnl',
  'irctc',
  'nhai',
  'sip',
  'emi',
  'gst',
  'tds',
  'nach',
  'fastag',
]);

const KIND_MARKERS: Array<[RegExp, NarrationKind]> = [
  // `UPIOUT`/`UPIIN` are Federal's directional forms of the UPI marker.
  [/^upi(out|in)?$/i, 'upi'],
  [/^neft$/i, 'neft'],
  [/^(imps|mmt|inft)$/i, 'imps'],
  [/^rtgs$/i, 'rtgs'],
  [/^(pos|ecom|vps|vin)$/i, 'pos'],
  [/^(ach|nach|ecs|si)$/i, 'ach'],
  [/^(atw|nwd|atm|awb|cwdr)$/i, 'atm'],
];

type Tokenized = {
  tokens: string[];
  /**
   * True when the narration had no `/` or `-` structure and we fell back to
   * splitting on whitespace. Multi-word merchant names only survive in this
   * mode, so phrase grouping is enabled for it alone.
   */
  phraseMode: boolean;
};

/**
 * Banks delimit narrations with either `/` (HDFC, SBI) or `-` (ICICI), and
 * some use neither. Pick whichever split yields more fields.
 */
function tokenize(raw: string): Tokenized {
  const split = (by: string) =>
    raw
      .split(by)
      .map(token => token.trim())
      .filter(Boolean);

  const bySlash = split('/');
  const byDash = split('-');
  const delimited = bySlash.length >= byDash.length ? bySlash : byDash;

  if (delimited.length > 1) {
    return { tokens: delimited, phraseMode: false };
  }

  return {
    tokens: raw.split(/\s+/).filter(Boolean),
    phraseMode: true,
  };
}

/** Tokens split down to whitespace, for shape matching. */
function subTokens(tokens: string[]): string[] {
  return tokens.flatMap(token => token.split(/\s+/)).filter(Boolean);
}

function detectKind(tokens: string[]): NarrationKind {
  // Scan the words of the first two tokens: banks prefix the route with a
  // channel marker, sometimes in the same field — `MMT/IMPS/...` but also
  // Federal's `FT IMPS/IFI/...`, where the marker is the second word.
  for (const token of subTokens(tokens.slice(0, 2))) {
    for (const [marker, kind] of KIND_MARKERS) {
      if (marker.test(token)) {
        return kind;
      }
    }
  }
  return 'other';
}

function extractVpa(tokens: string[]): string | undefined {
  return subTokens(tokens).find(token => VPA_TOKEN.test(token));
}

/**
 * Extract the bank reference, but only when it is safe to use as Actual's
 * `imported_id`.
 *
 * Restricted to exactly 12 digits (the UPI UTR/RRN format) rather than a
 * looser 9-16 range, because account numbers and card numbers also appear in
 * narrations at those lengths and are *not* unique per transaction. A repeated
 * `imported_id` would make Actual treat distinct transactions as the same one
 * and silently drop them — far worse than having no id, where Actual's
 * date+amount fuzzy matching takes over.
 */
function extractRef(tokens: string[]): string | undefined {
  return subTokens(tokens).find(token => UTR_TOKEN.test(token));
}

function letterCount(value: string): number {
  return (value.match(/[a-z]/gi) ?? []).length;
}

/** Could this token name a payee? */
/**
 * Is this an opaque machine reference rather than a name?
 *
 * ICICI appends a long provider reference after the UTR, e.g.
 * `SBI1aa2bb3cc4dd5ee6ff7aa8bb9cc0dd1ee` or `ICIC0000000000000001`. These carry
 * ~20 letters, so a "longest run of letters wins" rule would happily pick one
 * as the payee. Mixing letters and digits over this length is not something a
 * merchant name does.
 */
function isOpaqueReference(bare: string): boolean {
  // Eight characters rather than twelve: PDF extraction can break a long
  // reference across lines, leaving a short tail such as `b9cc0dd2ee` that
  // would otherwise qualify as a name. Requiring both letters and digits keeps
  // real names safe, since names do not contain digits.
  return bare.length >= 8 && /\d/.test(bare) && /[a-z]/.test(bare);
}

function isMerchantCandidate(token: string): boolean {
  const bare = token.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (!bare || NOISE_TOKENS.has(bare) || BANK_CODES.has(bare)) {
    return false;
  }
  if (NOISE_PATTERNS.some(pattern => pattern.test(bare))) {
    return false;
  }
  if (VPA_TOKEN.test(token) || IFSC_TOKEN.test(token)) {
    return false;
  }
  if (MASKED_TOKEN.test(token) || isOpaqueReference(bare)) {
    return false;
  }
  // Needs a real word. Three letters rather than two, because date ranges in
  // interest postings leave fragments like `2025to 30`, whose only letters are
  // the `to`, and that would otherwise be chosen as the payee.
  return letterCount(token) >= 3;
}

/**
 * Pick the most payee-like fragment of the narration.
 *
 * In phrase mode consecutive surviving tokens are joined, so
 * `POS 1234XXXX5678 SWIGGY BANGALORE` yields `SWIGGY BANGALORE` rather than
 * the single longest word (which would be `BANGALORE`).
 */
function pickCandidate(tokens: string[], phraseMode: boolean): string | null {
  if (!phraseMode) {
    let best: string | null = null;
    for (const token of tokens) {
      if (
        isMerchantCandidate(token) &&
        letterCount(token) > letterCount(best ?? '')
      ) {
        best = token;
      }
    }
    return best;
  }

  const phrases: string[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (isMerchantCandidate(token)) {
      current.push(token);
    } else if (current.length) {
      phrases.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) {
    phrases.push(current.join(' '));
  }

  let best: string | null = null;
  for (const phrase of phrases) {
    if (letterCount(phrase) > letterCount(best ?? '')) {
      best = phrase;
    }
  }
  return best;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map(word => {
      // Keep known acronyms upper-case and title-case everything else. Word
      // length is not a usable signal: `HDFC`, `SIP`, `JOHN` and `DOE` are
      // all short and all-caps, and only some are acronyms. Brand acronyms
      // outside this set (`KFC`) are resolved by the merchant map instead.
      if (KNOWN_ACRONYMS.has(word.toLowerCase())) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Turn a VPA into a readable name: `bharatpe90771@yesbankltd` -> `Bharatpe`,
 * `john.doe@oksbi` -> `John Doe`. Returns null for phone-number VPAs like
 * `9876543210@ybl`, where nothing readable remains.
 */
function nameFromVpa(vpa: string): string | null {
  const local = vpa.split('@')[0] ?? '';

  const words = local
    .replace(/[._-]+/g, ' ')
    .split(/\s+/)
    // Drop pure-digit words, then trailing digits on the rest.
    .filter(word => !/^\d+$/.test(word))
    .map(word => word.replace(/\d+$/, ''))
    .filter(Boolean);

  if (!words.length) {
    return null;
  }
  return titleCase(words.join(' '));
}

export type ParseNarrationOptions = {
  /** User-supplied merchant rules; these take precedence over built-ins. */
  merchantRules?: MerchantRule[];
};

/**
 * Parse an Indian bank narration into a usable payee plus the structured
 * fields hiding inside it.
 *
 * `merchant` is never empty — the fallback chain ends at the raw narration, so
 * the worst outcome equals what Actual shows today.
 */
export function parseNarration(
  raw: string,
  options: ParseNarrationOptions = {},
): ParsedNarration {
  const rules = options.merchantRules ?? [];
  const trimmed = raw.trim();
  const { tokens, phraseMode } = tokenize(trimmed);

  const vpa = extractVpa(tokens);
  const ref = extractRef(tokens);
  const kind = detectKind(tokens);
  const candidate = pickCandidate(tokens, phraseMode);

  // Parenthesised deliberately: `a ?? b || c` is a syntax error in JS.
  const merchant =
    resolveMerchant({ vpa, candidate, rules, kind, raw: trimmed, tokens }) ??
    (trimmed || 'Unknown');

  return {
    kind,
    merchant,
    raw: trimmed,
    ...(vpa ? { vpa } : {}),
    ...(ref ? { ref } : {}),
  };
}

function resolveMerchant({
  vpa,
  candidate,
  rules,
  kind,
  raw,
  tokens,
}: {
  vpa: string | undefined;
  candidate: string | null;
  rules: MerchantRule[];
  kind: NarrationKind;
  raw: string;
  tokens: string[];
}): string | null {
  // A mapped merchant is the strongest signal, and the VPA is the most stable
  // thing to map on — it survives spelling changes in the name field.
  if (vpa) {
    const mapped = lookupMerchant(vpa.split('@')[0] ?? '', rules);
    if (mapped) {
      return mapped;
    }
  }

  if (candidate) {
    const mapped = lookupMerchant(candidate, rules);
    if (mapped) {
      return mapped;
    }
  }

  // Bank postings that are not payments to anyone — interest, tax, charges.
  // Checked ahead of the weaker name heuristics below, because a charge like
  // `MABChgs-Mar2026` does contain a word-ish token (`MABChgs`) that would
  // otherwise be title-cased into a payee.
  const posting = lookupPosting(raw);
  if (posting) {
    return posting;
  }

  // A cash withdrawal has no payee. Without this the leftover token is
  // usually the ATM's location, which makes every withdrawal a new payee —
  // exactly the problem this tool exists to fix.
  if (kind === 'atm') {
    return 'ATM Withdrawal';
  }

  // Unmapped: prefer a multi-word name token, which is nearly always a real
  // person or place (`JOHN DOE`, `SWIGGY BANGALORE`), over a squashed VPA
  // local-part (`johndoe`). Single-word tokens lose to the VPA, which is
  // better normalised.
  const candidateIsMultiWord = !!candidate && /\s/.test(candidate.trim());
  if (candidateIsMultiWord) {
    return titleCase(candidate);
  }

  if (vpa) {
    const fromVpa = nameFromVpa(vpa);
    if (fromVpa) {
      return fromVpa;
    }
    // Nothing readable in it — a phone number or an account number as the
    // local part. The VPA itself is still the right answer: it is stable per
    // counterparty, whereas the raw narration carries a per-transaction
    // reference and so would mint a new payee every time.
    return vpa.toLowerCase();
  }

  if (candidate) {
    return titleCase(candidate);
  }

  // A recurring mandate has no name in its narration, only the collecting
  // bank and the mandate reference. Naming it after the mandate keeps every
  // collection under one payee — otherwise the sequence number printed beside
  // it makes each month a brand new payee, which is the exact problem this
  // tool exists to solve. Give it a meaningful name with a merchant rule.
  if (kind === 'ach') {
    const mandate = subTokens(tokens).find(token => MANDATE_TOKEN.test(token));
    if (mandate) {
      return `NACH ${mandate.toUpperCase()}`;
    }
  }

  return null;
}
