import { describe, expect, it } from 'vitest';

import { parseNarration } from './parse.js';
import type { NarrationKind } from './types.js';

type Case = {
  name: string;
  raw: string;
  merchant: string;
  kind: NarrationKind;
  vpa?: string;
  ref?: string;
};

/**
 * Narration shapes taken from the formats Indian banks actually emit. HDFC and
 * SBI delimit with `/`, ICICI with `-`, and card/ATM entries use neither.
 */
const cases: Case[] = [
  {
    name: 'HDFC slash-delimited UPI merchant',
    raw: 'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment',
    merchant: 'Swiggy',
    kind: 'upi',
    vpa: 'swiggy@ybl',
    ref: '412345678901',
  },
  {
    name: 'ICICI dash-delimited UPI merchant',
    raw: 'UPI-SWIGGY-swiggy@ybl-YESB0000123-412345678901-Payment',
    merchant: 'Swiggy',
    kind: 'upi',
    vpa: 'swiggy@ybl',
    ref: '412345678901',
  },
  {
    name: 'lowercase narration still classifies',
    raw: 'upi/dr/412345678901/zomato/hdfc/zomato@paytm/payment',
    merchant: 'Zomato',
    kind: 'upi',
    vpa: 'zomato@paytm',
    ref: '412345678901',
  },
  {
    name: 'person-to-person keeps the human name over the VPA local-part',
    raw: 'UPI/412345678901/JOHN DOE/johndoe@oksbi',
    merchant: 'John Doe',
    kind: 'upi',
    vpa: 'johndoe@oksbi',
    ref: '412345678901',
  },
  {
    name: 'merchant map collapses a VPA variant',
    raw: 'UPI/DR/412345678999/SWIGGY STORES/YESB/swiggystores@ybl/Payment',
    merchant: 'Swiggy',
    kind: 'upi',
    vpa: 'swiggystores@ybl',
    ref: '412345678999',
  },
  {
    name: 'card purchase keeps the multi-word name via phrase grouping',
    raw: 'POS 1234XXXX5678 SWIGGY BANGALORE',
    merchant: 'Swiggy',
    kind: 'pos',
  },
  {
    name: 'NEFT drops the IFSC and keeps the counterparty',
    raw: 'NEFT/DR/HDFC0001234/ACME CONSULTING',
    merchant: 'Acme Consulting',
    kind: 'neft',
  },
  {
    name: 'IMPS via a channel prefix',
    raw: 'MMT/IMPS/412345678901/Payment/JOHN',
    merchant: 'John',
    kind: 'imps',
    ref: '412345678901',
  },
  {
    name: 'standing instruction keeps the bank acronym upper-case',
    raw: 'ACH/D/HDFC MUTUAL FUND SIP',
    merchant: 'HDFC Mutual Fund SIP',
    kind: 'ach',
  },
  {
    name: 'ATM withdrawal is not a payee',
    raw: 'ATW/1234/CASH WDL/BANGALORE',
    merchant: 'ATM Withdrawal',
    kind: 'atm',
  },
  {
    name: 'trailing digits are stripped from an aggregator VPA',
    raw: 'UPI/DR/412345678901/BharatPe Merchant/YESB/bharatpe90771@yesbankltd/Payment',
    merchant: 'BharatPe',
    kind: 'upi',
    vpa: 'bharatpe90771@yesbankltd',
    ref: '412345678901',
  },
];

describe('parseNarration', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const parsed = parseNarration(testCase.raw);

      expect(parsed.merchant).toBe(testCase.merchant);
      expect(parsed.kind).toBe(testCase.kind);
      expect(parsed.vpa).toBe(testCase.vpa);
      expect(parsed.ref).toBe(testCase.ref);
      // The original must always survive for `imported_payee`.
      expect(parsed.raw).toBe(testCase.raw);
    });
  }
});

describe('parseNarration reference extraction', () => {
  it('ignores digit runs that are not UPI references', () => {
    // A 16-digit account number is not unique per transaction. Using it as
    // `imported_id` would make Actual treat unrelated transactions as the
    // same one and drop them, so it must not be picked up.
    const parsed = parseNarration('NEFT/DR/1234567890123456/ACME CONSULTING');

    expect(parsed.ref).toBeUndefined();
    expect(parsed.merchant).toBe('Acme Consulting');
  });

  it('ignores masked card numbers', () => {
    expect(parseNarration('POS 1234XXXX5678 DMART').ref).toBeUndefined();
  });
});

describe('parseNarration fallback chain', () => {
  it('falls back to the raw narration when nothing is extractable', () => {
    // Phone-number VPA, no name token: there is nothing readable to build a
    // payee from, so the raw text is used rather than an empty payee.
    const raw = 'UPI/412345678901/9876543210@ybl';
    const parsed = parseNarration(raw);

    expect(parsed.merchant).toBe(raw);
    expect(parsed.vpa).toBe('9876543210@ybl');
  });

  it('handles an unrecognised narration as plain text', () => {
    const parsed = parseNarration('SOME RANDOM CHARGE');

    expect(parsed.merchant).toBe('Some Random Charge');
    expect(parsed.kind).toBe('other');
  });

  it('never returns an empty merchant', () => {
    for (const raw of ['', '   ', '/', '---', '/// ///', '0', 'X']) {
      expect(parseNarration(raw).merchant).not.toBe('');
    }
  });
});

describe('parseNarration custom merchant rules', () => {
  it('lets user rules win over the built-in map', () => {
    const parsed = parseNarration(
      'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment',
      { merchantRules: [{ pattern: /^swiggy/, name: 'Food Delivery' }] },
    );

    expect(parsed.merchant).toBe('Food Delivery');
  });
});
