import { Injectable } from '@nestjs/common';

export interface ServiceInfo {
  service: string;
  version: string;
}

@Injectable()
export class ApiService {
  getServiceInfo(): ServiceInfo {
    return { service: 'tribe-backend', version: '1.0.0' };
  }
}
