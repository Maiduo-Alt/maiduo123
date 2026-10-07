import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ProductsService } from './products.service';
import { Roles } from '../../common/decorators';

@Controller('api/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() query: any) {
    return this.products.list(query);
  }

  @Get('import-template')
  template(@Res() res: any) {
    const csv = 'product_no,title,price,stock,category,services,scenes\n3781xxxxxxxxx,示例商品标题,99.00,100,家居,七天无理由;运费险,日常通勤';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + csv);
  }

  /** 导出商品清单（方案 F4-07），过滤条件与列表一致。 */
  @Get('export')
  async exportXlsx(@Query() query: any, @Res() res: any) {
    const buffer = await this.products.exportXlsx(query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="products-${stamp}.xlsx"`);
    res.send(buffer);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.products.detail(Number(id));
  }

  @Roles('admin')
  @Post()
  create(@Body() body: any) {
    return this.products.create(body);
  }

  @Roles('admin')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.products.update(Number(id), body);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.products.remove(Number(id));
  }

  /** 批量删除商品（2026-10-07 客户新增）：未被剧本引用的软删除；被引用的逐个跳过并在返回里说明。 */
  @Roles('admin')
  @Post('batch-delete')
  removeMany(@Body() body: { ids: number[] }) {
    return this.products.removeMany(body.ids || []);
  }

  /** 一键添加商品（2026-10-07 客户新增）：识别分享链接，返回表单预填信息（不落库）。 */
  @Roles('admin')
  @Post('import-from-link')
  importFromLink(@Body() body: { url?: string }) {
    return this.products.importFromLink(body?.url || '');
  }

  @Roles('admin')
  @Post('import')
  import(@Body() body: { csv?: string; xlsxBase64?: string }) {
    if (body?.xlsxBase64) return this.products.importXlsx(body.xlsxBase64);
    return this.products.importCsv(body?.csv || '');
  }
}
