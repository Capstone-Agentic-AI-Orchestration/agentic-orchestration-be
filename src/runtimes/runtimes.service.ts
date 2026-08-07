import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiRuntimeProvider } from '@prisma/client';
import { SupabaseVaultService } from './supabase-vault.service';
import { CreateRuntimeProviderDto, UpdateRuntimeProviderDto, RuntimeProviderResponseDto } from './dto/runtimes.dto';

@Injectable()
export class RuntimesService {
  private readonly logger = new Logger(RuntimesService.name);

  constructor(
    private prisma: PrismaService,
    private vault: SupabaseVaultService,
  ) {}

  async listProviders(userId: string): Promise<RuntimeProviderResponseDto[]> {
    const providers = await this.prisma.aiRuntimeProvider.findMany({
      where: { createdById: userId },
      orderBy: { createdAt: 'desc' },
    });

    return providers.map((p: AiRuntimeProvider) => ({
      id: p.id,
      provider: p.provider,
      label: p.label,
      baseUrl: p.baseUrl || undefined,
      model: p.model || undefined,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  async createProvider(
    dto: CreateRuntimeProviderDto,
    createdById?: string,
  ): Promise<RuntimeProviderResponseDto> {
    let vaultSecretId: string | null = null;

    try {
      // Store API key in Supabase Vault
      if (dto.apiKey) {
        vaultSecretId = await this.vault.storeSecret(
          dto.apiKey,
          `${dto.provider}-${dto.label}`,
        );
      }

      const provider = await this.prisma.aiRuntimeProvider.create({
        data: {
          provider: dto.provider,
          label: dto.label,
          baseUrl: dto.baseUrl,
          model: dto.model,
          vaultSecretId: vaultSecretId ? vaultSecretId : null,
          status: 'unknown',
          createdById: createdById ? createdById : null,
        },
      });

      return {
        id: provider.id,
        provider: provider.provider,
        label: provider.label,
        baseUrl: provider.baseUrl || undefined,
        model: provider.model || undefined,
        status: provider.status,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      };
    } catch (error) {
      // Clean up vault secret if provider creation fails
      if (vaultSecretId) {
        try {
          await this.vault.deleteSecret(vaultSecretId);
        } catch (deleteError) {
          this.logger.error('Failed to clean up vault secret on error:', deleteError);
        }
      }
      throw error;
    }
  }

  async updateProvider(
    id: string,
    dto: UpdateRuntimeProviderDto,
    userId: string,
  ): Promise<RuntimeProviderResponseDto> {
    const existing = await this.prisma.aiRuntimeProvider.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Provider not found`);
    }
    if (existing.createdById !== userId) {
      throw new ForbiddenException('You do not own this provider');
    }

    let newVaultSecretId = existing.vaultSecretId;

    try {
      // If updating the API key, store new key and delete old one
      if (dto.apiKey && dto.apiKey !== '') {
        newVaultSecretId = await this.vault.storeSecret(
          dto.apiKey,
          `${existing.provider}-${dto.label || existing.label}`,
        );

        if (existing.vaultSecretId) {
          try {
            await this.vault.deleteSecret(existing.vaultSecretId);
          } catch (error) {
            this.logger.error('Failed to delete old vault secret:', error);
          }
        }
      }

      const provider = await this.prisma.aiRuntimeProvider.update({
        where: { id },
        data: {
          label: dto.label !== undefined ? dto.label : existing.label,
          baseUrl: dto.baseUrl !== undefined ? dto.baseUrl : existing.baseUrl,
          model: dto.model !== undefined ? dto.model : existing.model,
          vaultSecretId: newVaultSecretId,
        },
      });

      return {
        id: provider.id,
        provider: provider.provider,
        label: provider.label,
        baseUrl: provider.baseUrl || undefined,
        model: provider.model || undefined,
        status: provider.status,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      };
    } catch (error) {
      // Clean up new vault secret if update fails
      if (newVaultSecretId && newVaultSecretId !== existing.vaultSecretId) {
        try {
          await this.vault.deleteSecret(newVaultSecretId);
        } catch (deleteError) {
          this.logger.error('Failed to clean up new vault secret on error:', deleteError);
        }
      }
      throw error;
    }
  }

  async deleteProvider(id: string, userId: string): Promise<void> {
    const provider = await this.prisma.aiRuntimeProvider.findUnique({ where: { id } });
    if (!provider) {
      throw new NotFoundException(`Provider not found`);
    }
    if (provider.createdById !== userId) {
      throw new ForbiddenException('You do not own this provider');
    }

    // Delete vault secret
    if (provider.vaultSecretId) {
      try {
        await this.vault.deleteSecret(provider.vaultSecretId);
      } catch (error) {
        this.logger.error('Failed to delete vault secret:', error);
      }
    }

    // Delete provider record
    await this.prisma.aiRuntimeProvider.delete({ where: { id } });
  }

  async testProvider(id: string, userId: string): Promise<{ ok: boolean; error?: string }> {
    const provider = await this.prisma.aiRuntimeProvider.findUnique({ where: { id } });
    if (!provider) {
      return { ok: false, error: 'Provider not found' };
    }
    if (provider.createdById !== userId) {
      return { ok: false, error: 'You do not own this provider' };
    }

    if (!provider.vaultSecretId) {
      return { ok: false, error: 'No API key configured' };
    }

    try {
      const apiKey = await this.vault.readSecret(provider.vaultSecretId);

      // Simple connectivity test — just verify the key exists for now
      // In the future, this would do a real health check to the provider
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Test failed' };
    }
  }
}
