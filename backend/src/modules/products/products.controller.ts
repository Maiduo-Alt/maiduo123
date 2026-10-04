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

  @Roles('admin')
  @Post('import')
  import(@Body() body: { csv?: string; xlsxBase64?: string }) {
    if (body?.xlsxBase64) return this.products.importXlsx(body.xlsxBase64);
    return this.products.importCsv(body?.csv || '');
  }
}
