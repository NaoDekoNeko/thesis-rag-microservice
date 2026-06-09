import { Injectable } from '@nestjs/common';
import { SearchService } from '../search/search.service';
import { LlmService } from '../llm/llm.service';
import { AskDto } from './dto/ask.dto';

@Injectable()
export class ChatService {
  constructor(
    private readonly searchService: SearchService,
    private readonly llmService: LlmService,
  ) {}

  async ask(dto: AskDto) {
    const t0 = Date.now();

    const { question, docFolder, category, k = 8 } = dto;

    const { results, searchType } = await this.searchService.hybridSearch(
      question,
      { docFolder, category, k },
    );
    const searchMs = Date.now() - t0;

    const t1 = Date.now();
    const answer = await this.llmService.generateAnswer(question, results);
    const generationMs = Date.now() - t1;

    return {
      answer,
      sources: results.slice(0, 5).map((r) => ({
        docFolder: r.doc_folder,
        title: r.title,
        url: r.url,
        category: r.category,
        contentPreview: r.content.slice(0, 200),
        score: r.score,
      })),
      searchType,
      timing: { searchMs, generationMs, totalMs: Date.now() - t0 },
    };
  }

  async health() {
    const db = await this.searchService.ping();
    return { status: 'ok', db };
  }
}
