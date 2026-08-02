import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientAccountInvitationService } from '../src/inquiries/client-account-invitation.service';

const ORIGINAL_ENV = { ...process.env };

describe('ClientAccountInvitationService', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    process.env.CLIENT_APP_URL = 'https://clients.alphaexplora.com';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('sends an invite that lands on activation, not sign-in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ClientAccountInvitationService().send({
      email: 'Casey@Example.com',
      contactName: 'Casey Client',
      companyName: 'Acme Co',
      inquiryId: 'inquiry-1',
      projectId: 'project-1',
    });

    expect(result.status).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledWith(
      // The invite link carries a session but no password yet, so sign-in would ask for a
      // credential the client does not have.
      'https://example.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fclients.alphaexplora.com%2Fclient%2Factivate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'service-role-key',
          Authorization: 'Bearer service-role-key',
        }),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
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

  it('reports a deployable configuration error without exposing secrets', async () => {
    delete process.env.CLIENT_APP_URL;

    const result = await new ClientAccountInvitationService().send({
      email: 'casey@example.com',
      contactName: 'Casey Client',
      companyName: 'Acme Co',
      inquiryId: 'inquiry-1',
      projectId: 'project-1',
    });

    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('not configured');
  });
});
