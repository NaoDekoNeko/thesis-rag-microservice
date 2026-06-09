import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResultRow } from 'pg';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  pool: Pool;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    this.pool = new Pool({
      host: this.config.get('DB_HOST'),
      port: this.config.get<number>('DB_PORT', 5432),
      database: this.config.get('DB_NAME'),
      user: this.config.get('DB_USER'),
      password: this.config.get('DB_PASSWORD'),
      max: 5,
    });
    this.logger.log('DB pool initialized');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    return this.pool.query<T>(sql, params);
  }
}
