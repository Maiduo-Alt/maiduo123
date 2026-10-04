import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Res } from '@nestjs/common';
import { CasesService } from './cases.service';
import { AuthUser, CurrentUser, Roles } from '../../common/decorators';
import { CASE_IMPORT_TEMPLATE, listCaseAdapters } from '../../domain/case-adapters';

@Controller('api/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  list(@Query() query: any) {
    return this.cases.list(query);
  }

  /** 可用的导入适配器（方案 F5-03 的注册点，平台适配器接进来后会出现在这里）。 */
  @Get('adapters')
  adapters() {
    return listCaseAdapters();
  }

  /** 文件导入模板（方案 F5-01）。 */
  @Get('import/template')
  template(@Res() res: any) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="case-import-template.csv"');
    res.send('\uFEFF' + CASE_IMPORT_TEMPLATE);
  }

  // 注意：带字面量的 GET 必须排在 @Get(':id') 之前，否则会被 :id 抢先匹配
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.cases.detail(Number(id));
  }

  @Roles('admin', 'leader')
  @Post('import/text')
  importText(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.cases.importText(body, user.id);
  }

  /** 文件导入（方案 F5-01）：CSV / Excel + 适配器解析。 */
  @Roles('admin', 'leader')
  @Post('import/file')
  importFile(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.cases.importFile(body, user.id);
  }

  /** 方案 F5-09 / F2-06：把一次训练接待推入案例库，可同时标记为「典型案例」。 */
  @Roles('admin', 'leader')
  @Post('from-attempt')
  fromAttempt(@Body() body: { attemptId: number; highlight?: boolean }, @CurrentUser() user: AuthUser) {
    return this.cases.fromAttempt(Number(body.attemptId), user.id, Boolean(body.highlight));
  }

  /** 方案 F5-05：维护案例的标题 / 店铺 / 阶段 / 标签。 */
  @Roles('admin', 'leader')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.cases.update(Number(id), body);
  }

  @Roles('admin', 'leader')
  @Post(':id/to-content')
  toContent(@Param('id') id: string) {
    return this.cases.toContent(Number(id));
  }

  @Roles('admin', 'leader')
  @Post('messages/:messageId/excellent')
  markExcellent(@Param('messageId') messageId: string, @Body() body: { isExcellent: boolean }) {
    return this.cases.markExcellent(Number(messageId), body.isExcellent);
  }

  @Roles('admin', 'leader')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.cases.remove(Number(id));
  }
}
