/**
 * Client-name hygiene.
 *
 * A client's name is its identity: `resolveClientId` matches on it case-insensitively and creates
 * a company when nothing matches. That makes placeholder names actively harmful — the marketing
 * call-to-action form only collects an email and a brief, and used to send the literal string
 * "TBD" as the company. Approving two such leads would file two unrelated businesses under one
 * fake client named "TBD", which is the duplicate-merge problem the Client entity exists to
 * prevent, only inverted and harder to unpick.
 *
 * These helpers are the authority for every inbound path, so a client app cannot bypass them by
 * sending its own placeholder.
 */

/**
 * Values that mean "we did not ask" rather than naming a company. Compared case-insensitively
 * after trimming and collapsing punctuation, so "T.B.D." and "tbd" are both caught.
 */
const PLACEHOLDER_CLIENT_NAMES = new Set([
  'tbd',
  'tba',
  'na',
  'n/a',
  'none',
  'null',
  'undefined',
  'unknown',
  'unknown company',
  'test',
  'testing',
  'company',
  'my company',
  'placeholder',
  'anonymous',
  'x',
  '-',
  '.',
  '?',
]);

/**
 * Domains that identify a person, not a company, so the domain says nothing about who they work
 * for. A lead from gmail.com needs a human to supply the company name.
 */
const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
  '126.com',
  'example.com',
]);

/** Minimum length below which a "name" carries no identifying information. */
const MIN_MEANINGFUL_LENGTH = 2;

function normalize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    // Fold "T.B.D." and "T B D" onto "tbd" so punctuation cannot smuggle a placeholder through.
    .replace(/[.\s_]+/g, (match) => (match.includes(' ') ? ' ' : ''))
    .trim();
}

/** True when a company name is a stand-in rather than a real company. */
export function isPlaceholderClientName(name: string | null | undefined): boolean {
  if (!name) return true;
  const normalized = normalize(name);
  if (normalized.length < MIN_MEANINGFUL_LENGTH) return true;
  if (PLACEHOLDER_CLIENT_NAMES.has(normalized)) return true;
  // A "name" with no letters or digits — "---", "???" — identifies nothing.
  return !/[a-z0-9]/i.test(normalized);
}

/**
 * Derives a usable company name from a work email address.
 *
 * `ada@northwind-traders.com` becomes "Northwind Traders". Returns null for consumer mailboxes
 * and for anything that does not look like a company domain, because a wrong-but-plausible name
 * is worse than asking a human.
 */
export function companyNameFromEmail(email: string | null | undefined): string | null {
  const domain = email?.trim().toLowerCase().split('@')[1];
  if (!domain || !domain.includes('.')) return null;
  if (CONSUMER_EMAIL_DOMAINS.has(domain)) return null;

  const labels = domain.split('.').filter(Boolean);
  // Drop the TLD, plus the second-level label for public suffixes like "co.uk" or "com.au".
  const trailing = labels.length >= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(labels[labels.length - 2])
    ? 2
    : 1;
  const core = labels.slice(0, Math.max(1, labels.length - trailing)).join(' ');
  if (!core) return null;

  const name = core
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim();

  return name && !isPlaceholderClientName(name) ? name : null;
}

/**
 * The best client name available for an inquiry, or null when a human has to supply one.
 *
 * Order matters: an explicitly typed name always wins over anything inferred, and the company
 * the lead actually gave beats a guess from their email domain.
 */
export function resolveClientNameForInquiry(input: {
  explicitName?: string | null;
  companyName?: string | null;
  email?: string | null;
}): string | null {
  const explicit = input.explicitName?.trim();
  if (explicit && !isPlaceholderClientName(explicit)) return explicit;

  const provided = input.companyName?.trim();
  if (provided && !isPlaceholderClientName(provided)) return provided;

  return companyNameFromEmail(input.email);
}
