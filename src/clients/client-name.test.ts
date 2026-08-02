import { describe, expect, it } from 'vitest';
import {
  companyNameFromEmail,
  isPlaceholderClientName,
  resolveClientNameForInquiry,
} from './client-name';

describe('isPlaceholderClientName', () => {
  it('rejects the placeholder the marketing call-to-action used to send', () => {
    expect(isPlaceholderClientName('TBD')).toBe(true);
    expect(isPlaceholderClientName('tbd')).toBe(true);
    // Punctuation must not smuggle a placeholder past the guard.
    expect(isPlaceholderClientName('T.B.D.')).toBe(true);
  });

  it('rejects other stand-ins and empty-ish values', () => {
    for (const value of ['', '   ', 'n/a', 'None', 'unknown company', 'test', '???', '-', null, undefined]) {
      expect(isPlaceholderClientName(value)).toBe(true);
    }
  });

  it('accepts real company names', () => {
    for (const value of ['Northwind Traders', 'Acme', '3M', 'X Corp Holdings']) {
      expect(isPlaceholderClientName(value)).toBe(false);
    }
  });
});

describe('companyNameFromEmail', () => {
  it('derives a readable company from a work domain', () => {
    expect(companyNameFromEmail('ada@northwind-traders.com')).toBe('Northwind Traders');
    expect(companyNameFromEmail('ADA@Acme.io')).toBe('Acme');
  });

  it('handles public suffixes without dropping the company', () => {
    expect(companyNameFromEmail('ada@northwind.co.uk')).toBe('Northwind');
    expect(companyNameFromEmail('ada@northwind.com.au')).toBe('Northwind');
  });

  it('keeps subdomains that carry the company name', () => {
    expect(companyNameFromEmail('ada@mail.northwind.com')).toBe('Mail Northwind');
  });

  it('refuses consumer mailboxes, which say nothing about an employer', () => {
    for (const email of ['ada@gmail.com', 'ada@outlook.com', 'ada@proton.me', 'ada@example.com']) {
      expect(companyNameFromEmail(email)).toBeNull();
    }
  });

  it('refuses malformed input rather than guessing', () => {
    for (const email of ['', 'not-an-email', 'ada@', 'ada@localhost', null, undefined]) {
      expect(companyNameFromEmail(email)).toBeNull();
    }
  });
});

describe('resolveClientNameForInquiry', () => {
  it('prefers a name the PM typed over anything inferred', () => {
    expect(
      resolveClientNameForInquiry({
        explicitName: 'Northwind Traders Ltd',
        companyName: 'Northwind',
        email: 'ada@other.com',
      }),
    ).toBe('Northwind Traders Ltd');
  });

  it('falls back to the company the lead supplied', () => {
    expect(
      resolveClientNameForInquiry({ companyName: 'Northwind', email: 'ada@northwind-traders.com' }),
    ).toBe('Northwind');
  });

  it('falls back to the email domain when the company is a placeholder', () => {
    // Exactly the marketing call-to-action case: no company field, "TBD" sent instead.
    expect(
      resolveClientNameForInquiry({ companyName: 'TBD', email: 'ada@northwind-traders.com' }),
    ).toBe('Northwind Traders');
  });

  it('returns null when nothing usable exists, so a human must decide', () => {
    expect(resolveClientNameForInquiry({ companyName: 'TBD', email: 'ada@gmail.com' })).toBeNull();
    expect(resolveClientNameForInquiry({})).toBeNull();
  });

  it('ignores a placeholder typed by the PM instead of trusting it', () => {
    expect(
      resolveClientNameForInquiry({ explicitName: 'TBD', companyName: 'Northwind', email: 'a@b.com' }),
    ).toBe('Northwind');
  });
});
