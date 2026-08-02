import { Injectable, Logger } from '@nestjs/common';

export type AccountInvitationDeliveryStatus = 'SENT' | 'EXISTING_ACCOUNT' | 'FAILED';

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

      const responseBody = await response.text().catch(() => '');
      if (
        response.status === 422 &&
        /already (been )?registered|already exists|user.*exists/i.test(responseBody)
      ) {
        return {
          status: 'EXISTING_ACCOUNT',
          email,
          message: 'This email already has a Supabase account and can sign in directly.',
        };
      }

      this.logger.error(
        `Supabase rejected the client invitation for inquiry ${input.inquiryId} with status ${response.status}.`,
      );
      return {
        status: 'FAILED',
        email,
        message: 'The inquiry was approved, but the account email could not be sent.',
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
}
