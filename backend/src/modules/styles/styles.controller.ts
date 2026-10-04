import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { StylesService } from './styles.service';
import { Roles } from '../../common/decorators';

@Controller('api/styles')
export class StylesController {
  constructor(private readonly styles: StylesService) {}

  @Get()
  list() {
    return this.styles.list();
  }

  /** 风格效果统计（方案 F7-07）：各风格被练次数与达标率。 */
  @Get('stats')
  stats() {
    return this.styles.stats();
  }

  @Roles('admin')
  @Put('ratios')
  saveRatios(@Body() body: { items: { code: string; ratio: number | null }[] }) {
    return this.styles.saveRatios(body.items || []);
  }

  @Roles('admin')
  @Post()
  create(@Body() body: any) {
    return this.styles.create(body);
  }

  @Roles('admin')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.styles.update(Number(id), body);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.styles.remove(Number(id));
  }
}
