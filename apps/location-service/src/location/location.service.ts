import { BadRequestException, Injectable } from '@nestjs/common';
import { TribeClient } from '@implementsprint/sdk';
import type { GeofencePayload, ResolveLocationPayload } from '@app/contracts';

@Injectable()
export class LocationService {
  constructor(private readonly tribeClient: TribeClient) {}

  async resolveLocation(
    payload: Partial<ResolveLocationPayload> = {},
  ): Promise<unknown> {
    if (
      typeof payload.latitude !== 'number' ||
      typeof payload.longitude !== 'number'
    ) {
      throw new BadRequestException('latitude and longitude are required');
    }

    const request: ResolveLocationPayload = {
      latitude: payload.latitude,
      longitude: payload.longitude,
    };
    if (payload.language !== undefined) {
      request.language = payload.language;
    }
    if (payload.resultType !== undefined) {
      request.resultType = payload.resultType;
    }
    if (payload.locationType !== undefined) {
      request.locationType = payload.locationType;
    }

    return this.tribeClient.geoReverseGeocode(request);
  }

  async checkGeofence(payload: GeofencePayload): Promise<unknown> {
    const request: GeofencePayload = {
      latitude: payload.latitude,
      longitude: payload.longitude,
    };
    if (payload.fenceId !== undefined) {
      request.fenceId = payload.fenceId;
    }

    return this.tribeClient.geoFenceCheck(request);
  }
}
