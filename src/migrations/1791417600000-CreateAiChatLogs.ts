import { MigrationInterface, QueryRunner } from 'typeorm';

// AI assistant conversation log (ES-439). Same DDL as database/migrations/create-ai-chat-logs.sql.
export class CreateAiChatLogs1791417600000 implements MigrationInterface {
    name = 'CreateAiChatLogs1791417600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const exists = await queryRunner.hasTable('ai_chat_logs');
        if (!exists) {
            await queryRunner.query(`
                CREATE TABLE "ai_chat_logs" (
                    "id" SERIAL PRIMARY KEY,
                    "user_id" varchar(50),
                    "username" varchar(100),
                    "role" varchar(50),
                    "route" varchar(300),
                    "question" text NOT NULL,
                    "answer" text,
                    "provider" varchar(20) NOT NULL DEFAULT 'none',
                    "status" varchar(20) NOT NULL DEFAULT 'OK',
                    "failure_reason" varchar(20),
                    "latency_ms" integer NOT NULL DEFAULT 0,
                    "feedback" smallint,
                    "created_at" timestamptz NOT NULL DEFAULT now()
                )
            `);
            await queryRunner.query(`CREATE INDEX "idx_ai_chat_logs_user" ON "ai_chat_logs" ("username", "created_at" DESC)`);
            await queryRunner.query(`CREATE INDEX "idx_ai_chat_logs_status" ON "ai_chat_logs" ("status", "created_at" DESC)`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "ai_chat_logs"`);
    }
}
