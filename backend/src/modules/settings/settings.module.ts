import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { ModelCredentialsService } from './model-credentials.service';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, ModelCredentialsService],
  exports: [SettingsService, ModelCredentialsService],
})
export class SettingsModule {}
