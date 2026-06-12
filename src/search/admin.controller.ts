import { Controller, Post, HttpCode } from '@nestjs/common';
import { DbService } from './db.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly db: DbService) {}

  @Post('setup-db')
  @HttpCode(200)
  async setupDb() {
    await this.db.setupSchema();
    return { ok: true };
  }
}
