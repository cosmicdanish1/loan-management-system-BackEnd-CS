import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
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
        private readonly dataSource: DataSource,
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
        // BUG FIX 3: normalise to a relative forward-slash path so that
        // join(process.cwd(), relativePath) works correctly on serve.
        const relativePath = filePath
            .replace(process.cwd(), '')
            .replace(/\\/g, '/')
            .replace(/^\//, ''); // strip leading slash

        member.signatureImagePath = relativePath;
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

    // ── member_master (legacy) signature methods ──────────────────────────────

    /** BUG FIX 1+2: Signatures for legacy members stored in member_master.signature_image_path */
    async uploadSignatureMaster(mbno: string, filePath: string): Promise<void> {
        const rows = await this.dataSource.query(
            `SELECT mbno, signature_image_path FROM member_master WHERE mbno = $1`, [mbno]
        );
        if (!rows || rows.length === 0) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw new NotFoundException(`Member ${mbno} not found in member_master`);
        }
        const existing = rows[0].signature_image_path;
        if (existing) {
            const oldFull = path.join(process.cwd(), existing);
            if (fs.existsSync(oldFull)) {
                try { fs.unlinkSync(oldFull); } catch (_) { /* ignore */ }
            }
        }
        // BUG FIX 3: normalise to relative forward-slash path
        const relativePath = filePath
            .replace(process.cwd(), '')
            .replace(/\\/g, '/')
            .replace(/^\//, '');

        await this.dataSource.query(
            `UPDATE member_master SET signature_image_path = $1 WHERE mbno = $2`,
            [relativePath, mbno]
        );
    }

    async deleteSignatureMaster(mbno: string): Promise<void> {
        const rows = await this.dataSource.query(
            `SELECT signature_image_path FROM member_master WHERE mbno = $1`, [mbno]
        );
        if (!rows || rows.length === 0) {
            throw new NotFoundException(`Member ${mbno} not found in member_master`);
        }
        const sigPath = rows[0].signature_image_path;
        if (sigPath) {
            const fullPath = path.join(process.cwd(), sigPath);
            if (fs.existsSync(fullPath)) {
                try { fs.unlinkSync(fullPath); } catch (_) { /* ignore */ }
            }
            await this.dataSource.query(
                `UPDATE member_master SET signature_image_path = NULL WHERE mbno = $1`, [mbno]
            );
        }
    }

    async getSignaturePathMaster(mbno: string): Promise<string | null> {
        const rows = await this.dataSource.query(
            `SELECT signature_image_path FROM member_master WHERE mbno = $1`, [mbno]
        );
        if (!rows || rows.length === 0) {
            throw new NotFoundException(`Member ${mbno} not found in member_master`);
        }
        return rows[0].signature_image_path || null;
    }
}
