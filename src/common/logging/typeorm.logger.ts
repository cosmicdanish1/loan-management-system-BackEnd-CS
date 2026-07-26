import { Logger as NestLogger } from '@nestjs/common';
import { Logger as TypeOrmLogger, QueryRunner } from 'typeorm';

export class TypeOrmWinstonLogger implements TypeOrmLogger {
  private readonly logger = new NestLogger('TypeORM');

  logQuery(query: string, parameters?: any[], _queryRunner?: QueryRunner): void {
    const params = parameters && parameters.length ? parameters : undefined;
    this.logger.debug(
      JSON.stringify({ query, params, type: 'query' }),
    );
  }

  logQueryError(error: string | Error, query: string, parameters?: any[], _queryRunner?: QueryRunner): void {
    const params = parameters && parameters.length ? parameters : undefined;
    this.logger.error(
      JSON.stringify({
        query,
        params,
        error: error instanceof Error ? error.message : error,
        type: 'query_error',
      }),
    );
  }

  logQuerySlow(time: number, query: string, parameters?: any[], _queryRunner?: QueryRunner): void {
    const params = parameters && parameters.length ? parameters : undefined;
    this.logger.warn(
      JSON.stringify({ query, params, duration: time, type: 'slow_query' }),
    );
  }

  logSchemaBuild(message: string, _queryRunner?: QueryRunner): void {
    this.logger.log(JSON.stringify({ message, type: 'schema' }));
  }

  logMigration(message: string, _queryRunner?: QueryRunner): void {
    this.logger.log(JSON.stringify({ message, type: 'migration' }));
  }

  log(level: 'log' | 'info' | 'warn', message: any, _queryRunner?: QueryRunner): void {
    switch (level) {
      case 'warn':
        this.logger.warn(message);
        break;
      default:
        this.logger.log(message);
    }
  }
}
