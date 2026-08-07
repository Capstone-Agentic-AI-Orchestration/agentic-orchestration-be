import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../config/configuration';

@Injectable()
export class SupabaseVaultService {
  private readonly logger = new Logger(SupabaseVaultService.name);
  private client: SupabaseClient | null = null;

  private getClient(): SupabaseClient {
    if (!this.client) {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
      }
      this.client = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
    }
    return this.client;
  }

  async storeSecret(value: string, description?: string): Promise<string> {
    const client = this.getClient();
    try {
      const { data, error } = await client.rpc('vault.create_secret', {
        secret: value,
        name: description || `runtime-key-${Date.now()}`,
        description: description || 'Runtime provider API key',
      });

      if (error) {
        this.logger.error('Failed to store secret in vault:', error);
        throw new Error(`Vault store failed: ${error.message}`);
      }

      if (!data) {
        throw new Error('No secret ID returned from vault');
      }

      return data.id as string;
    } catch (error) {
      this.logger.error('Error storing secret:', error);
      throw error;
    }
  }

  async updateSecret(secretId: string, value: string): Promise<void> {
    const client = this.getClient();
    try {
      const { error } = await client.rpc('vault.update_secret', {
        id: secretId,
        secret: value,
      });

      if (error) {
        this.logger.error('Failed to update secret in vault:', error);
        throw new Error(`Vault update failed: ${error.message}`);
      }
    } catch (error) {
      this.logger.error('Error updating secret:', error);
      throw error;
    }
  }

  async deleteSecret(secretId: string): Promise<void> {
    const client = this.getClient();
    try {
      const { error } = await client.rpc('vault.delete_secret', {
        id: secretId,
      });

      if (error) {
        this.logger.error('Failed to delete secret from vault:', error);
        throw new Error(`Vault delete failed: ${error.message}`);
      }
    } catch (error) {
      this.logger.error('Error deleting secret:', error);
      throw error;
    }
  }

  async readSecret(secretId: string): Promise<string> {
    const client = this.getClient();
    try {
      const { data, error } = await client.rpc('vault.read_secret', {
        id: secretId,
      });

      if (error) {
        this.logger.error('Failed to read secret from vault:', error);
        throw new Error(`Vault read failed: ${error.message}`);
      }

      if (!data) {
        throw new Error('No secret returned from vault');
      }

      return data.secret as string;
    } catch (error) {
      this.logger.error('Error reading secret:', error);
      throw error;
    }
  }
}
