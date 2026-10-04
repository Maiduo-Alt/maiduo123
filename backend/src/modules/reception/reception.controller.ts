import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ReceptionService } from './reception.service';
import { AuthUser, CurrentUser } from '../../common/decorators';

@Controller('api/receptions')
export class ReceptionController {
  constructor(private readonly reception: ReceptionService) {}

  @Get('levels')
  levels(@CurrentUser() user: AuthUser) {
    return this.reception.unlockState(user.id);
  }

  /** 当前进行中的接待（断线 / 离开页面后可以找回来） */
  @Get('current')
  current(@CurrentUser() user: AuthUser) {
    return this.reception.current(user.id);
  }

  @Post()
  start(
    @CurrentUser() user: AuthUser,
    @Body() body: { level: string; source?: string; taskId?: number; totalCount?: number; concurrentCount?: number }
  ) {
    return this.reception.start(user, body);
  }

  @Get(':id/snapshot')
  snapshot(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reception.snapshot(user.id, Number(id));
  }

  @Get(':id/result')
  result(@Param('id') id: string) {
    return this.reception.attemptResult(Number(id));
  }

  @Post(':id/sessions/:sessionId/messages')
  sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { content: string }
  ) {
    return this.reception.sendMessage(user.id, Number(id), Number(sessionId), body.content);
  }

  @Post(':id/sessions/:sessionId/transfer')
  transfer(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('sessionId') sessionId: string) {
    return this.reception.transfer(user.id, Number(id), Number(sessionId));
  }

  /** 客户 2026-10-03：订单卡片上的平台侧操作在训练环境里记为一次业务动作（并发一句标准话术）。 */
  @Post(':id/sessions/:sessionId/actions')
  action(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { action: string }
  ) {
    return this.reception.recordBusinessAction(user.id, Number(id), Number(sessionId), body.action);
  }

  @Post(':id/sessions/:sessionId/finish')
  finishSession(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('sessionId') sessionId: string) {
    return this.reception.finishSession(user.id, Number(id), Number(sessionId));
  }

  @Post(':id/finish')
  finishAttempt(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reception.finishAttempt(user.id, Number(id));
  }
}
