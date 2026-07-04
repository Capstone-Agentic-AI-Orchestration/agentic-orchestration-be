import { Module } from '@nestjs/common';
import { DevFlowGateway } from './devflow.gateway';

@Module({
  providers: [DevFlowGateway],
  // Export so OrchestrationModule can inject DevFlowGateway into OrchestrationService
  exports: [DevFlowGateway],
})
export class GatewayModule {}
