import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { DbService } from './db.service';

@Module({
  providers: [DbService, SearchService],
  exports: [SearchService],
})
export class SearchModule {}
