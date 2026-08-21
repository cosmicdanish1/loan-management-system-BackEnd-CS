import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import { TypeOrmWinstonLogger } from '../common/logging/typeorm.logger';
import { loadDbConfig } from './db-config.loader';

@Injectable()
export class DatabaseConfig implements TypeOrmOptionsFactory {
  constructor(private configService: ConfigService) { }

  createTypeOrmOptions(): TypeOrmModuleOptions {
    // Which DB to target comes from db-config.json (falls back to .env / defaults).
    const db = loadDbConfig();
    return {
      type: 'postgres',
      host: db.host,
      port: db.port,
      username: db.username,
      password: db.password,
      database: db.database,
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      migrations: [__dirname + '/../migrations/*{.ts,.js}'],
      synchronize: false, // Always false - never auto-sync schema
      migrationsRun: false, // Don't auto-run migrations
      logging: db.logging ? 'all' : false,
      logger: db.logging ? new TypeOrmWinstonLogger() : undefined,
      // Driven by db-config.json ("ssl": true), NOT by NODE_ENV. The service
      // always runs with NODE_ENV=production, so keying SSL off that forced
      // TLS against LAN Postgres instances that don't offer it, failing boot
      // with "The server does not support SSL connections".
      ssl: db.ssl ? { rejectUnauthorized: false } : false,
      // PostgreSQL specific optimizations
      extra: {
        max: 20, // Maximum number of clients in the pool
        idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
        // 2s was too aggressive for LAN deployments where Postgres may be on a
        // separate host or briefly busy, causing "Connection terminated due to
        // connection timeout" errors during the periodic health-check burst.
        connectionTimeoutMillis: 10000, // Return an error after 10 seconds if connection could not be established
        keepAlive: true, // Keep sockets alive to survive idle LAN links / NAT
      },
    };
  }
}

// DataSource for migrations — reads the same db-config.json so CLI migrations
// target exactly the database the running app uses.
const migrationDb = loadDbConfig();
const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: migrationDb.host,
  port: migrationDb.port,
  username: migrationDb.username,
  password: migrationDb.password,
  database: migrationDb.database,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  synchronize: false,
  logging: migrationDb.logging,
  ssl: migrationDb.ssl ? { rejectUnauthorized: false } : false,
};

export const AppDataSource = new DataSource(dataSourceOptions);
