import { Inject, Injectable, Optional } from '@nestjs/common';
import { TribeClient } from '@implementsprint/sdk';
import { SupabaseService } from '@app/supabase';

export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface HealthChecks {
  database: boolean;
  apiCenter: boolean;
}

export interface HealthResponse {
  status: HealthStatus;
  uptimeSeconds: number;
  checks: HealthChecks;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly supabaseService: SupabaseService,
    @Optional()
    @Inject(TribeClient)
    private readonly tribeClient: TribeClient | null,
  ) {}

  async getStatus(): Promise<HealthResponse> {
    const [dbResult] = await Promise.allSettled([this.supabaseService.ping()]);

    const database = dbResult.status === 'fulfilled' ? dbResult.value : false;
    const apiCenter = !!this.tribeClient; // Consider pinging a gateway `/health` endpoint if added to SDK later

    const passCount = (database ? 1 : 0) + (apiCenter ? 1 : 0);

    let status: HealthStatus;
    if (passCount === 2) {
      status = 'ok';
    } else if (passCount === 1) {
      status = 'degraded';
    } else {
      status = 'error';
    }

    return {
      status,
      uptimeSeconds: Math.floor(process.uptime()),
      checks: { database, apiCenter },
    };
  }
}
