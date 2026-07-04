import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ApiService } from './api.service';

describe('ApiService', () => {
  let service: ApiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ApiService],
    }).compile();

    service = module.get<ApiService>(ApiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getServiceInfo', () => {
    it('returns the correct service name', () => {
      const info = service.getServiceInfo();
      expect(info.service).toBe('tribe-backend');
    });

    it('returns the correct version', () => {
      const info = service.getServiceInfo();
      expect(info.version).toBe('1.0.0');
    });

    it('returns an object with both service and version keys', () => {
      const info = service.getServiceInfo();
      expect(info).toEqual({ service: 'tribe-backend', version: '1.0.0' });
    });
  });
});
