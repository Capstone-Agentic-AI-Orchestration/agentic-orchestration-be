import { Injectable, Logger } from '@nestjs/common';

export type AccountInvitationDeliveryStatus =
  /** A fresh invitation email is on its way. */
  | 'SENT'
  /**
   * The address belongs to a staff GitHub account and cannot be a client login.
   *
   * Clients sign in with email and password only — the client backend rejects any other provider —
   * so an address whose only identity is OAuth can never sign in to the client console, however
   * many emails we send it. Reported rather than papered over, because the fix is a different
   * address and only the project manager can choose one.
   */
  | 'OAUTH_ONLY_ACCOUNT'
  /**
   * The address already had an account, so a set-password link was emailed instead.
   *
   * Still a delivered email — the client gets a link, follows it, and chooses a password, exactly
   * as an invited client would. Distinguished from SENT only so the console can say which happened.
   */
  | 'PASSWORD_LINK_SENT'
  /** The address already had an account and nothing needed sending. */
  | 'EXISTING_ACCOUNT'
  | 'FAILED';

export interface AccountInvitationDelivery {
  status: AccountInvitationDeliveryStatus;
  email: string;
  message: string;
}

interface SendAccountInvitationInput {
  email: string;
  contactName: string;
  companyName: string;
  inquiryId: string;
  projectId: string;
}

/** Sends the client account invitation through Supabase Auth's server-only admin endpoint. */
@Injectable()
export class ClientAccountInvitationService {
  private readonly logger = new Logger(ClientAccountInvitationService.name);

  async send(input: SendAccountInvitationInput): Promise<AccountInvitationDelivery> {
    const email = input.email.trim().toLowerCase();
    const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    const clientAppUrl = process.env.CLIENT_APP_URL?.trim();

    if (!supabaseUrl || !serviceRoleKey || !clientAppUrl) {
      this.logger.error(
        'Client account email is not configured. SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and CLIENT_APP_URL are required.',
      );
      return {
        status: 'FAILED',
        email,
        message: 'The inquiry was approved, but the account email service is not configured.',
      };
    }

    let redirectTo: string;
    try {
      // Lands on activation, not sign-in: the invite link carries a session but no password
      // yet, so sending them to a sign-in form would ask for a credential they do not have.
      redirectTo = new URL('/client/activate', `${clientAppUrl.replace(/\/+$/, '')}/`).toString();
    } catch {
      this.logger.error('CLIENT_APP_URL is not a valid absolute URL.');
      return {
        status: 'FAILED',
        email,
        message: 'The inquiry was approved, but the client account URL is invalid.',
      };
    }

    // Look the address up first rather than inviting and reading the failure. Supabase reports an
    // existing account as a 422 whose body has changed wording between releases, so the old regex
    // over the error text was one release note away from silently sending nothing.
    const existing = await this.findAuthUser(email, supabaseUrl, serviceRoleKey);

    if (existing) {
      const providers = existing.identities.map((identity) => identity.provider);
      if (!providers.includes('email')) {
        this.logger.warn(
          `Inquiry ${input.inquiryId}: ${email} exists as a ${providers.join('/')} account with no email identity.`,
        );
        return {
          status: 'OAUTH_ONLY_ACCOUNT',
          email,
          message: `This address already signs in with ${providers.join(' and ')} and cannot be used as a client login. Ask the client for a different email address, then resend.`,
        };
      }
      return this.sendPasswordLink({ email, redirectTo, supabaseUrl, serviceRoleKey, inquiryId: input.inquiryId });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(
        `${supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email,
            data: {
              full_name: input.contactName,
              company_name: input.companyName,
              inquiry_id: input.inquiryId,
              project_id: input.projectId,
              role: 'CLIENT',
            },
          }),
        },
      );

      if (response.ok) {
        return {
          status: 'SENT',
          email,
          message: 'The client account invitation email was sent.',
        };
      }

      // Backstop for a race: the lookup above said no account, and one appeared before we invited.
      const responseBody = await response.text().catch(() => '');
      if (
        response.status === 422 &&
        /already (been )?registered|already exists|user.*exists/i.test(responseBody)
      ) {
        return this.sendPasswordLink({ email, redirectTo, supabaseUrl, serviceRoleKey, inquiryId: input.inquiryId });
      }

      this.logger.error(
        `Supabase rejected the client invitation for inquiry ${input.inquiryId} with status ${response.status}.`,
      );
      return {
        status: 'FAILED',
        email,
        message:
          response.status === 429
            ? 'Too many emails have been sent recently. Wait a few minutes and resend the invitation.'
            : 'The inquiry was approved, but the account email could not be sent.',
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Client account invitation failed for inquiry ${input.inquiryId}: ${reason}`);
      return {
        status: 'FAILED',
        email,
        message: 'The inquiry was approved, but the account email could not be sent.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The Supabase auth user for an address, with the identities that decide how they can sign in.
   *
   * Returns null when the address is free, and also when the lookup itself fails — a lookup outage
   * should fall through to the invite attempt, which has its own error handling, rather than
   * blocking an approval on a read.
   */
  private async findAuthUser(
    email: string,
    supabaseUrl: string,
    serviceRoleKey: string,
  ): Promise<{ identities: Array<{ provider: string }> } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(
        `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1&filter=${encodeURIComponent(email)}`,
        {
          signal: controller.signal,
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        },
      );
      if (!response.ok) return null;

      const body = (await response.json()) as { users?: Array<{ email?: string; identities?: Array<{ provider?: string }> }> };
      // `filter` is a fuzzy match, so confirm the address rather than trusting the first row.
      const match = (body.users ?? []).find((user) => user.email?.toLowerCase() === email);
      if (!match) return null;

      return {
        identities: (match.identities ?? [])
          .map((identity) => ({ provider: (identity.provider ?? '').toLowerCase() }))
          .filter((identity) => identity.provider),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Emails a set-password link to an address that already has an account.
   *
   * Uses the recovery endpoint rather than admin `generate_link`: generate_link returns a URL
   * without sending anything, which would leave us holding a link and the client still waiting.
   */
  private async sendPasswordLink(input: {
    email: string;
    redirectTo: string;
    supabaseUrl: string;
    serviceRoleKey: string;
    inquiryId: string;
  }): Promise<AccountInvitationDelivery> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(
        `${input.supabaseUrl}/auth/v1/recover?redirect_to=${encodeURIComponent(input.redirectTo)}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            apikey: input.serviceRoleKey,
            Authorization: `Bearer ${input.serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: input.email }),
        },
      );

      if (response.ok) {
        return {
          status: 'PASSWORD_LINK_SENT',
          email: input.email,
          message: 'This email already had an account, so we sent a link to set a new password.',
        };
      }

      this.logger.error(
        `Supabase rejected the password link for inquiry ${input.inquiryId} with status ${response.status}.`,
      );
      return {
        status: 'FAILED',
        email: input.email,
        // Named specifically: a rate limit is the usual cause and it is worth retrying, which
        // "could not be sent" does not tell anybody.
        message:
          response.status === 429
            ? 'Too many emails have been sent recently. Wait a few minutes and resend the invitation.'
            : 'The inquiry was approved, but the set-password email could not be sent.',
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Password link failed for inquiry ${input.inquiryId}: ${reason}`);
      return {
        status: 'FAILED',
        email: input.email,
        message: 'The inquiry was approved, but the set-password email could not be sent.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
