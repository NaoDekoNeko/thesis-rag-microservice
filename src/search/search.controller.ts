import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';
import type { SearchMode } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  find(
    @Query('q') q: string,
    @Query('mode') mode: SearchMode = 'hybrid',
    @Query('k') k?: string,
    @Query('docFolder') docFolder?: string,
    @Query('category') category?: string,
  ) {
    return this.searchService.search(q, mode, {
      k: k ? parseInt(k, 10) : undefined,
      docFolder,
      category,
    });
  }
}
