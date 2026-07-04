import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevelopersController } from './developers.controller';
import { DevelopersService } from './developers.service';

@Module({
  imports: [AuthModule],
  controllers: [DevelopersController],
  providers: [DevelopersService],
})
export class DevelopersModule {}
