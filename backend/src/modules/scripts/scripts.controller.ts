import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ScriptsService } from './scripts.service';
import { AuthUser, CurrentUser, Roles } from '../../common/decorators';

@Controller('api/scripts')
export class ScriptsController {
  constructor(private readonly scripts: ScriptsService) {}

  @Get()
  list(@Query() query: any) {
    return this.scripts.list(query);
  }

  /** 剧本统计（方案 F3-12）：被练次数、平均分、超时率与难点剧本排行。 */
  @Get('stats')
  stats(@Query('limit') limit?: string) {
    return this.scripts.stats(limit ? Number(limit) : undefined);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.scripts.detail(Number(id));
  }

  @Get(':id/preview')
  preview(@Param('id') id: string) {
    return this.scripts.detail(Number(id));
  }

  @Roles('admin', 'leader')
  @Post()
  create(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.scripts.create(body, user.id);
  }

  /** 按案例创建剧本（方案 F3-07）。 */
  @Roles('admin', 'leader')
  @Post('from-case')
  createFromCase(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.scripts.createFromCase(body, user.id);
  }

  @Roles('admin', 'leader')
  @Post('batch-generate')
  batchGenerate(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.scripts.batchGenerate(user.id, body);
  }

  /** 异步批量生成的任务进度（方案 7.2 / 5.7） */
  @Roles('admin', 'leader')
  @Get('batch-generate/tasks/:id')
  genTask(@Param('id') id: string) {
    return this.scripts.genTask(Number(id));
  }

  /** 取消异步批量生成任务，已生成剧本保留 */
  @Roles('admin', 'leader')
  @Post('batch-generate/tasks/:id/cancel')
  cancelGenTask(@Param('id') id: string) {
    return this.scripts.cancelGenTask(Number(id));
  }

  @Roles('admin', 'leader')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.scripts.update(Number(id), body);
  }

  @Roles('admin', 'leader')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.scripts.remove(Number(id));
  }
}
