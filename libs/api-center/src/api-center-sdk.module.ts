import { Global, Module } from '@nestjs/common';
import { ConfigService, ConfigModule } from '@nestjs/config';
import { TribeClient } from '@implementsprint/sdk';
import { TribeRegistrationService } from './tribe-registration.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    TribeRegistrationService,
    {
      provide: TribeClient,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const gatewayUrl =
          configService.get<string>('API_CENTER_BASE_URL') ||
          configService.get<string>('APICENTER_URL');
        const tribeId =
          configService.get<string>('API_CENTER_TRIBE_ID') ||
          configService.get<string>('APICENTER_TRIBE_ID');
        const secret =
          configService.get<string>('API_CENTER_TRIBE_SECRET') ||
          configService.get<string>('APICENTER_TRIBE_SECRET');

        if (!gatewayUrl) {
          console.warn(
            'API_CENTER_BASE_URL is not set — ApiCenterSdkService will be unavailable',
          );
          return null;
        }

        if (!tribeId || !secret) {
          console.warn(
            'Tribe credentials missing — falling back to offline dummy mode if allowed',
          );
          return null;
        }

        const client = new TribeClient({
          gatewayUrl,
          tribeId,
          secret,
        });

        // Authenticate immediately to ensure connectivity
        await client.authenticate();

        return client;
      },
    },
  ],
  exports: [TribeClient],
})
export class ApiCenterSdkModule {}
