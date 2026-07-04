import { Controller, Get } from '@nestjs/common';
import { ApiService, type ServiceInfo } from './api.service';

@Controller()
export class ApiController {
  constructor(private readonly apiService: ApiService) {}

  @Get()
  getServiceInfo(): ServiceInfo {
    return this.apiService.getServiceInfo();
  }
}
