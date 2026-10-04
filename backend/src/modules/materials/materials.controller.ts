import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { MaterialsService } from './materials.service';
import { AuthUser, CurrentUser, Roles } from '../../common/decorators';

@Controller('api')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Get('backgrounds')
  listBackgrounds(@Query() query: any) {
    return this.materials.listBackgrounds(query);
  }

  @Roles('admin', 'leader')
  @Post('backgrounds')
  createBackground(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.materials.createBackground(body, user.id);
  }

  @Roles('admin', 'leader')
  @Put('backgrounds/:id')
  updateBackground(@Param('id') id: string, @Body() body: any) {
    return this.materials.updateBackground(Number(id), body);
  }

  @Roles('admin', 'leader')
  @Post('backgrounds/batch-delete')
  removeBackgrounds(@Body() body: { ids: number[] }) {
    return this.materials.removeBackgrounds(body.ids || []);
  }

  @Get('contents')
  listContents(@Query() query: any) {
    return this.materials.listContents(query);
  }

  @Roles('admin', 'leader')
  @Post('contents')
  createContent(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.materials.createContent(body, user.id);
  }

  @Roles('admin', 'leader')
  @Put('contents/:id')
  updateContent(@Param('id') id: string, @Body() body: any) {
    return this.materials.updateContent(Number(id), body);
  }

  @Roles('admin', 'leader')
  @Post('contents/batch-delete')
  removeContents(@Body() body: { ids: number[] }) {
    return this.materials.removeContents(body.ids || []);
  }

  @Get('categories')
  listCategories(@Query('type') type: string) {
    return this.materials.listCategories(type || 'qa');
  }

  @Roles('admin', 'leader')
  @Post('categories')
  createCategory(@Body() body: any) {
    return this.materials.createCategory(body);
  }

  @Roles('admin', 'leader')
  @Put('categories/reorder')
  reorder(@Body() body: { items: { id: number; sort: number }[] }) {
    return this.materials.reorderCategories(body.items || []);
  }

  /** 字典项改名，并级联到已引用它的素材（方案 F8-11）。 */
  @Roles('admin', 'leader')
  @Put('categories/:id')
  updateCategory(@Param('id') id: string, @Body() body: { name?: string }) {
    return this.materials.updateCategory(Number(id), body);
  }

  @Roles('admin', 'leader')
  @Delete('categories/:id')
  removeCategory(@Param('id') id: string) {
    return this.materials.removeCategory(Number(id));
  }
}
