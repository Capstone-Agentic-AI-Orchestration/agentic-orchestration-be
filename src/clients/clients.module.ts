import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ClientsController],
  providers: [ClientsService],
  // Exported so the inquiry approval flow can resolve or create the client a lead belongs to.
  exports: [ClientsService],
})
export class ClientsModule {}
