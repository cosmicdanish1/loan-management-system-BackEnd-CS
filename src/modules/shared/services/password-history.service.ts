import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserMaster } from '../../auth/entities/user-master.entity';

/** How many of a user's most recent passwords (the current one included) cannot be chosen again. */
export const PASSWORD_HISTORY_KEEP = 5;
export const PASSWORD_REUSED_MESSAGE = 'Choose a password you have not used before (not your last 5).';

/**
 * ES-207: password history. One table, password_history, holds only bcrypt hashes (never a password). Every successful
 * password change (Change Password, Forgot password, administrator-set password) records the new hash and keeps the
 * newest PASSWORD_HISTORY_KEEP rows per user. Before a new password is accepted it is compared with the CURRENT
 * password (with the normal login check, so legacy-format passwords are covered too) and with the stored hashes.
 */
@Injectable()
export class PasswordHistoryService implements OnModuleInit {
  private readonly logger = new Logger(PasswordHistoryService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    // Idempotent: same statements as database/migrations/create-password-history.sql
    await this.dataSource.query(`CREATE TABLE IF NOT EXISTS password_history (
      id            bigserial PRIMARY KEY,
      user_id       integer NOT NULL,
      password_hash varchar(255) NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
    await this.dataSource.query(`CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_history (user_id, id DESC)`);
  }

  /** Throws 400 when newPassword equals the user's current password or one of the stored previous passwords. */
  async assertNotReused(userId: number, newPassword: string): Promise<void> {
    const um = await this.dataSource.getRepository(UserMaster).findOne({ where: { userid: userId } });
    if (um && um.spassword && (await um.validatePassword(newPassword))) {
      throw new BadRequestException(PASSWORD_REUSED_MESSAGE);
    }
    const rows: { password_hash: string }[] = await this.dataSource.query(
      `SELECT password_hash FROM password_history WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
      [userId, PASSWORD_HISTORY_KEEP],
    );
    for (const r of rows) {
      if (await bcrypt.compare(newPassword, r.password_hash)) throw new BadRequestException(PASSWORD_REUSED_MESSAGE);
    }
  }

  /** Record the bcrypt hash that is now stored for the user and drop rows beyond the newest PASSWORD_HISTORY_KEEP. */
  async recordHash(userId: number, hash: string): Promise<void> {
    // ES-205: a changed or reset password ends every remembered computer (the next sign-in asks for the code).
    try { await this.dataSource.query(`DELETE FROM trusted_devices WHERE user_id = $1`, [userId]); } catch { /* table appears with the 2FA module */ }
    if (!hash || !(hash.startsWith('$2b$') || hash.startsWith('$2a$'))) return; // only real bcrypt hashes
    try {
      await this.dataSource.query(`INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)`, [userId, hash]);
      await this.dataSource.query(
        `DELETE FROM password_history WHERE user_id = $1 AND id NOT IN
           (SELECT id FROM password_history WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
        [userId, PASSWORD_HISTORY_KEEP],
      );
    } catch (e) {
      this.logger.error(`Could not record password history for user ${userId}: ${(e as Error).message}`);
    }
  }

  /** Record whatever hash is currently stored for the user (call right after the password was saved). */
  async recordCurrent(userId: number): Promise<void> {
    const rows = await this.dataSource.query(`SELECT spassword FROM usermaster WHERE userid = $1`, [userId]);
    await this.recordHash(userId, String(rows[0]?.spassword || ''));
  }
}
