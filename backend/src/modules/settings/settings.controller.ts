import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { AuthUser, CurrentUser, Roles } from '../../common/decorators';
import { SystemParams } from '../../domain/types';
import { ModelCredentialsService } from './model-credentials.service';
import { BizError, ERR } from '../../common/errors';

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService, private readonly credentials: ModelCredentialsService) {}

  @Get()
  get() {
    return this.settings.getParams(false);
  }

  @Roles('admin')
  @Get('model-status')
  modelStatus() {
    return this.credentials.status();
  }

  @Roles('admin')
  @Put('model-key')
  saveModelKey(@Body() body: { provider: string; secret: string }, @Req() req: any) {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https' && !req.secure) {
      throw new BizError(ERR.FORBIDDEN, '请使用 HTTPS 访问后配置 API Key');
    }
    return this.credentials.save(body.provider, body.secret);
  }

  @Roles('admin')
  @Put()
  update(@Body() body: Partial<SystemParams>, @CurrentUser() user: AuthUser) {
    return this.settings.updateParams(body, user.id);
  }
}
