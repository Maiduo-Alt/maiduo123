import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { RecordsService } from './records.service';
import { AuthUser, CurrentUser } from '../../common/decorators';

@Controller('api/records')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.records.list(user, query);
  }

  @Get('overview')
  overview(@CurrentUser() user: AuthUser) {
    return this.records.overview(user);
  }

  /** 个人成长曲线（方案 F2-09）：最近 N 天的总分、首响与超时趋势。 */
  @Get('trend')
  trend(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.records.trend(user, query);
  }

  /**
   * 导出明细为 Excel（方案 F2-08 / 接口清单 7.2 的 GET /api/records/export）。
   * 过滤条件与列表一致：看到的什么就导出什么。
   */
  @Get('export')
  async exportXlsx(@CurrentUser() user: AuthUser, @Query() query: any, @Res() res: any) {
    const buffer = await this.records.exportXlsx(user, query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="records-${stamp}.xlsx"`);
    res.send(buffer);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.records.detail(user, Number(id));
  }

  @Post(':id/annotations')
  annotate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.records.addAnnotation(user, Number(id), body);
  }

  @Post('annotations/:annotationId/reply')
  reply(@CurrentUser() user: AuthUser, @Param('annotationId') annotationId: string, @Body() body: { replyContent: string }) {
    return this.records.replyAnnotation(user, Number(annotationId), body.replyContent);
  }
}
