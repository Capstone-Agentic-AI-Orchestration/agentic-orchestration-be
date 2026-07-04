import * as fs from 'node:fs';
import * as path from 'node:path';

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface TribeManifest {
  serviceId?: string;
  name?: string;
  baseUrl?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function parseTribeManifest(raw: unknown): TribeManifest {
  if (!isRecord(raw)) {
    return {};
  }

  const manifest: TribeManifest = { ...raw };
  const serviceId = readOptionalString(raw, 'serviceId');
  const name = readOptionalString(raw, 'name');
  const baseUrl = readOptionalString(raw, 'baseUrl');

  if (serviceId !== undefined) {
    manifest.serviceId = serviceId;
  }
  if (name !== undefined) {
    manifest.name = name;
  }
  if (baseUrl !== undefined) {
    manifest.baseUrl = baseUrl;
  }

  return manifest;
}

@Injectable()
export class TribeRegistrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger('TribeRegistration');

  constructor(private readonly configService: ConfigService) {}

  async onApplicationBootstrap(): Promise<void> {
    const apiCenterUrl = this.configService.get<string>('API_CENTER_BASE_URL');

    if (!apiCenterUrl) {
      this.logger.debug(
        'API_CENTER_BASE_URL not set — skipping auto-registration',
      );
      return;
    }

    const manifestPath = path.resolve(process.cwd(), 'tribe-manifest.json');
    const manifest = parseTribeManifest(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown,
    );

    const serviceId =
      this.configService.get<string>('TRIBE_SERVICE_ID') ??
      this.configService.get<string>('API_CENTER_TRIBE_ID') ??
      manifest.serviceId;

    const name = this.configService.get<string>('TRIBE_NAME') ?? manifest.name;
    const baseUrl =
      this.configService.get<string>('TRIBE_BASE_URL') ?? manifest.baseUrl;

    const payload = { ...manifest, serviceId, name, baseUrl };

    try {
      await axios.post(`${apiCenterUrl}/api/v1/registry/register`, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Platform-Secret':
            this.configService.get<string>('PLATFORM_ADMIN_SECRET') ?? '',
        },
      });
      this.logger.log(`registered as ${serviceId}`);
    } catch (error) {
      this.logger.warn(`failed to register: ${(error as Error).message}`);
    }
  }
}
