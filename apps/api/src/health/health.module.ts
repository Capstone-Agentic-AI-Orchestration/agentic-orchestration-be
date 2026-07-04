import { Module } from '@nestjs/common';
import { ApiCenterSdkModule } from '@app/api-center';
import { SupabaseModule } from '@app/supabase';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [SupabaseModule, ApiCenterSdkModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
