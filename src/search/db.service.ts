import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResultRow } from 'pg';

const TABLE = 'doc_embeddings_rag';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  pool: Pool;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    this.pool = new Pool({
      host: this.config.get('DB_HOST'),
      port: this.config.get<number>('DB_PORT', 5432),
      database: this.config.get('DB_NAME'),
      user: this.config.get('DB_USER'),
      password: this.config.get('DB_PASSWORD'),
      max: 5,
    });
    this.logger.log('DB pool initialized');
    await this.setupSchema();
  }

  private async setupSchema() {
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    } catch {
      this.logger.warn('Could not create vector extension — ensure it is already enabled or run indexer first');
    }
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id         SERIAL PRIMARY KEY,
          doc_folder TEXT NOT NULL,
          title      TEXT,
          url        TEXT,
          category   TEXT,
          content    TEXT NOT NULL,
          embedding  vector(768),
          fts_vector tsvector GENERATED ALWAYS AS (
                         to_tsvector('spanish', content)
                     ) STORED
        );
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS ${TABLE}_embedding_idx
          ON ${TABLE} USING hnsw (embedding vector_cosine_ops);
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS ${TABLE}_fts_idx
          ON ${TABLE} USING gin (fts_vector);
      `);
      this.logger.log('DB schema ready');
    } catch (err) {
      this.logger.warn('Schema setup skipped — table may not exist yet', err?.message);
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    return this.pool.query<T>(sql, params);
  }
}
