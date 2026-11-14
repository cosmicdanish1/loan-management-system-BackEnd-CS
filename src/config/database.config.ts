import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import { TypeOrmWinstonLogger } from '../common/logging/typeorm.logger';

@Injectable()
export class DatabaseConfig implements TypeOrmOptionsFactory {
  constructor(private configService: ConfigService) { }

  createTypeOrmOptions(): TypeOrmModuleOptions {
    return {
      type: 'postgres',
      host: this.configService.get('DB_HOST', 'localhost'),
      port: this.configService.get('DB_PORT', 5432),
      username: this.configService.get('DB_USERNAME', 'postgres'),
      password: this.configService.get('DB_PASSWORD', 'postgres'),
      database: this.configService.get('DB_DATABASE', 'loan_management_db'),
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      migrations: [__dirname + '/../migrations/*{.ts,.js}'],
      synchronize: false, // Always false - never auto-sync schema
      migrationsRun: false, // Don't auto-run migrations
      // DB_LOGGING=true -> every SQL statement goes to the db-queries log via TypeOrmWinstonLogger (with the request id).
      logging: String(this.configService.get('DB_LOGGING', false)) === 'true' ? 'all' : false,
      logger: String(this.configService.get('DB_LOGGING', false)) === 'true' ? new TypeOrmWinstonLogger() : undefined,
      ssl: this.configService.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
      // PostgreSQL specific optimizations
      // ES-267: the pool used to be 20 connections with a 2 second wait for a free one, so a few slow reports made
      // every other screen fail with "timeout exceeded when trying to connect". A caller now waits up to 15 s for a
      // connection (it queues instead of failing), a single statement may run at most DB_STATEMENT_TIMEOUT_MS
      // (default 2 minutes, so a runaway query cannot hold a connection forever), and the pool size is DB_POOL_MAX.
      extra: {
        max: Math.max(5, Number(this.configService.get('DB_POOL_MAX', 30)) || 30), // Maximum number of clients in the pool
        idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
        connectionTimeoutMillis: Math.max(2000, Number(this.configService.get('DB_CONNECT_TIMEOUT_MS', 15000)) || 15000),
        statement_timeout: Math.max(5000, Number(this.configService.get('DB_STATEMENT_TIMEOUT_MS', 120000)) || 120000),
      },
    };
  }
}

// DataSource for migrations
const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_DATABASE || 'loan_management_db',
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
};

export const AppDataSource = new DataSource(dataSourceOptions);
