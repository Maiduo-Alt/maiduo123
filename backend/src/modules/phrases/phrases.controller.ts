import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { PhrasesService } from './phrases.service';
import { AuthUser, CurrentUser, Roles } from '../../common/decorators';

@Controller('api/phrases')
export class PhrasesController {
  constructor(private readonly phrases: PhrasesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('category') category?: string, @Query('all') all?: string) {
    // 维护页需要看到已停用的短语，只对能维护短语的角色开放
    const canMaintain = user?.roleCode === 'admin' || user?.roleCode === 'leader';
    return this.phrases.list(category, all === '1' && canMaintain);
  }

  @Roles('admin', 'leader')
  @Post()
  create(@Body() body: any) {
    return this.phrases.create(body);
  }

  @Roles('admin', 'leader')
  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.phrases.update(Number(id), body);
  }

  @Roles('admin', 'leader')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.phrases.remove(Number(id));
  }

  /** 接待页插入短语后累加使用次数；所有角色都可调用（客服每天都在用）。 */
  @Post(':id/use')
  use(@Param('id') id: string) {
    return this.phrases.markUsed(Number(id));
  }
}
