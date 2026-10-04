import { Module } from '@nestjs/common';
import { StylesController } from './styles.controller';
import { StylesService } from './styles.service';

@Module({
  controllers: [StylesController],
  providers: [StylesService],
  exports: [StylesService],
})
export class StylesModule {}
