import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import {
  type GeofencePayload,
  LOCATION_PATTERNS,
  type ResolveLocationPayload,
} from '@app/contracts';
import { LocationService } from './location.service';

@Controller()
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  @MessagePattern(LOCATION_PATTERNS.resolve)
  async resolve(
    payload: Partial<ResolveLocationPayload> = {},
  ): Promise<unknown> {
    return this.locationService.resolveLocation(payload);
  }

  @MessagePattern(LOCATION_PATTERNS.geofence)
  async checkFence(payload: GeofencePayload): Promise<unknown> {
    return this.locationService.checkGeofence(payload);
  }
}
