import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './config/env.schema';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { OrchestrationModule } from './orchestration/orchestration.module';
import { GithubModule } from './github/github.module';
import { SupervisorModule } from './supervisor/supervisor.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { GatewayModule } from './gateway/gateway.module';
import { ProfilesModule } from './profiles/profiles.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { ClientInvitesModule } from './client-invites/client-invites.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { ScheduleModule as DevFlowScheduleModule } from './schedule/schedule.module';
import { ReportsModule } from './reports/reports.module';
import { DevelopersModule } from './developers/developers.module';
import { SharedKernelModule } from './shared/shared-kernel.module';
import { HealthModule } from './health/health.module';
import { ContextMemoryModule } from './context-memory/context-memory.module';
import { IntakeModule } from './intake/intake.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // ScheduleModule must be initialized at the root so all @Interval and
    // @Cron decorators in child modules (SupervisorModule) are picked up.
    ScheduleModule.forRoot(),
    SharedKernelModule,
    PrismaModule,
    HealthModule,
    ContextMemoryModule,
    AuthModule,
    GithubModule,
    // Phase 2E — WebSocket gateway (must be before OrchestrationModule so
    // GatewayModule is available for injection into OrchestrationService)
    GatewayModule,
    OrchestrationModule,
    SupervisorModule,
    ProjectsModule,
    ProfilesModule,
    NotificationsModule,
    CollaborationModule,
    InquiriesModule,
    IntakeModule,
    ClientInvitesModule,
    AdminModule,
    DevFlowScheduleModule,
    ReportsModule,
    DevelopersModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
