import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiCenterSdkModule } from '@app/api-center';
import { SupabaseModule } from '@app/supabase';
import { LocationModule } from './location/location.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),
    ApiCenterSdkModule,
    SupabaseModule,
    LocationModule,
  ],
})
export class LocationServiceAppModule {}
