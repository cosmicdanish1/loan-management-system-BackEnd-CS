import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserMaster } from './entities';
import * as bcrypt from 'bcrypt';

@Injectable()
export class HashPasswordsService {
  private readonly logger = new Logger(HashPasswordsService.name);

  constructor(
    @InjectRepository(UserMaster)
    private userMasterRepository: Repository<UserMaster>,
  ) {}

  /**
   * Hash all plain text passwords in the database
   * Run this once to migrate existing plain text passwords to bcrypt
   */
  async hashAllPlainTextPasswords(): Promise<{
    updated: number;
    skipped: number;
    errors: number;
  }> {
    const users = await this.userMasterRepository.find();
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const user of users) {
      try {
        // Check if password is already hashed
        if (
          user.spassword.startsWith('$2b$') ||
          user.spassword.startsWith('$2a$')
        ) {
          this.logger.log(`User ${user.susername} already has hashed password, skipping`);
          skipped++;
          continue;
        }

        // Hash the plain text password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(user.spassword, saltRounds);

        // Update user
        user.spassword = hashedPassword;
        await this.userMasterRepository.save(user);

        this.logger.log(`Successfully hashed password for user: ${user.susername}`);
        updated++;
      } catch (error) {
        this.logger.error(`Error hashing password for user ${user.susername}: ${error.message}`);
        errors++;
      }
    }

    return { updated, skipped, errors };
  }

  /**
   * Hash a single user's password
   */
  async hashUserPassword(username: string): Promise<boolean> {
    const user = await this.userMasterRepository.findOne({
      where: { susername: username },
    });

    if (!user) {
      throw new Error(`User ${username} not found`);
    }

    // Check if already hashed
    if (
      user.spassword.startsWith('$2b$') ||
      user.spassword.startsWith('$2a$')
    ) {
      this.logger.log(`User ${username} already has hashed password`);
      return false;
    }

    // Hash the password
    const saltRounds = 10;
    user.spassword = await bcrypt.hash(user.spassword, saltRounds);
    await this.userMasterRepository.save(user);

    this.logger.log(`Successfully hashed password for user: ${username}`);
    return true;
  }
}
