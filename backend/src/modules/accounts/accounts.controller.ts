import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AuthUser, CurrentUser, Roles } from '../../common/decorators';

@Controller('api')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Roles('admin', 'leader')
  @Get('accounts')
  list(@Query() query: any) {
    return this.accounts.list(query);
  }

  /** 方案 4.4：直接为客服开放指定难度 */
  @Roles('admin', 'leader')
  @Post('accounts/:id/unlock-levels')
  grantLevels(@Param('id') id: string, @Body() body: { levels: string[] }, @CurrentUser() user: AuthUser) {
    return this.accounts.grantLevels(Number(id), body?.levels || [], user);
  }

  @Roles('admin')
  @Post('accounts')
  create(@Body() body: any) {
    return this.accounts.create(body);
  }

  @Roles('admin')
  @Put('accounts/:id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.accounts.update(Number(id), body);
  }

  @Roles('admin')
  @Post('accounts/:id/reset-password')
  resetPassword(@Param('id') id: string, @Body() body: { password: string }) {
    return this.accounts.resetPassword(Number(id), body.password);
  }

  /** 删除账号（客户 2026-10-10）：软删除，仅管理员 */
  @Roles('admin')
  @Delete('accounts/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.accounts.remove(Number(id), user.id);
  }

  @Get('groups')
  groups() {
    return this.accounts.listGroups();
  }

  @Roles('admin')
  @Post('groups')
  createGroup(@Body() body: { name: string }) {
    return this.accounts.createGroup(body.name);
  }

  @Roles('admin')
  @Put('groups/:id')
  updateGroup(@Param('id') id: string, @Body() body: { name?: string; status?: number }) {
    return this.accounts.updateGroup(Number(id), body);
  }

  @Get('accounts/me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
