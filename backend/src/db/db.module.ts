import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';
import { SessionEvents } from '../common/session-events';

@Global()
@Module({
  providers: [DbService, SessionEvents],
  exports: [DbService, SessionEvents],
})
export class DbModule {}
