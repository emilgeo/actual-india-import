/**
 * Merchant identity map.
 *
 * Indian merchants appear under many spellings across banks and payment
 * routes — `swiggy@ybl`, `swiggystores@ybl`, `SWIGGY BANGALORE`, `Swiggy Ltd`.
 * Matching a pattern to one canonical name is what collapses them into a
 * single payee in Actual.
 *
 * Patterns are matched against a lowercased, separator-stripped form of either
 * the VPA local-part or the merchant name token, so `bharat-pe` and
 * `bharatpe123` both hit /^bharatpe/.
 *
 * This list is the asset that accrues value over time. Users can extend it
 * without editing source via a local override file (see `loadLocalMerchants`).
 */

export type MerchantRule = {
  pattern: RegExp;
  name: string;
};

export const MERCHANT_RULES: MerchantRule[] = [
  // Food delivery & dining
  { pattern: /^swiggy/, name: 'Swiggy' },
  { pattern: /^zomato/, name: 'Zomato' },
  { pattern: /^(dominos|jubilant.*pizza)/, name: "Domino's Pizza" },
  { pattern: /^(kfc|mcdonalds|mcd)/, name: 'Fast Food' },
  { pattern: /^(starbucks|tatastarbucks)/, name: 'Starbucks' },
  { pattern: /^(blinkit|grofers)/, name: 'Blinkit' },
  { pattern: /^(zepto|geddit)/, name: 'Zepto' },
  { pattern: /^(bigbasket|innovativeretail)/, name: 'BigBasket' },
  { pattern: /^dunzo/, name: 'Dunzo' },

  // Commerce
  { pattern: /^amazon/, name: 'Amazon' },
  { pattern: /^(flipkart|fkrt)/, name: 'Flipkart' },
  { pattern: /^myntra/, name: 'Myntra' },
  { pattern: /^(ajio|relianceretail)/, name: 'AJIO' },
  { pattern: /^(nykaa|fsnecommerce)/, name: 'Nykaa' },
  { pattern: /^meesho/, name: 'Meesho' },
  { pattern: /^(dmart|avenuesupermarts)/, name: 'DMart' },
  { pattern: /^(reliancesmart|reliancefresh)/, name: 'Reliance Smart' },
  { pattern: /^decathlon/, name: 'Decathlon' },
  { pattern: /^ikea/, name: 'IKEA' },

  // Transport
  { pattern: /^(uber|uberindia)/, name: 'Uber' },
  { pattern: /^(ola|olacabs|anitechnologies)/, name: 'Ola' },
  { pattern: /^rapido/, name: 'Rapido' },
  { pattern: /^(irctc|indianrail)/, name: 'IRCTC' },
  { pattern: /^(redbus|pilani)/, name: 'RedBus' },
  { pattern: /^(indigo|interglobe)/, name: 'IndiGo' },
  { pattern: /^(airindia|vistara)/, name: 'Air India' },
  { pattern: /^(fastag|nhai|netc)/, name: 'FASTag' },
  {
    pattern:
      /^(iocl|indianoil|hpcl|bpcl|hindustanpetro|bharatpetro|shell|nayara)/,
    name: 'Fuel',
  },

  // Utilities & telecom
  { pattern: /^(airtel|bhartiairtel)/, name: 'Airtel' },
  { pattern: /^(jio|reliancejio)/, name: 'Jio' },
  { pattern: /^(vi|vodafone|idea)$/, name: 'Vi' },
  { pattern: /^bsnl/, name: 'BSNL' },
  { pattern: /^(actfibernet|act)$/, name: 'ACT Fibernet' },
  {
    pattern: /^(tatapower|adanielectricity|bescom|kseb|mseb|tneb|bses)/,
    name: 'Electricity',
  },
  { pattern: /^(indane|hpgas|bharatgas)/, name: 'LPG Gas' },

  // Entertainment & subscriptions
  { pattern: /^netflix/, name: 'Netflix' },
  { pattern: /^(hotstar|disney)/, name: 'Disney+ Hotstar' },
  { pattern: /^(primevideo|amazonprime)/, name: 'Amazon Prime' },
  { pattern: /^spotify/, name: 'Spotify' },
  { pattern: /^(youtube|googleplay|google)/, name: 'Google' },
  { pattern: /^apple/, name: 'Apple' },
  { pattern: /^(bookmyshow|bigtree)/, name: 'BookMyShow' },
  { pattern: /^(pvr|inox|cinepolis)/, name: 'Cinema' },

  // Health & pharmacy
  { pattern: /^(pharmeasy|axelia)/, name: 'PharmEasy' },
  { pattern: /^(1mg|tata1mg)/, name: 'Tata 1mg' },
  { pattern: /^(apollo|apollopharmacy)/, name: 'Apollo Pharmacy' },
  { pattern: /^(practo|cult|curefit)/, name: 'Cult.fit' },

  // Payment intermediaries.
  // These are aggregators, not the real merchant — but a consistent payee is
  // still far better than one per transaction, and a rule in Actual can split
  // them further if wanted.
  { pattern: /^(paytm|one97)/, name: 'Paytm' },
  { pattern: /^(phonepe|phonepay)/, name: 'PhonePe' },
  { pattern: /^(gpay|googlepay|tez)/, name: 'Google Pay' },
  { pattern: /^bharatpe/, name: 'BharatPe' },
  { pattern: /^(razorpay|rzp)/, name: 'Razorpay' },
  { pattern: /^(billdesk|ccavenue|payu|cashfree)/, name: 'Payment Gateway' },

  // State enterprises and institutions.
  // Reached via a truncated handle rather than a spelled-out name
  { pattern: /^thekeralastate(f|financial)/, name: 'KSFE' },

  // Investing
  { pattern: /^(zerodha|kite)/, name: 'Zerodha' },
  { pattern: /^(groww|nextbillion)/, name: 'Groww' },
  { pattern: /^(upstox|rksv)/, name: 'Upstox' },
  { pattern: /^(indmoney|finzoom)/, name: 'INDmoney' },
  { pattern: /^(kuvera|coin)$/, name: 'Kuvera' },
];

