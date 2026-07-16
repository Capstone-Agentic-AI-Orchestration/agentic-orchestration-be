import { Body, Controller, Get, Headers, HttpStatus, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsInt, IsString, Min } from 'class-validator';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { GithubService } from './github.service';
import { GroupsService } from '../groups/groups.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { executeIdempotentCommand } from '../shared/idempotency/idempotent-command';

class LinkGithubInstallationDto {
  @IsString()
  groupId!: string;

  @IsInt()
  @Min(1)
  installationId!: number;
}

@Controller('github')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(UserRole.PM, UserRole.DEV, UserRole.ADMIN)
export class GithubController {
  constructor(
    private readonly github: GithubService,
    private readonly groups: GroupsService,
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('status')
  status() {
    return {
      ...this.github.getDeliveryStatus(),
      installUrl: this.github.getInstallUrl(),
      provisioningMode: 'plain-repository',
      ciCdConfigured: false,
    };
  }

  @Get('verify')
  verify() {
    return this.github.verifyDeliveryAccess();
  }

  @Get('app/install-url')
  installUrl() {
    return { url: this.github.getInstallUrl() };
  }

  @Get('repositories')
  repositories() {
    return this.github.listVisibleRepositories();
  }

  @Get('installations/repos')
  installationRepositories() {
    return this.github.listVisibleRepositories();
  }

  @Get('installations/accounts')
  installationAccounts() {
    const status = this.github.getDeliveryStatus();
    return [{
      installationId: this.github.getConfiguredInstallationId(),
      accountLogin: status.owner,
      configured: status.configured,
    }];
  }

  @Post('installations')
  @Roles(UserRole.PM, UserRole.ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  linkInstallation(
    @Body() dto: LinkGithubInstallationDto,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return executeIdempotentCommand({
      idempotency: this.idempotency,
      idempotencyKey,
      scope: `user:${user.id}:POST:/github/installations`,
      requestPayload: dto,
      responseStatus: HttpStatus.CREATED,
      handler: () => this.linkInstallationCommand(dto, user),
    });
  }

  private async linkInstallationCommand(dto: LinkGithubInstallationDto, user: AuthUser) {
    await this.groups.assertManager(dto.groupId, user);
    const installation = await this.github.verifyInstallation(dto.installationId);
    await this.prisma.group.update({
      where: { id: dto.groupId },
      data: { githubInstallationId: String(dto.installationId) },
    });
    await this.prisma.groupActivityEvent.create({
      data: {
        groupId: dto.groupId,
        actorId: user.id,
        eventCode: 'devflow.github.installation_linked',
        targetType: 'github_installation',
        targetId: String(dto.installationId),
        message: `Linked GitHub installation for ${installation.accountLogin ?? 'configured account'}`,
        metadata: installation,
      },
    });
    return installation;
  }
}
