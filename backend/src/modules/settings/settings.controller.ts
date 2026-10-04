import { Body, Controller, Get, Put } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { AuthUser, CurrentUser, Roles } from '../../common/decorators';
import { SystemParams } from '../../domain/types';

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.getParams(false);
  }

  @Roles('admin')
  @Put()
  update(@Body() body: Partial<SystemParams>, @CurrentUser() user: AuthUser) {
    return this.settings.updateParams(body, user.id);
  }
}
