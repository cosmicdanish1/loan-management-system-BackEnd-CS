import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
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
    private readonly logger = new Logger(SignatureService.name);

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
                    this.logger.error(`Failed to delete old signature for member ${memberId}: ${error.message}`);
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
                    this.logger.error(`Failed to delete signature for member ${memberId}: ${error.message}`);
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

    // ── Photo methods (profile / doc_front / doc_back) ────────────────────────

    private photoColumn(type: string): string {
        const map: Record<string, string> = {
            profile: 'profile_photo_path',
            doc_front: 'doc_front_path',
            doc_back: 'doc_back_path',
        };
        const col = map[type];
        if (!col) throw new BadRequestException(`Unknown photo type: ${type}`);
        return col;
    }

    async uploadPhotoMaster(mbno: string, filePath: string, type: string): Promise<void> {
        const col = this.photoColumn(type);
        const rows = await this.dataSource.query(
            `SELECT mbno, ${col} FROM member_master WHERE mbno = $1`, [mbno]
        );
        if (!rows || rows.length === 0) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw new NotFoundException(`Member ${mbno} not found`);
        }
        const existing = rows[0][col];
        if (existing) {
            const oldFull = path.join(process.cwd(), existing);
            if (fs.existsSync(oldFull)) { try { fs.unlinkSync(oldFull); } catch (_) { /* ignore */ } }
        }
        const relativePath = filePath.replace(process.cwd(), '').replace(/\\/g, '/').replace(/^\//, '');
        await this.dataSource.query(`UPDATE member_master SET ${col} = $1 WHERE mbno = $2`, [relativePath, mbno]);
    }

    async getPhotoPathMaster(mbno: string, type: string): Promise<string | null> {
        const col = this.photoColumn(type);
        const rows = await this.dataSource.query(
            `SELECT ${col} FROM member_master WHERE mbno = $1`, [mbno]
        );
        if (!rows || rows.length === 0) throw new NotFoundException(`Member ${mbno} not found`);
        return rows[0][col] || null;
    }

    async deletePhotoMaster(mbno: string, type: string): Promise<void> {
        const col = this.photoColumn(type);
        const rows = await this.dataSource.query(
            `SELECT ${col} FROM member_master WHERE mbno = $1`, [mbno]
        );
        if (!rows || rows.length === 0) throw new NotFoundException(`Member ${mbno} not found`);
        const photoPath = rows[0][col];
        if (photoPath) {
            const fullPath = path.join(process.cwd(), photoPath);
            if (fs.existsSync(fullPath)) { try { fs.unlinkSync(fullPath); } catch (_) { /* ignore */ } }
            await this.dataSource.query(`UPDATE member_master SET ${col} = NULL WHERE mbno = $1`, [mbno]);
        }
    }

    // ==================== KYC Documents (multi-document per member) ====================

    /** Create the member_documents table on first use (no migration tooling in this project). */
    private async ensureDocumentsTable(): Promise<void> {
        await this.dataSource.query(`
            CREATE TABLE IF NOT EXISTS member_documents (
                id SERIAL PRIMARY KEY,
                mbno numeric,
                doc_type varchar(50),
                file_name varchar(255),
                file_path varchar(500),
                uploaded_at timestamp DEFAULT NOW()
            )
        `);
    }

    async addDocument(mbno: string, docType: string, filePath: string, originalName: string): Promise<any> {
        // Verify the member exists; otherwise clean up the orphaned file
        const member = await this.dataSource.query(`SELECT mbno FROM member_master WHERE mbno = $1`, [mbno]);
        if (!member || member.length === 0) {
            if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ } }
            throw new NotFoundException(`Member ${mbno} not found`);
        }
        await this.ensureDocumentsTable();
        const relativePath = filePath.replace(process.cwd(), '').replace(/\\/g, '/').replace(/^\//, '');
        const rows = await this.dataSource.query(
            `INSERT INTO member_documents (mbno, doc_type, file_name, file_path)
             VALUES ($1, $2, $3, $4) RETURNING id, doc_type, file_name, uploaded_at`,
            [mbno, (docType || 'Other').substring(0, 50), (originalName || '').substring(0, 255), relativePath]
        );
        return rows[0];
    }

    async listDocuments(mbno: string): Promise<any[]> {
        await this.ensureDocumentsTable();
        return this.dataSource.query(
            `SELECT id, doc_type AS "docType", file_name AS "fileName", uploaded_at AS "uploadedAt"
             FROM member_documents WHERE mbno = $1 ORDER BY uploaded_at DESC`,
            [mbno]
        );
    }

    async getDocumentPath(id: number): Promise<string | null> {
        await this.ensureDocumentsTable();
        const rows = await this.dataSource.query(`SELECT file_path FROM member_documents WHERE id = $1`, [id]);
        return rows && rows.length > 0 ? rows[0].file_path : null;
    }

    async deleteDocument(id: number): Promise<void> {
        await this.ensureDocumentsTable();
        const rows = await this.dataSource.query(`SELECT file_path FROM member_documents WHERE id = $1`, [id]);
        if (!rows || rows.length === 0) throw new NotFoundException(`Document ${id} not found`);
        const filePath = rows[0].file_path;
        if (filePath) {
            const fullPath = path.join(process.cwd(), filePath);
            if (fs.existsSync(fullPath)) { try { fs.unlinkSync(fullPath); } catch (_) { /* ignore */ } }
        }
        await this.dataSource.query(`DELETE FROM member_documents WHERE id = $1`, [id]);
    }
}
