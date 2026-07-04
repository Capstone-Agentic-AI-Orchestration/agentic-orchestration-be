import { Injectable } from '@nestjs/common';
import { ClientInviteStatus, NotificationType, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { IntakeRepository, type InviteView } from '../inquiries/intake.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { IntegrationEvents } from '../shared/events/integration-event';
import { OutboxService } from '../shared/events/outbox.service';
import {
  CursorPage,
  CursorPageInput,
  hasCursorPage,
  toCursorPage,
} from '../shared/pagination/cursor-pagination';

@Injectable()
export class ClientInvitesService {
  constructor(
    private readonly intakeRepository: IntakeRepository,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
  ) {}

  async publicStatus(email: string): Promise<{
    email: string;
    pending: number;
    accepted: number;
    latestCompanyName: string | null;
  }> {
    const normalizedEmail = email.trim().toLowerCase();
    const invites = await this.intakeRepository.findInvitesForStatus(normalizedEmail);

    return {
      email: normalizedEmail,
      pending: invites.filter((invite) => invite.status === ClientInviteStatus.PENDING).length,
      accepted: invites.filter((invite) => invite.status === ClientInviteStatus.ACCEPTED).length,
      latestCompanyName: invites[0]?.companyName ?? null,
    };
  }

  async listMine(
    user: AuthUser,
    page?: CursorPageInput,
  ): Promise<InviteView[] | CursorPage<InviteView>> {
    const invites = await this.intakeRepository.findInvitesForUser(user, page);

    return hasCursorPage(page) ? toCursorPage(invites, page) : invites;
  }

  async acceptMine(user: AuthUser): Promise<{ accepted: InviteView[] }> {
    if (!user.email) {
      return { accepted: [] };
    }

    const accepted = await this.acceptPendingForProfile({
      profileId: user.id,
      email: user.email,
      role: user.role,
    });

    return { accepted };
  }

  async acceptPendingForProfile(input: {
    profileId: string;
    email: string | null;
    role: UserRole;
  }): Promise<InviteView[]> {
    if (!input.email || input.role !== UserRole.CLIENT) {
      return [];
    }

    const normalizedEmail = input.email.trim().toLowerCase();

    const accepted = await this.intakeRepository.transaction(async (tx) => this.intakeRepository.acceptPendingInvites(
      tx,
      { profileId: input.profileId, email: normalizedEmail },
      (invite) => this.outbox.append(
        {
          eventType: IntegrationEvents.clientInviteAccepted,
          aggregateType: 'client_invite',
          aggregateId: invite.id,
          producer: 'intake',
          payload: {
            inviteId: invite.id,
            projectId: invite.projectId,
            profileId: input.profileId,
            email: normalizedEmail,
          },
          metadata: { actorId: input.profileId },
        },
        tx,
      ),
    ));

    for (const invite of accepted) {
      await this.notifications.notify({
        recipientIds: await this.notifications.projectManagers(invite.projectId),
        actorId: input.profileId,
        projectId: invite.projectId,
        type: NotificationType.CLIENT_INVITE_ACCEPTED,
        title: 'Client accepted invite',
        body: invite.companyName,
        metadata: { inviteId: invite.id, email: normalizedEmail },
      });
    }

    return accepted;
  }
}
