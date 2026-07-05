import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { DbService } from './db.service';
import { AdminController } from './admin.controller';
import { SearchController } from './search.controller';

@Module({
  controllers: [AdminController, SearchController],
  providers: [DbService, SearchService],
  exports: [SearchService],
})
export class SearchModule {}
