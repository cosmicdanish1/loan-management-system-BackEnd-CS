import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Member } from '../entities/member.entity';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Service for handling Member Signature operations
 * Part of Member V2 Module
 */
@Injectable()
export class SignatureService {
    constructor(
        @InjectRepository(Member)
        private readonly memberRepository: Repository<Member>,
    ) { }

    /**
     * Save signature file path to member record
     */
    async uploadSignature(memberId: number, filePath: string): Promise<Member> {
        const member = await this.memberRepository.findOne({
            where: { id: memberId },
        });

        if (!member) {
            // If member not found, we should probably delete the uploaded file to avoid orphans
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            throw new NotFoundException(`Member with ID ${memberId} not found`);
        }

        // Delete old signature if exists
        if (member.signatureImagePath) {
            const oldPath = path.join(process.cwd(), member.signatureImagePath);
            if (fs.existsSync(oldPath)) {
                try {
                    fs.unlinkSync(oldPath);
                } catch (error) {
                    console.error(`Failed to delete old signature for member ${memberId}:`, error);
                }
            }
        }

        // Update member record
        // Store relative path
        const relativePath = filePath.replace(process.cwd(), '').replace(/\\/g, '/');
        // Ensure it starts with /uploads or similar (multer destination was ./uploads/signatures)
        // Actually, Multer stores it in 'uploads/signatures/filename.ext'. 
        // We should store 'uploads/signatures/filename.ext' in DB.

        // filePath coming from controller might be absolute or relative depending on Multer.
        // Multer 'file.path' is usually relative if destination is relative.

        member.signatureImagePath = filePath; // We will handle normalization in controller
        return this.memberRepository.save(member);
    }

    /**
     * Delete signature
     */
    async deleteSignature(memberId: number): Promise<void> {
        const member = await this.memberRepository.findOne({
            where: { id: memberId },
        });

        if (!member) {
            throw new NotFoundException(`Member with ID ${memberId} not found`);
        }

        if (member.signatureImagePath) {
            const fullPath = path.join(process.cwd(), member.signatureImagePath);
            if (fs.existsSync(fullPath)) {
                try {
                    fs.unlinkSync(fullPath);
                } catch (error) {
                    console.error(`Failed to delete signature for member ${memberId}:`, error);
                }
            }
            member.signatureImagePath = null;
            await this.memberRepository.save(member);
        }
    }

    /**
     * Get signature path
     */
    async getSignaturePath(memberId: number): Promise<string | null> {
        const member = await this.memberRepository.findOne({
            where: { id: memberId },
        });

        if (!member) {
            throw new NotFoundException(`Member with ID ${memberId} not found`);
        }

        return member.signatureImagePath;
    }
}
