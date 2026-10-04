import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser, AuthUser, Public } from '../../common/decorators';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: { username: string; password: string }) {
    return this.auth.login(body.username, body.password);
  }

  @Public()
  @Post('logout')
  logout() {
    return { success: true };
  }

  @Get('profile')
  profile(@CurrentUser() user: AuthUser) {
    return this.auth.profile(user.id);
  }

  @Put('profile')
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() body: { displayName?: string; mobile?: string; preference?: any }
  ) {
    return this.auth.updateProfile(user.id, body);
  }

  /** 续签登录令牌（方案 7.2） */
  @Post('refresh')
  refresh(@CurrentUser() user: AuthUser) {
    return this.auth.refresh(user.id);
  }

  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() body: { oldPassword: string; newPassword: string }
  ) {
    return this.auth.changePassword(user.id, body.oldPassword, body.newPassword);
  }
}
