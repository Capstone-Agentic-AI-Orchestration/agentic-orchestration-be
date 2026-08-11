import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientAccountInvitationService } from '../src/inquiries/client-account-invitation.service';

const input = {
  email: 'Casey@Example.com',
  contactName: 'Casey Client',
  companyName: 'Acme Co',
  inquiryId: 'inquiry-1',
  projectId: 'project-1',
};

/** Replies in call order: the admin lookup first, then whichever send follows. */
const bodies: Array<unknown> = [];

function stubFetch(...responses: Array<{ ok?: boolean; status?: number; body?: unknown }>) {
  bodies.length = 0;
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    const next = responses.shift() ?? { ok: true, status: 200, body: {} };
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body ?? {},
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const userRow = (email: string, providers: string[]) => ({
  users: [{ email, identities: providers.map((provider) => ({ provider })) }],
});

const ORIGINAL_ENV = { ...process.env };

describe('ClientAccountInvitationService', () => {
  let service: ClientAccountInvitationService;

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    process.env.CLIENT_APP_URL = 'http://localhost:3000';
    service = new ClientAccountInvitationService();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('invites an address that has no account yet', async () => {
    const calls = stubFetch({ body: { users: [] } }, { ok: true });

    const result = await service.send(input);

    expect(result.status).toBe('SENT');
    expect(calls[0]).toContain('/auth/v1/admin/users');
    expect(calls[1]).toContain('/auth/v1/invite');
    // Lands on activation, not sign-in: the emailed link carries a session but no password yet, so
    // a sign-in form would ask for a credential the client does not have.
    expect(calls[1]).toContain(encodeURIComponent('http://localhost:3000/client/activate'));

    // The metadata rides along so the account knows which company and inquiry it belongs to.
    const request = bodies[1];
    expect(request).toEqual({
      email: 'casey@example.com',
      data: {
        full_name: 'Casey Client',
        company_name: 'Acme Co',
        inquiry_id: 'inquiry-1',
        project_id: 'project-1',
        role: 'CLIENT',
      },
    });
  });

  // Supabase refuses to invite an existing address, so a password link is the only way to get one
  // of these clients in. It reaches the same activation page.
  it('sends a set-password link to an address that already signs in with a password', async () => {
    const calls = stubFetch({ body: userRow('casey@example.com', ['email']) }, { ok: true });

    const result = await service.send(input);

    expect(result.status).toBe('PASSWORD_LINK_SENT');
    expect(calls[1]).toContain('/auth/v1/recover');
  });

  // Clients sign in with email only — the client backend rejects every other provider. Emailing a
  // GitHub-only account would send a link to somebody who still could not sign in afterwards.
  it('refuses an address whose only identity is OAuth, and sends nothing', async () => {
    const calls = stubFetch({ body: userRow('casey@example.com', ['github']) });

    const result = await service.send(input);

    expect(result.status).toBe('OAUTH_ONLY_ACCOUNT');
    expect(result.message).toContain('different email address');
    expect(calls).toHaveLength(1);
  });

  it('treats an account with both identities as a password account', async () => {
    const calls = stubFetch({ body: userRow('casey@example.com', ['github', 'email']) }, { ok: true });

    expect((await service.send(input)).status).toBe('PASSWORD_LINK_SENT');
    expect(calls[1]).toContain('/auth/v1/recover');
  });

  // `filter` is a fuzzy match, so a near-miss must not be mistaken for the address we asked about.
  it('ignores a lookup row for a different address', async () => {
    const calls = stubFetch({ body: userRow('casey.other@example.com', ['github']) }, { ok: true });

    expect((await service.send(input)).status).toBe('SENT');
    expect(calls[1]).toContain('/auth/v1/invite');
  });

  // A read failure must not block an approval: fall through and let the invite attempt decide.
  it('still invites when the lookup itself fails', async () => {
    const calls = stubFetch({ ok: false, status: 500 }, { ok: true });

    expect((await service.send(input)).status).toBe('SENT');
    expect(calls[1]).toContain('/auth/v1/invite');
  });

  // The wording matters: a rate limit is worth retrying and "could not be sent" does not say so.
  it('names a rate limit rather than reporting a generic failure', async () => {
    stubFetch({ body: { users: [] } }, { ok: false, status: 429, body: 'rate limited' });

    const result = await service.send(input);

    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('Too many emails');
  });

  it('reports missing configuration instead of silently sending nothing', async () => {
    delete process.env.CLIENT_APP_URL;
    stubFetch({ body: { users: [] } });

    const result = await service.send(input);

    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('not configured');
  });

  it('normalises the address before doing anything with it', async () => {
    const calls = stubFetch({ body: { users: [] } }, { ok: true });

    const result = await service.send(input);

    expect(result.email).toBe('casey@example.com');
    expect(calls[0]).toContain(encodeURIComponent('casey@example.com'));
  });
});
