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

export type SearchMode = 'lexical' | 'vector' | 'hybrid';

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

  async search(
    query: string,
    mode: SearchMode,
    opts: SearchOptions = {},
  ): Promise<{ results: SearchResult[]; searchType: string }> {
    if (mode === 'hybrid') return this.hybridSearch(query, opts);

    const k = opts.k ?? 8;
    const filters = this.buildFilters(opts);
    const rows =
      mode === 'lexical'
        ? await this.keywordSearch(query, k * 3, filters)
        : await this.semanticSearch(query, k * 3, filters);
    return { results: this.dedupeToDocs(rows, k), searchType: mode };
  }

  // El índice opera a nivel de chunk; la recuperación se reporta a nivel de
  // documento (mismo criterio que la anotación del ground truth), quedándose
  // con el chunk de mayor score por documento.
  private dedupeToDocs(rows: SearchResult[], k: number): SearchResult[] {
    const byDoc = new Map<string, SearchResult>();
    for (const r of rows) {
      const docKey = `${r.doc_folder}::${r.url}`;
      const existing = byDoc.get(docKey);
      if (!existing || r.score > existing.score) byDoc.set(docKey, r);
    }
    return [...byDoc.values()].sort((a, b) => b.score - a.score).slice(0, k);
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
    // $1 is the vector; filter params start at $2, so offset their indices by 1
    const offsetFilterSql = filterSql
      ? filterSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 1}`)
      : '';
    const sql = `
      SELECT doc_folder, title, url, category, content,
             1 - (embedding <=> $1::vector) AS score
      FROM ${this.table}
      ${offsetFilterSql ? `WHERE ${offsetFilterSql}` : ''}
      ORDER BY embedding <=> $1::vector
      LIMIT $${filterParams.length + 2}
    `;
    try {
      const { rows } = await this.db.query<SearchResult>(sql, [
        vector,
        ...filterParams,
        limit,
      ]);
      return rows;
    } catch (err) {
      this.logger.warn('Semantic search DB query failed', err?.message);
      return [];
    }
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
    const docKey = (r: SearchResult) => `${r.doc_folder}::${r.url}`;
    const semanticDocs = this.dedupeToDocs(semantic, semantic.length);
    const keywordDocs = this.dedupeToDocs(keyword, keyword.length);

    const map = new Map<string, SearchResult>();
    for (const r of semanticDocs) {
      map.set(docKey(r), { ...r, score: r.score * 0.7 });
    }
    for (const r of keywordDocs) {
      const existing = map.get(docKey(r));
      if (existing) {
        existing.score += r.score * 0.3;
      } else {
        map.set(docKey(r), { ...r, score: r.score * 0.3 });
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
