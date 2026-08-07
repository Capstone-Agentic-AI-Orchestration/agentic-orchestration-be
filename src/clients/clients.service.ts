import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientStatus, Prisma, ProjectStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { isPlaceholderClientName, resolveClientNameForInquiry } from './client-name';
import {
  AddClientContactDto,
  CreateClientDto,
  UpdateClientDto,
} from './dto/client.dto';

const profileSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
} satisfies Prisma.ProfileSelect;

const clientProjectSelect = {
  id: true,
  companyName: true,
  status: true,
  stackKey: true,
  repoUrl: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

/**
 * Client directory for the PM console.
 *
 * A client is an external company; Group is the internal delivery team. The two are deliberately
 * separate models and must not be conflated in permissions or naming.
 */
@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param groupId Active team workspace. Omit to list across every workspace (admin views).
   *
   * A client belongs to the team that delivers for it. Listing every company in every workspace
   * made the switcher a lie and let a client card report projects the caller could not open.
   *
   * The `OR groupId IS NULL` clause that used to live here is gone: the column is NOT NULL now,
   * so the unassigned state it existed to surface can no longer be created.
   */
  async list(search?: string, groupId?: string) {
    const filters: Prisma.ClientWhereInput[] = [];
    if (search?.trim()) {
      filters.push({ name: { contains: search.trim(), mode: 'insensitive' } });
    }
    if (groupId) {
      filters.push({ groupId });
    }
    const where: Prisma.ClientWhereInput = filters.length ? { AND: filters } : {};

    // The client-less project count used to be returned here. Project.clientId is now non-null,
    // so that query no longer type-checks and could only ever have returned zero — the state it
    // counted cannot be created.
    const clients = await this.prisma.client.findMany({
      where,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { contacts: true } },
        projects: {
          select: { updatedAt: true, status: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    return {
      clients: clients.map((client) => ({
        id: client.id,
        name: client.name,
        status: client.status,
        primaryContactName: client.primaryContactName,
        primaryContactEmail: client.primaryContactEmail,
        groupId: client.groupId,
        // A discovery space is not a project. Approving an inquiry creates one so the client has
        // somewhere to be invited and to upload documents into — counting it as delivery work
        // makes a client you are only talking to read as one you are building for.
        projectCount: client.projects.filter((p) => p.status !== ProjectStatus.DISCOVERY).length,
        discoveryCount: client.projects.filter((p) => p.status === ProjectStatus.DISCOVERY).length,
        contactCount: client._count.contacts,
        lastProjectActivityAt: client.projects[0]?.updatedAt ?? null,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      })),
    };
  }

  async findOne(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        createdBy: { select: profileSelect },
        _count: { select: { projects: true, contacts: true } },
      },
    });
    if (!client) throw new NotFoundException(`Client ${id} not found`);
    return client;
  }

  async create(user: AuthUser, dto: CreateClientDto) {
    const name = dto.name.trim();
    await this.assertNameAvailable(name);

    const client = await this.prisma.client.create({
      data: {
        name,
        groupId: dto.groupId,
        status: dto.status ?? ClientStatus.ACTIVE,
        primaryContactName: dto.primaryContactName?.trim() || null,
        primaryContactEmail: dto.primaryContactEmail?.trim().toLowerCase() || null,
        notes: dto.notes?.trim() || null,
        createdById: user.id,
      },
    });

    this.logger.log(`Created client ${client.id} (${client.name})`);
    return client;
  }

  async update(id: string, dto: UpdateClientDto) {
    const existing = await this.findOne(id);
    if (dto.name && dto.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNameAvailable(dto.name.trim());
    }

    return this.prisma.client.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        // Moving a client to another workspace is allowed; clearing it is not. An empty string
        // is therefore ignored rather than mapped to null, which the column now forbids.
        ...(dto.groupId ? { groupId: dto.groupId } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.primaryContactName !== undefined
          ? { primaryContactName: dto.primaryContactName.trim() || null }
          : {}),
        ...(dto.primaryContactEmail !== undefined
          ? { primaryContactEmail: dto.primaryContactEmail.trim().toLowerCase() || null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes.trim() || null } : {}),
      },
    });
  }

  async findProjects(id: string) {
    await this.findOne(id);
    return this.prisma.project.findMany({
      where: { clientId: id },
      select: clientProjectSelect,
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Every document across the client's projects, grouped by project.
   *
   * A rollup rather than client-owned storage: documents stay attached to the project whose
   * intake they belong to, so nothing changes about what the orchestration agents read.
   */
  async findDocuments(id: string) {
    await this.findOne(id);

    const projects = await this.prisma.project.findMany({
      where: { clientId: id },
      select: {
        id: true,
        companyName: true,
        collaborationDocuments: {
          include: {
            uploadedBy: { select: profileSelect },
            extraction: { select: { status: true, error: true, attempts: true, updatedAt: true } },
          },
          orderBy: { updatedAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const groups = projects
      .filter((project) => project.collaborationDocuments.length > 0)
      .map((project) => ({
        projectId: project.id,
        projectName: project.companyName,
        documents: project.collaborationDocuments,
      }));

    const all = groups.flatMap((group) => group.documents);
    return {
      groups,
      totals: {
        documents: all.length,
        // Only extracted text reaches the agents, so report that separately from raw counts.
        readable: all.filter((document) => document.extraction?.status === 'READY').length,
        files: all.filter((document) => document.fileName || document.extraction).length,
      },
    };
  }

  /**
   * Contacts, each annotated with the projects they can actually open.
   *
   * Being a contact is a directory fact and grants nothing on its own — access comes from
   * ProjectMember. Returning the real reachable set keeps the console from implying otherwise.
   */
  async findContacts(id: string) {
    await this.findOne(id);

    const [contacts, clientProjects] = await Promise.all([
      this.prisma.clientContact.findMany({
        where: { clientId: id },
        include: { profile: { select: profileSelect } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.project.findMany({ where: { clientId: id }, select: { id: true, companyName: true } }),
    ]);

    if (contacts.length === 0) return [];

    const memberships = await this.prisma.projectMember.findMany({
      where: {
        projectId: { in: clientProjects.map((project) => project.id) },
        userId: { in: contacts.map((contact) => contact.profileId) },
      },
      select: { projectId: true, userId: true },
    });

    const projectNameById = new Map(clientProjects.map((project) => [project.id, project.companyName]));

    return contacts.map((contact) => {
      const accessible = memberships
        .filter((membership) => membership.userId === contact.profileId)
        .map((membership) => ({
          id: membership.projectId,
          name: projectNameById.get(membership.projectId) ?? membership.projectId,
        }));

      return {
        id: contact.id,
        clientId: contact.clientId,
        profileId: contact.profileId,
        isPrimary: contact.isPrimary,
        createdAt: contact.createdAt,
        profile: contact.profile,
        accessibleProjects: accessible,
        // Explicit so the UI never has to infer "listed here" as "can sign in and see things".
        hasProjectAccess: accessible.length > 0,
      };
    });
  }

  async addContact(id: string, dto: AddClientContactDto) {
    await this.findOne(id);

    const profile = await this.prisma.profile.findUnique({
      where: { id: dto.profileId },
      select: { id: true, role: true },
    });
    if (!profile) throw new NotFoundException(`Profile ${dto.profileId} not found`);

    const existing = await this.prisma.clientContact.findUnique({
      where: { clientId_profileId: { clientId: id, profileId: dto.profileId } },
      select: { id: true },
    });
    if (existing) throw new ConflictException('That person is already a contact for this client');

    if (dto.isPrimary) await this.clearPrimaryContact(id);

    return this.prisma.clientContact.create({
      data: { clientId: id, profileId: dto.profileId, isPrimary: Boolean(dto.isPrimary) },
      include: { profile: { select: profileSelect } },
    });
  }

  async removeContact(id: string, contactId: string) {
    const contact = await this.prisma.clientContact.findFirst({
      where: { id: contactId, clientId: id },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException(`Contact ${contactId} not found for this client`);

    await this.prisma.clientContact.delete({ where: { id: contactId } });
    return { removed: true };
  }

  /**
   * Links a project to a client, or clears the link when `clientId` is null.
   *
   * Unlinking is allowed on purpose: a project without a client is a supported (if flagged)
   * state, so a mistaken link must be reversible without touching the database by hand.
   */
  /**
   * Moves a project to a different client.
   *
   * This used to accept `null` to unlink, which is the one thing it must not do now: a project
   * exists for a client, so clearing the link would recreate the orphan state the schema forbids
   * and surface as a raw not-null violation instead of something a PM can act on. Reassignment
   * is still allowed — a project attached to the wrong client is a mistake worth correcting.
   */
  async setProjectClient(projectId: string, clientId: string | null) {
    if (!clientId) {
      throw new BadRequestException(
        'A project must belong to a client. Move it to a different client instead of clearing it.',
      );
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, companyName: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    await this.findOne(clientId);

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { clientId },
      select: { id: true, clientId: true, companyName: true },
    });

    this.logger.log(`Linked project ${projectId} to client ${clientId}`);
    return updated;
  }

  /**
   * Suggests existing clients for an inbound inquiry so a repeat customer attaches to the client
   * they already have instead of quietly becoming a second one.
   *
   * Matching is a suggestion only — the PM confirms it. Silent auto-merge would be worse than a
   * duplicate, because merging two real clients back apart is far harder than linking them.
   */
  async suggestForInquiry(input: { companyName: string; email?: string | null }) {
    const name = input.companyName.trim();
    const domain = input.email?.trim().toLowerCase().split('@')[1];
    // A placeholder company must not become a client name, so tell the console up front and
    // offer the best derivable alternative for it to prefill.
    const companyNameIsPlaceholder = isPlaceholderClientName(name);
    const suggestedName = resolveClientNameForInquiry({
      companyName: name,
      email: input.email,
    });

    const [byName, byDomain] = await Promise.all([
      this.prisma.client.findMany({
        where: { name: { contains: name, mode: 'insensitive' } },
        select: { id: true, name: true, status: true },
        take: 5,
      }),
      domain
        ? this.prisma.client.findMany({
            where: { primaryContactEmail: { endsWith: `@${domain}`, mode: 'insensitive' } },
            select: { id: true, name: true, status: true },
            take: 5,
          })
        : Promise.resolve([]),
    ]);

    const seen = new Set<string>();
    const suggestions: Array<{ id: string; name: string; status: ClientStatus; reason: string }> = [];
    // Name matching is meaningless for a placeholder — "TBD" would fuzzy-match nothing useful,
    // and worse, would match a previously created "TBD" client.
    if (!companyNameIsPlaceholder) {
      for (const client of byName) {
        if (seen.has(client.id)) continue;
        seen.add(client.id);
        suggestions.push({ ...client, reason: 'Similar company name' });
      }
    }
    for (const client of byDomain) {
      if (seen.has(client.id)) continue;
      seen.add(client.id);
      suggestions.push({ ...client, reason: `Shares the ${domain} email domain` });
    }

    return { suggestions, suggestedName, companyNameIsPlaceholder };
  }

  /**
   * Resolves an existing client by exact (case-insensitive) name, or creates one.
   *
   * `groupId` is required rather than optional: a client with no workspace is invisible to the
   * switcher and its projects have nobody to belong to, and the column is NOT NULL. Currently
   * unreferenced — kept because the intake flow reaches for this shape, and made correct so it
   * cannot reintroduce the orphan state if it is ever wired up.
   */
  async findOrCreateByName(
    name: string,
    groupId: string,
    actorId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; created: boolean }> {
    const client = tx ?? this.prisma;
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('A client name is required');

    const existing = await client.client.findFirst({
      where: { name: { equals: trimmed, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };

    const created = await client.client.create({
      data: { name: trimmed, groupId, status: ClientStatus.ACTIVE, createdById: actorId },
      select: { id: true },
    });
    return { id: created.id, created: true };
  }

  /** Staff eligible to be listed as a client contact. */
  searchContactCandidates(search?: string) {
    const term = search?.trim();
    return this.prisma.profile.findMany({
      where: {
        role: UserRole.CLIENT,
        ...(term
          ? {
              OR: [
                { email: { contains: term, mode: 'insensitive' } },
                { fullName: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: profileSelect,
      orderBy: { email: 'asc' },
      take: 20,
    });
  }

  private async assertNameAvailable(name: string) {
    const clash = await this.prisma.client.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (clash) {
      throw new ConflictException(`A client named "${clash.name}" already exists`);
    }
  }

  private async clearPrimaryContact(clientId: string) {
    await this.prisma.clientContact.updateMany({
      where: { clientId, isPrimary: true },
      data: { isPrimary: false },
    });
  }
}
