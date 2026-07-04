import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';

describe('ApiController', () => {
  let apiController: ApiController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [ApiService],
    }).compile();

    apiController = app.get<ApiController>(ApiController);
  });

  describe('root', () => {
    it('should return service info', () => {
      expect(apiController.getServiceInfo()).toEqual({
        service: 'tribe-backend',
        version: '1.0.0',
      });
    });
  });
});
