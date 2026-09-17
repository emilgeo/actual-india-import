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
  it('uses the VPA when no readable name can be built from it', () => {
    // A phone-number VPA with no name token: nothing readable can be derived,
    // but the VPA is still stable per counterparty. The raw narration is not,
    // because it carries a per-transaction reference — using it would mint a
    // new payee for every transfer from the same person.
    const parsed = parseNarration('UPI/412345678901/9876543210@ybl');

    expect(parsed.merchant).toBe('9876543210@ybl');
    expect(parsed.vpa).toBe('9876543210@ybl');
  });

  it('falls back to the raw narration when there is nothing at all', () => {
    // No name, no VPA, no recognised posting — only opaque digits.
    const raw = '0000/1234567890123456/99';
    expect(parseNarration(raw).merchant).toBe(raw);
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

/**
 * ICICI's real narration shape, which differs from the other banks in ways
 * that matter. Field values are anonymised; the structure, the ~10-character
 * field truncation and the trailing provider reference are reproduced exactly
 * as the bank emits them.
 *
 *   UPI / name / VPA / remark / bank / UTR / provider reference
 */
describe('parseNarration with ICICI field truncation', () => {
  it('ignores the long provider reference trailing the UTR', () => {
    // The reference has more letters than any real name in the string, so a
    // longest-run-of-letters rule would pick it as the payee.
    const parsed = parseNarration(
      'UPI/SOMEPERSON/someperson-3@ok/UPI/State Bank/100000000002/SBI1aa2bb3cc4dd5ee6ff7aa8bb9cc0dd1ee',
    );

    expect(parsed.merchant).not.toContain('SBI1aa2bb');
    expect(parsed.ref).toBe('100000000002');
    expect(parsed.vpa).toBe('someperson-3@ok');
  });

  it('ignores the counterparty bank written out in words', () => {
    const parsed = parseNarration(
      'UPI/A N OTHER/another@axl/Payment fr/FEDERAL BA/100000000001/AXL1aa2bb3cc4dd5ee6ff7aa8bb9cc0dd2ee',
    );

    // `FEDERAL BA` and `Payment fr` are truncated noise, not payees.
    expect(parsed.merchant).toBe('A N Other');
    expect(parsed.ref).toBe('100000000001');
  });

  it('handles a phone-number VPA with a truncated domain', () => {
    const parsed = parseNarration(
      'UPI/Mr A N OTHE/9000000000@idf/Pay reques/IDFC FIRST/100000000003/IDFOP0000aa1bb2cc3dd4ee5ff6aa7bb8cc',
    );

    expect(parsed.merchant).toBe('Mr A N Othe');
    expect(parsed.ref).toBe('100000000003');
  });

  it('names a recurring mandate after the mandate, not the collection', () => {
    // A NACH narration contains no name at all — only the collecting bank and
    // the mandate reference, followed by a sequence number that changes every
    // month. Falling back to the raw text would therefore mint a new payee per
    // collection, so the stable mandate reference is used instead.
    const first = parseNarration(
      'ACH/HDFC BANK LTD/ICIC0000000000000001/446223826  26',
    );
    const second = parseNarration(
      'ACH/HDFC BANK LTD/ICIC0000000000000001/449604408  08',
    );

    expect(first.kind).toBe('ach');
    expect(first.merchant).toBe('NACH ICIC0000000000000001');
    // The whole point: the next month's collection is the same payee.
    expect(second.merchant).toBe(first.merchant);

    // A different mandate stays a different payee.
    expect(
      parseNarration('ACH/HDFC BANK LTD/ICIC0000000000000002/446223827  27')
        .merchant,
    ).toBe('NACH ICIC0000000000000002');

    // The mandate id must not be mistaken for a UTR.
    expect(first.ref).toBeUndefined();
  });

  it('still keeps a bank name that is part of a real payee', () => {
    // Contrast with the ACH case: a bank name inside a longer payee is not
    // noise, which is why the bank patterns are anchored.
    expect(parseNarration('ACH/D/HDFC MUTUAL FUND SIP').merchant).toBe(
      'HDFC Mutual Fund SIP',
    );
  });

  it('reads an interest posting as plain text', () => {
    const parsed = parseNarration(
      '000123456789:Int.Pd:30-09-2025 to 30-12-2025',
    );

    expect(parsed.kind).toBe('other');
    expect(parsed.ref).toBeUndefined();
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

/**
 * Bank postings that are charges or interest rather than payments to anyone.
 * Each of these produced a poor payee at some point, so each is pinned here.
 */
describe('parseNarration bank postings', () => {
  it('names a minimum-balance penalty rather than title-casing its code', () => {
    // `MABChgs` is a word-ish token, so the name heuristics would happily
    // return `Mabchgs`. Posting rules therefore run ahead of them.
    for (const month of ['Mar2026', 'Apr2026', 'May2026']) {
      expect(parseNarration(`MABChgs-${month}`).merchant).toBe(
        'Minimum Balance Charge',
      );
    }
  });

  it('keeps an employer name instead of collapsing to a generic posting', () => {
    // The flip side of the rule above: posting rules must not override a
    // narration that does name someone.
    expect(parseNarration('SALARY ACME CONSULTING PVT LTD').merchant).toBe(
      'Salary Acme Consulting Pvt Ltd',
    );
  });

  it('recognises interest and withholding tax', () => {
    expect(
      parseNarration('000123456789:Int.Pd:30-09-2025 to 30-12-2025').merchant,
    ).toBe('Interest Paid');
    expect(
      parseNarration('000123456789:WTax.Pd:30-09-2025to 30-12-2025').merchant,
    ).toBe('Withholding Tax');
  });

  it('recognises a card autopay debit', () => {
    // Without a posting rule the only candidate token is the `ATD` channel
    // code, which becomes the payee `Atd`.
    expect(parseNarration('ATD/Auto Debit CC0xx0000').merchant).toBe(
      'Credit Card Autopay',
    );
  });

  it('recognises a debit card fee', () => {
    expect(parseNarration('DCARDFEE0000AUG26-JUL27+GST').merchant).toBe(
      'Debit Card Fee',
    );
  });
});

/**
 * Federal Bank prefixes narrations with its own channel codes, which are not
 * payees and which also carry the route information.
 */
describe('parseNarration with Federal channel codes', () => {
  it('reads UPIOUT as a UPI transaction, not a payee', () => {
    const parsed = parseNarration(
      'UPIOUT/100000000001/someone@okbank/Payment/0000',
    );

    expect(parsed.kind).toBe('upi');
    expect(parsed.merchant).not.toMatch(/upiout/i);
    expect(parsed.ref).toBe('100000000001');
  });

  it('reads the route from the second word of a combined field', () => {
    // `FT IMPS/IFI/...` puts the channel and the route in one field, so
    // matching only whole tokens would classify this as `other`.
    const parsed = parseNarration(
      'FT IMPS/IFI/100000000002/Mr A N OTHER/IMPSTXN',
    );

    expect(parsed.kind).toBe('imps');
    expect(parsed.merchant).toBe('Mr A N Other');
  });

  it('uses an account-number VPA as a stable payee', () => {
    // Federal writes some counterparties as an account-number VPA. Nothing
    // readable can be built from it, but it is stable, whereas the raw
    // narration carries a per-transaction reference.
    const first = parseNarration(
      'UPIOUT/100000000001 /0000000000000000@BANK000/0000',
    );
    const second = parseNarration(
      'UPIOUT/100000000009 /0000000000000000@BANK000/0000',
    );

    expect(first.merchant).toBe('0000000000000000@bank000');
    expect(second.merchant).toBe(first.merchant);
  });

  it('names a merchant written as a bare handle with no @psp part', () => {
    // A handle with the `@psp` part missing does not look like a VPA, and
    // Mixing letters with digits made it read as a machine reference, which
    // left no name at all, so the whole narration became the payee.
    const parsed = parseNarration(
      'UPIOUT/100000000001 /thekeralastatefin123456.rz/0000',
    );

    expect(parsed.merchant).toBe('KSFE');
    expect(parsed.merchant).not.toContain('UPIOUT');
  });

  it('collapses a handle that carries a per-account numeric id', () => {
    // The digits identify the merchant's payment account, not the transaction.
    const parsed = parseNarration('UPIOUT/100000000001 /somemerchant9912.rz/1');

    expect(parsed.merchant).toBe('Somemerchant');
  });

  it('keeps a leaked page footer out of the payee', () => {
    // A footer leaking into the narration arrives as one very wordy field.
    // Being almost all letters, it would win a longest-letters rule outright.
    const parsed = parseNarration(
      'UPIOUT/100000000002 /thekeralastatefin123456.rz/0000 Some Bank Ltd. ' +
        'Corporate Office: Some Towers, Market Rd, Some Nagar, Somewhere, ' +
        'Someplace, 600001,',
    );

    expect(parsed.merchant).toBe('KSFE');
    expect(parsed.merchant).not.toMatch(/corporate office|towers/i);
  });

  it('gives the same payee whether or not a footer leaked in', () => {
    // Same merchant on both rows, so they must not become two payees.
    const withFooter = parseNarration(
      'UPIOUT/100000000002 /thekeralastatefin123456.rz/0000 Some Bank Ltd. ' +
        'Corporate Office: Some Towers, Somewhere, Someplace, 600001,',
    );
    const withoutFooter = parseNarration(
      'UPIOUT/100000000001 /thekeralastatefin123456.rz/0000',
    );

    expect(withFooter.merchant).toBe(withoutFooter.merchant);
  });

  it('keeps a digitless address out of the payee', () => {
    // The footer above carries a pincode, which alone is enough to reject it.
    // Truncated before the pincode it has no digits, and then only its number
    // of words marks it as not-a-name.
    const parsed = parseNarration(
      'UPIOUT/100000000002 /somemerchant.rz/Some Bank Ltd. Corporate ' +
        'Office: Some Towers, Market Rd, Some Nagar, Somewhere',
    );

    expect(parsed.merchant).toBe('Somemerchant');
    expect(parsed.merchant).not.toMatch(/corporate|towers|somewhere/i);
  });

  it('completes a name split between the field text and the VPA', () => {
    // The name and the VPA share one field, and the VPA's local-part holds
    // only the second half of the name, which alone gives `Lastname`.
    const parsed = parseNarration(
      'UPIOUT/100000000003/firstname. lastname9@oksbi/Payment/0000',
    );

    expect(parsed.merchant).toBe('Firstname Lastname');
    expect(parsed.vpa).toBe('lastname9@oksbi');
  });

  it('does not merge a name from a different field into the VPA name', () => {
    // The guard on the above: `SWIGGY` and `swiggy@ybl` are separate fields,
    // and in narrations naming both payer and payee, merging across fields
    // would splice two people together.
    const parsed = parseNarration(
      'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment',
    );

    expect(parsed.merchant).toBe('Swiggy');
  });

  it('rejects a machine reference whose letter runs are long', () => {
    // Letting handles through on the strength of a long letter run also let
    // this shape in. Digits scattered through it are the giveaway: a name
    // carrying an id has one digit group, not five.
    const parsed = parseNarration(
      'MMT/IMPS/612345678901/ZZTOPQ0111ABCDEFGH2IJ3KL MNOPQR0X44STUV/Mr A N ' +
        'OTHER/IDFC bank',
    );

    expect(parsed.merchant).toBe('Mr A N Other');
    expect(parsed.merchant).not.toMatch(/zztopq|mnopqr/i);
  });

  it('still rejects a genuine machine reference as a name', () => {
    // The counterweight to letting handles through: provider references
    // interleave letters and digits, so no long letter run exists.
    const parsed = parseNarration(
      'UPI/A N OTHER/another@axl/Payment fr/FEDERAL BA/100000000001/' +
        'AXL1aa2bb3cc4dd5ee6ff7aa8b',
    );

    expect(parsed.merchant).toBe('A N Other');
    expect(parsed.merchant).not.toMatch(/axl1aa/i);
  });
});
