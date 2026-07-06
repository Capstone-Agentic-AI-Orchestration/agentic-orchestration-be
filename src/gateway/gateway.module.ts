import { Module } from '@nestjs/common';
import { DevFlowGateway } from './devflow.gateway';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  providers: [DevFlowGateway],
  // Export so OrchestrationModule can inject DevFlowGateway into OrchestrationService
  exports: [DevFlowGateway],
})
export class GatewayModule {}
