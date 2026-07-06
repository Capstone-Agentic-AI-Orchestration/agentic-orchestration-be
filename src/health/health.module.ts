import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [GithubModule],
  controllers: [HealthController],
})
export class HealthModule {}
