import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { AuthUser, CurrentUser, Roles } from '../../common/decorators';

@Controller('api/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tasks.list(user);
  }

  /** 任务催办（方案 F6-10）：快到期 / 已过期但未完成的任务。 */
  @Get('reminders')
  reminders(@CurrentUser() user: AuthUser, @Query('withinHours') withinHours?: string) {
    return this.tasks.reminders(user, withinHours ? Number(withinHours) : undefined);
  }

  @Roles('admin', 'leader')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.tasks.create(user, body);
  }

  @Get(':id/report')
  report(@Param('id') id: string) {
    return this.tasks.report(Number(id));
  }

  @Roles('admin', 'leader')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tasks.remove(Number(id));
  }
}
