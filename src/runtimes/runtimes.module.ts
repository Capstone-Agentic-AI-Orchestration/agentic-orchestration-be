import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RuntimesController } from './runtimes.controller';
import { RuntimesService } from './runtimes.service';
import { SupabaseVaultService } from './supabase-vault.service';

/**
 * Personal cloud LLM provider credentials (API keys, stored in Supabase Vault).
 *
 * Local AI CLI detection used to live here too, probing the API host's own disk — which described
 * the server, never the user. That belongs to the companion daemon and now lives in
 * `RuntimeCompanionModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [RuntimesController],
  providers: [RuntimesService, SupabaseVaultService],
  exports: [RuntimesService, SupabaseVaultService],
})
export class RuntimesModule {}
