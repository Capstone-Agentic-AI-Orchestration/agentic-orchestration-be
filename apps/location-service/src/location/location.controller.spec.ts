import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TribeClient } from '@implementsprint/sdk';
import { LocationController } from './location.controller';
import { LocationService } from './location.service';

describe('LocationController', () => {
  let controller: LocationController;
  let tribeClientMock: Partial<TribeClient>;

  beforeEach(async () => {
    tribeClientMock = {
      geoReverseGeocode: jest.fn().mockResolvedValue({
        formattedAddress: '123 Fake St, City, Country',
        latitude: 14.5995,
        longitude: 120.9842,
        provider: 'mock',
      }),
      geoFenceCheck: jest.fn().mockResolvedValue({
        inside: true,
        distanceDetails: [],
        provider: 'local',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LocationController],
      providers: [
        LocationService,
        {
          provide: TribeClient,
          useValue: tribeClientMock,
        },
      ],
    }).compile();

    controller = module.get<LocationController>(LocationController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('resolve', () => {
    it('should call geoReverseGeocode via service and return address info', async () => {
      const result = (await controller.resolve({
        latitude: 14.5995,
        longitude: 120.9842,
      })) as { formattedAddress: string };

      expect(result.formattedAddress).toBe('123 Fake St, City, Country');
      expect(tribeClientMock.geoReverseGeocode).toHaveBeenCalledWith({
        latitude: 14.5995,
        longitude: 120.9842,
      });
    });

    it('should reject missing coordinates', async () => {
      await expect(controller.resolve()).rejects.toThrow(
        'latitude and longitude are required',
      );

      expect(tribeClientMock.geoReverseGeocode).not.toHaveBeenCalled();
    });
  });

  describe('checkFence', () => {
    it('should call geoFenceCheck via service and return inside status', async () => {
      const result = (await controller.checkFence({
        latitude: 14.5995,
        longitude: 120.9842,
        fenceId: 'zone-alpha',
      })) as { inside: boolean };

      expect(result.inside).toBe(true);
      expect(tribeClientMock.geoFenceCheck).toHaveBeenCalledWith({
        latitude: 14.5995,
        longitude: 120.9842,
        fenceId: 'zone-alpha',
      });
    });

    it('should handle request without fenceId gracefully', async () => {
      await controller.checkFence({ latitude: 10, longitude: 20 });

      expect(tribeClientMock.geoFenceCheck).toHaveBeenCalledWith({
        latitude: 10,
        longitude: 20,
      });
    });
  });
});
