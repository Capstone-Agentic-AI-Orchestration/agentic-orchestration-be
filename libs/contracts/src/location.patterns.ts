export const LOCATION_PATTERNS = {
  resolve: 'location.resolve',
  geofence: 'location.geofence',
  health: 'location.health',
} as const;

export interface ResolveLocationPayload {
  latitude: number;
  longitude: number;
  language?: string;
  resultType?: string;
  locationType?: string;
}

export interface GeofencePayload {
  latitude: number;
  longitude: number;
  fenceId?: string;
}
