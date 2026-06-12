import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { DbService } from './db.service';
import { AdminController } from './admin.controller';

@Module({
  controllers: [AdminController],
  providers: [DbService, SearchService],
  exports: [SearchService],
})
export class SearchModule {}
