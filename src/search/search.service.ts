import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { DbService } from './db.service';

export interface SearchResult {
  doc_folder: string;
  title: string;
  url: string;
  category: string;
  content: string;
  score: number;
}

interface SearchOptions {
  docFolder?: string;
  category?: string;
  k?: number;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly genai: GoogleGenAI;
  private readonly embeddingModel: string;
  private readonly table: string;

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {
    this.genai = new GoogleGenAI({ apiKey: this.config.getOrThrow('GEMINI_API_KEY') });
    this.embeddingModel = this.config.get('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001');
    this.table = this.config.get('VECTOR_TABLE_NAME', 'doc_embeddings_rag');
  }

  async hybridSearch(
    query: string,
    opts: SearchOptions = {},
  ): Promise<{ results: SearchResult[]; searchType: string }> {
    const k = opts.k ?? 8;
    const filters = this.buildFilters(opts);

    const [semantic, keyword] = await Promise.all([
      this.semanticSearch(query, k * 2, filters),
      this.keywordSearch(query, k * 2, filters),
    ]);

    const results = this.combineAndRank(semantic, keyword, k);
    return { results, searchType: 'hybrid' };
  }

  private async semanticSearch(
    query: string,
    limit: number,
    filters: { sql: string; params: any[] },
  ): Promise<SearchResult[]> {
    let embedding: number[];
    try {
      const res = await this.genai.models.embedContent({
        model: this.embeddingModel,
        contents: query,
        config: { outputDimensionality: 768 },
      });
      embedding = res.embeddings?.[0]?.values ?? [];
    } catch (err) {
      this.logger.error('Embedding generation failed', err);
      return [];
    }

    const vector = `[${embedding.join(',')}]`;
    const { sql: filterSql, params: filterParams } = filters;
    const sql = `
      SELECT doc_folder, title, url, category, content,
             1 - (embedding <=> $1::vector) AS score
      FROM ${this.table}
      ${filterSql ? `WHERE ${filterSql}` : ''}
      ORDER BY embedding <=> $1::vector
      LIMIT $${filterParams.length + 2}
    `;
    const { rows } = await this.db.query<SearchResult>(sql, [
      vector,
      ...filterParams,
      limit,
    ]);
    return rows;
  }

  private async keywordSearch(
    query: string,
    limit: number,
    filters: { sql: string; params: any[] },
  ): Promise<SearchResult[]> {
    const { sql: filterSql, params: filterParams } = filters;
    const queryParam = filterParams.length + 1;
    const limitParam = filterParams.length + 2;
    const sql = `
      SELECT doc_folder, title, url, category, content,
             ts_rank_cd(fts_vector, plainto_tsquery('spanish', $${queryParam})) AS score
      FROM ${this.table}
      ${filterSql ? `WHERE ${filterSql} AND` : 'WHERE'}
        fts_vector @@ plainto_tsquery('spanish', $${queryParam})
      ORDER BY score DESC
      LIMIT $${limitParam}
    `;
    try {
      const { rows } = await this.db.query<SearchResult>(sql, [
        ...filterParams,
        query,
        limit,
      ]);
      return rows;
    } catch {
      return [];
    }
  }

  private buildFilters(opts: SearchOptions): { sql: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.docFolder) {
      params.push(opts.docFolder);
      conditions.push(`doc_folder = $${params.length}`);
    }
    if (opts.category) {
      params.push(opts.category);
      conditions.push(`category = $${params.length}`);
    }
    return { sql: conditions.join(' AND '), params };
  }

  private combineAndRank(
    semantic: SearchResult[],
    keyword: SearchResult[],
    k: number,
  ): SearchResult[] {
    const map = new Map<string, SearchResult>();

    for (const r of semantic) {
      map.set(r.url, { ...r, score: r.score * 0.7 });
    }
    for (const r of keyword) {
      const existing = map.get(r.url);
      if (existing) {
        existing.score += r.score * 0.3;
      } else {
        map.set(r.url, { ...r, score: r.score * 0.3 });
      }
    }

    return [...map.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async ping(): Promise<string> {
    try {
      await this.db.query('SELECT 1');
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
