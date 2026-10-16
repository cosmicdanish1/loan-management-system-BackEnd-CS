import { MigrationInterface, QueryRunner } from 'typeorm';

// ES-168: System Configuration save sends `showChatbot`; the DTO/entity/table lacked it, so
// the whitelist validation rejected every save with 400.
export class AddShowChatbotToUserPreferences1791331200000 implements MigrationInterface {
    name = 'AddShowChatbotToUserPreferences1791331200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "showChatbot" boolean NOT NULL DEFAULT true`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "showChatbot"`);
    }
}
