import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GroupsModule } from '../groups/groups.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { EveRuntimeCatalogService } from './eve-runtime-catalog.service';

@Module({
  // GroupsModule supplies assertMember, the one definition of workspace membership.
  imports: [PrismaModule, AuthModule, GroupsModule],
  controllers: [AgentsController],
  providers: [AgentsService, EveRuntimeCatalogService],
  // Exported so the orchestration nodes can resolve an agent's effective system prompt at
  // dispatch. Without that export the Instructions field would only describe the agent.
  exports: [AgentsService],
})
export class AgentsModule {}