/**
 * Bank postings that are not payments to anyone: interest, tax, card autopay.
 *
 * These are matched against the *whole* narration rather than an extracted
 * name token, because there is no name in them to extract — ICICI writes
 * interest as `000123456789:Int.Pd:30-09-2025 to 30-12-2025`. Without this the
 * payee would be the entire narration, which differs every quarter and so
 * creates a new payee each time.
 *
 * Kept separate from `MERCHANT_RULES` so that merchant patterns, which are
 * anchored to the start of a name, are never accidentally matched against the
 * middle of a narration.
 */
export const POSTING_RULES: MerchantRule[] = [
  { pattern: /wtaxpd/, name: 'Withholding Tax' },
  { pattern: /intpd/, name: 'Interest Paid' },
  // Savings-bank interest, written `SBINT:29-06-2026`.
  { pattern: /sbint/, name: 'Interest Paid' },
  // Minimum average balance charge, billed monthly as `MABChgs-Mar2026`.
  { pattern: /mabchgs/, name: 'Minimum Balance Charge' },
  { pattern: /autodebitcc/, name: 'Credit Card Autopay' },
  // Debit card annual fee, e.g. `DCARDFEE0000AUG26-JUL27+GST`.
  { pattern: /dcardfee/, name: 'Debit Card Fee' },
  { pattern: /(atmwdl|cashwdl|nwdcash)/, name: 'ATM Withdrawal' },
];

/** Resolve a bank posting type from a full narration, or null. */
export function lookupPosting(raw: string): string | null {
  const normalized = normalizeForLookup(raw);
  if (!normalized) {
    return null;
  }

  for (const rule of POSTING_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.name;
    }
  }

  return null;
}

/**
 * Collapse a VPA local-part or name token into the form the patterns expect:
 * lowercase, separators and spaces removed. `Bharat-Pe 123` -> `bharatpe123`.
 */
export function normalizeForLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a canonical merchant name, or null when nothing matches.
 * `extraRules` come from the user's local override file and win over built-ins.
 */
export function lookupMerchant(
  value: string,
  extraRules: MerchantRule[] = [],
): string | null {
  const normalized = normalizeForLookup(value);
  if (!normalized) {
    return null;
  }

  for (const rule of [...extraRules, ...MERCHANT_RULES]) {
    if (rule.pattern.test(normalized)) {
      return rule.name;
    }
  }

  return null;
}
