import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupInvitationStatus,
  GroupLifecycleStatus,
  GroupMemberStatus,
  GroupRole,
  NotificationType,
  Prisma,
  ProfileStatus,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { GithubTeamsService } from '../github/github-teams.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateGroupDto,
  CreateGroupInvitationDto,
  TransferGroupDto,
  UpdateGroupDto,
  UpdateGroupMemberRoleDto,
} from './dto/groups.dto';

const MANAGER_ROLES: GroupRole[] = [GroupRole.LEAD, GroupRole.DELEGATED_LEAD];

const groupInclude = {
  owner: {
    select: {
      id: true,
      email: true,
      fullName: true,
      githubLogin: true,
      avatarUrl: true,
      role: true,
    },
  },
  members: {
    where: { status: GroupMemberStatus.ACTIVE },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
          githubLogin: true,
          avatarUrl: true,
          role: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  _count: {
    select: {
      projects: true,
      repositories: true,
      invitations: true,
    },
  },
} satisfies Prisma.GroupInclude;

export interface EligiblePerson {
  /** DevFlow profile id — null when the person has not signed into DevFlow yet. */
  id: string | null;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  githubLogin: string | null;
  avatarUrl: string | null;
  /** True when they have a DevFlow profile and can be invited directly. */
  onSystem: boolean;
}

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly githubTeams: GithubTeamsService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(dto: CreateGroupDto, user: AuthUser) {
    this.assertPersona(user);
    if (user.role !== UserRole.PM && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only project managers and admins can create groups');
    }

    const group = await this.prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          businessUnit: dto.businessUnit?.trim() || null,
          ownerId: user.id,
        },
      });
      await tx.groupMember.create({
        data: {
          groupId: created.id,
          userId: user.id,
          role: GroupRole.LEAD,
        },
      });
      await tx.groupActivityEvent.create({
        data: {
          groupId: created.id,
          actorId: user.id,
          eventCode: 'devflow.group.created',
          targetType: 'group',
          targetId: created.id,
          message: `Created group ${created.name}`,
        },
      });
      return created;
    });

    return this.get(group.id, user);
  }

  async list(user: AuthUser) {
    this.assertPersona(user);
    return this.prisma.group.findMany({
      where: user.role === UserRole.ADMIN
        ? undefined
        : {
            members: {
              some: { userId: user.id, status: GroupMemberStatus.ACTIVE },
            },
          },
      include: groupInclude,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async get(groupId: string, user: AuthUser) {
    await this.assertMember(groupId, user);
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: groupInclude,
    });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    return group;
  }

  async update(groupId: string, dto: UpdateGroupDto, user: AuthUser) {
    await this.assertManager(groupId, user);
    const group = await this.prisma.group.update({
      where: { id: groupId },
      data: {
        name: dto.name?.trim(),
        description: dto.description === undefined ? undefined : dto.description.trim() || null,
        businessUnit: dto.businessUnit === undefined ? undefined : dto.businessUnit.trim() || null,
      },
    }).catch(() => null);
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    await this.activity(groupId, user, 'devflow.group.updated', 'group', groupId, `Updated group ${group.name}`);
    return this.get(groupId, user);
  }

  async archive(groupId: string, user: AuthUser) {
    await this.assertManager(groupId, user);
    const group = await this.prisma.group.update({
      where: { id: groupId },
      data: { status: GroupLifecycleStatus.ARCHIVED },
    });
    await this.activity(groupId, user, 'devflow.group.archived', 'group', groupId, `Archived group ${group.name}`);
    return this.get(groupId, user);
  }

  async reopen(groupId: string, user: AuthUser) {
    await this.assertManager(groupId, user, true);
    const group = await this.prisma.group.update({
      where: { id: groupId },
      data: { status: GroupLifecycleStatus.ACTIVE },
    });
    await this.activity(groupId, user, 'devflow.group.reopened', 'group', groupId, `Reopened group ${group.name}`);
    return this.get(groupId, user);
  }

  async delete(groupId: string, user: AuthUser) {
    await this.assertLead(groupId, user);
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: { _count: { select: { projects: true, repositories: true } } },
    });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (group.status !== GroupLifecycleStatus.ARCHIVED) {
      throw new BadRequestException('Archive the group before deleting it');
    }
    if (group._count.projects > 0 || group._count.repositories > 0) {
      throw new ConflictException('Groups with projects or repositories cannot be deleted');
    }
    await this.prisma.group.delete({ where: { id: groupId } });
    return { deleted: true };
  }

  async transfer(groupId: string, dto: TransferGroupDto, user: AuthUser) {
    await this.assertLead(groupId, user);
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { ownerId: true, status: true },
    });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (group.status === GroupLifecycleStatus.ARCHIVED) throw new BadRequestException('Archived groups are read-only');
    if (dto.userId === group.ownerId) throw new BadRequestException('The selected user already leads this group');
    const target = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: dto.userId } },
      include: { user: { select: { role: true, fullName: true, email: true } } },
    });
    if (!target || target.status !== GroupMemberStatus.ACTIVE) {
      throw new BadRequestException('The new lead must be an active group member');
    }
    if (target.user.role !== UserRole.PM && user.role !== UserRole.ADMIN) {
      throw new BadRequestException('Group leadership can only be transferred to a project manager');
    }

    await this.prisma.$transaction([
      this.prisma.group.update({ where: { id: groupId }, data: { ownerId: dto.userId } }),
      this.prisma.groupMember.update({
        where: { groupId_userId: { groupId, userId: dto.userId } },
        data: { role: GroupRole.LEAD },
      }),
      this.prisma.groupMember.update({
        where: { groupId_userId: { groupId, userId: group.ownerId } },
        data: { role: GroupRole.DELEGATED_LEAD },
      }),
    ]);
    await this.activity(
      groupId,
      user,
      'devflow.group.lead_transferred',
      'profile',
      dto.userId,
      `Transferred group leadership to ${target.user.fullName ?? target.user.email ?? dto.userId}`,
    );
    return this.get(groupId, user);
  }

  async listMembers(groupId: string, user: AuthUser) {
    await this.assertMember(groupId, user);
    return this.prisma.groupMember.findMany({
      where: { groupId, status: GroupMemberStatus.ACTIVE },
      include: {
        user: {
          select: { id: true, email: true, fullName: true, role: true, githubLogin: true, avatarUrl: true },
        },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async eligibleUsers(groupId: string, user: AuthUser) {
    await this.assertManager(groupId, user);
    const members = await this.prisma.groupMember.findMany({
      where: { groupId, status: GroupMemberStatus.ACTIVE },
      select: { userId: true },
    });

    // DevFlow PM/DEV users already on the system — directly invitable.
    const profiles = await this.prisma.profile.findMany({
      where: {
        id: { notIn: members.map((member) => member.userId) },
        role: { in: [UserRole.PM, UserRole.DEV] },
        status: ProfileStatus.ACTIVE,
      },
      select: { id: true, email: true, fullName: true, role: true, githubLogin: true, avatarUrl: true },
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
      take: 200,
    });

    const onSystem: EligiblePerson[] = profiles.map((p) => ({
      id: p.id,
      email: p.email,
      fullName: p.fullName,
      role: p.role,
      githubLogin: p.githubLogin,
      avatarUrl: p.avatarUrl,
      onSystem: true,
    }));

    // GitHub org dev/PM roster — surface members who have NOT signed into DevFlow
    // yet so a PM can see them (shown as "not on the system", not yet invitable).
    const knownLogins = new Set(
      profiles
        .map((p) => p.githubLogin?.toLowerCase())
        .filter((login): login is string => Boolean(login)),
    );
    const roster = await this.githubTeams.listRoleTeamMembers();
    const notOnSystem: EligiblePerson[] = roster
      .filter((m) => !knownLogins.has(m.githubLogin.toLowerCase()))
      .map((m) => ({
        id: null,
        email: null,
        fullName: null,
        role: m.role,
        githubLogin: m.githubLogin,
        avatarUrl: m.avatarUrl,
        onSystem: false,
      }));

    return [...onSystem, ...notOnSystem];
  }

  async invite(groupId: string, dto: CreateGroupInvitationDto, user: AuthUser) {
    await this.assertManager(groupId, user);
    if (dto.role === GroupRole.LEAD) {
      throw new BadRequestException('Use leadership transfer to assign the LEAD role');
    }
    const target = await this.prisma.profile.findUnique({
      where: { id: dto.userId },
      select: { id: true, role: true, status: true, email: true, fullName: true },
    });
    if (!target || target.status !== ProfileStatus.ACTIVE) {
      throw new NotFoundException('Invitee not found');
    }
    if (target.role !== UserRole.PM && target.role !== UserRole.DEV) {
      throw new BadRequestException('Only project managers and developers can join internal groups');
    }
    const member = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: dto.userId } },
    });
    if (member?.status === GroupMemberStatus.ACTIVE) {
      throw new ConflictException('This user is already a group member');
    }

    const invitation = await this.prisma.groupInvitation.upsert({
      where: { groupId_invitedUserId: { groupId, invitedUserId: dto.userId } },
      update: {
        role: dto.role,
        status: GroupInvitationStatus.PENDING,
        invitedById: user.id,
        respondedAt: null,
      },
      create: {
        groupId,
        invitedUserId: dto.userId,
        invitedById: user.id,
        role: dto.role,
      },
      include: {
        invitedUser: { select: { id: true, email: true, fullName: true, role: true, githubLogin: true } },
        invitedBy: { select: { id: true, email: true, fullName: true } },
      },
    });
    await this.activity(
      groupId,
      user,
      'devflow.group.invitation_created',
      'profile',
      dto.userId,
      `Invited ${target.fullName ?? target.email ?? target.id} as ${dto.role}`,
    );

    // Push a system notification to the invited member (their bell + list).
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { name: true },
    });
    const inviterName =
      invitation.invitedBy.fullName ?? invitation.invitedBy.email ?? 'A project manager';
    await this.notifications.notify({
      recipientIds: [dto.userId],
      actorId: user.id,
      type: NotificationType.GROUP_INVITATION_SENT,
      title: `Invitation to join ${group?.name ?? 'a group'}`,
      body: `${inviterName} invited you to join as ${dto.role}.`,
      metadata: { groupId, invitationId: invitation.id, role: dto.role },
    });

    return invitation;
  }

  async listInvitations(groupId: string, user: AuthUser) {
    await this.assertManager(groupId, user);
    return this.prisma.groupInvitation.findMany({
      where: { groupId },
      include: {
        invitedUser: { select: { id: true, email: true, fullName: true, role: true, githubLogin: true, avatarUrl: true } },
        invitedBy: { select: { id: true, email: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  listMyInvitations(user: AuthUser) {
    this.assertPersona(user);
    return this.prisma.groupInvitation.findMany({
      where: { invitedUserId: user.id, status: GroupInvitationStatus.PENDING },
      include: {
        group: { select: { id: true, name: true, description: true, businessUnit: true } },
        invitedBy: { select: { id: true, email: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async respondToInvitation(invitationId: string, accept: boolean, user: AuthUser) {
    this.assertPersona(user);
    const invitation = await this.prisma.groupInvitation.findFirst({
      where: { id: invitationId, invitedUserId: user.id, status: GroupInvitationStatus.PENDING },
      include: { group: { select: { id: true, name: true, status: true } } },
    });
    if (!invitation) throw new NotFoundException('Pending invitation not found');
    if (invitation.group.status !== GroupLifecycleStatus.ACTIVE) {
      throw new BadRequestException('Archived groups cannot accept members');
    }

    if (accept) {
      await this.prisma.$transaction([
        this.prisma.groupMember.upsert({
          where: { groupId_userId: { groupId: invitation.groupId, userId: user.id } },
          update: { role: invitation.role, status: GroupMemberStatus.ACTIVE },
          create: { groupId: invitation.groupId, userId: user.id, role: invitation.role },
        }),
        this.prisma.groupInvitation.update({
          where: { id: invitation.id },
          data: { status: GroupInvitationStatus.ACCEPTED, respondedAt: new Date() },
        }),
      ]);
      await this.activity(invitation.groupId, user, 'devflow.group.invitation_accepted', 'profile', user.id, `Joined ${invitation.group.name}`);
      return { accepted: true, groupId: invitation.groupId };
    }

    await this.prisma.groupInvitation.update({
      where: { id: invitation.id },
      data: { status: GroupInvitationStatus.DECLINED, respondedAt: new Date() },
    });
    await this.activity(invitation.groupId, user, 'devflow.group.invitation_declined', 'profile', user.id, `Declined invitation to ${invitation.group.name}`);
    return { accepted: false, groupId: invitation.groupId };
  }

  async revokeInvitation(groupId: string, invitationId: string, user: AuthUser) {
    await this.assertManager(groupId, user);
    const invitation = await this.prisma.groupInvitation.findFirst({
      where: { id: invitationId, groupId, status: GroupInvitationStatus.PENDING },
    });
    if (!invitation) throw new NotFoundException('Pending invitation not found');
    await this.prisma.groupInvitation.update({
      where: { id: invitation.id },
      data: { status: GroupInvitationStatus.REVOKED, respondedAt: new Date() },
    });
    await this.activity(groupId, user, 'devflow.group.invitation_revoked', 'invitation', invitation.id, 'Revoked group invitation');
    return { revoked: true };
  }

  async updateMemberRole(groupId: string, userId: string, dto: UpdateGroupMemberRoleDto, user: AuthUser) {
    await this.assertManager(groupId, user);
    if (dto.role === GroupRole.LEAD) {
      throw new BadRequestException('Use leadership transfer to assign the LEAD role');
    }
    const group = await this.prisma.group.findUnique({ where: { id: groupId }, select: { ownerId: true } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (group.ownerId === userId) throw new BadRequestException('The group lead role cannot be changed here');
    const updated = await this.prisma.groupMember.update({
      where: { groupId_userId: { groupId, userId } },
      data: { role: dto.role },
    }).catch(() => null);
    if (!updated) throw new NotFoundException('Group member not found');
    await this.activity(groupId, user, 'devflow.group.member_role_changed', 'profile', userId, `Changed member role to ${dto.role}`);
    return updated;
  }

  async removeMember(groupId: string, userId: string, user: AuthUser) {
    await this.assertManager(groupId, user);
    const group = await this.prisma.group.findUnique({ where: { id: groupId }, select: { ownerId: true } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (group.ownerId === userId) throw new BadRequestException('Transfer leadership before removing the group lead');
    const activeAssignment = await this.prisma.repositoryAssignment.findFirst({
      where: {
        userId,
        desiredState: 'ASSIGNED',
        repository: { groupId },
      },
      select: { id: true },
    });
    if (activeAssignment) {
      throw new BadRequestException('Revoke this member’s repository assignments before removing them from the group');
    }
    const member = await this.prisma.groupMember.update({
      where: { groupId_userId: { groupId, userId } },
      data: { status: GroupMemberStatus.REMOVED },
    }).catch(() => null);
    if (!member) throw new NotFoundException('Group member not found');
    await this.activity(groupId, user, 'devflow.group.member_removed', 'profile', userId, 'Removed member from group');
    return { removed: true };
  }

  async activityFeed(groupId: string, user: AuthUser) {
    await this.assertMember(groupId, user);
    return this.prisma.groupActivityEvent.findMany({
      where: { groupId },
      include: { actor: { select: { id: true, email: true, fullName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async assertMember(groupId: string, user: AuthUser) {
    this.assertPersona(user);
    const group = await this.prisma.group.findUnique({ where: { id: groupId }, select: { id: true } });
    if (!group) throw new NotFoundException(`Group ${groupId} not found`);
    if (user.role === UserRole.ADMIN) return { role: GroupRole.LEAD };
    const member = await this.prisma.groupMember.findFirst({
      where: { groupId, userId: user.id, status: GroupMemberStatus.ACTIVE },
      select: { role: true },
    });
    if (!member) throw new NotFoundException(`Group ${groupId} not found`);
    return member;
  }

  async assertManager(groupId: string, user: AuthUser, allowArchived = false) {
    const member = await this.assertMember(groupId, user);
    if (user.role !== UserRole.ADMIN && !MANAGER_ROLES.includes(member.role)) {
      throw new ForbiddenException('Group manager access is required');
    }
    const group = await this.prisma.group.findUnique({ where: { id: groupId }, select: { status: true } });
    if (!allowArchived && group?.status === GroupLifecycleStatus.ARCHIVED) {
      throw new BadRequestException('Archived groups are read-only');
    }
    return member;
  }

  private async assertLead(groupId: string, user: AuthUser) {
    const member = await this.assertMember(groupId, user);
    if (user.role !== UserRole.ADMIN && member.role !== GroupRole.LEAD) {
      throw new ForbiddenException('Group lead access is required');
    }
  }

  private assertPersona(user: AuthUser) {
    if (user.role !== UserRole.PM && user.role !== UserRole.DEV && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Groups are only available to project managers and developers');
    }
  }

  private async activity(
    groupId: string,
    user: AuthUser,
    eventCode: string,
    targetType: string,
    targetId: string | null,
    message: string,
    metadata: Prisma.InputJsonValue = {},
  ) {
    await this.prisma.groupActivityEvent.create({
      data: { groupId, actorId: user.id, eventCode, targetType, targetId, message, metadata },
    });
  }
}
