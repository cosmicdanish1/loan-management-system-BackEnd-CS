import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Member } from '../entities/member.entity';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);
const access = promisify(fs.access);

@Injectable()
export class SignatureService {
  private readonly uploadPath = 'uploads/signatures';
  private readonly allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png'];
  private readonly maxFileSize = 2 * 1024 * 1024; // 2MB

  constructor(
    @InjectRepository(Member)
    private readonly memberRepository: Repository<Member>,
  ) {
    this.ensureUploadDirectory();
  }

  /**
   * Ensure upload directory exists
   */
  private async ensureUploadDirectory(): Promise<void> {
    try {
      await access(this.uploadPath);
    } catch {
      await mkdir(this.uploadPath, { recursive: true });
    }
  }

  /**
   * Validate uploaded file
   */
  private validateFile(file: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (!this.allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Only JPEG and PNG images are allowed',
      );
    }

    if (file.size > this.maxFileSize) {
      throw new BadRequestException(
        'File size too large. Maximum size is 2MB',
      );
    }
  }

  /**
   * Generate unique filename
   */
  private generateFileName(memberId: number, originalName: string): string {
    const timestamp = Date.now();
    const extension = path.extname(originalName);
    return `member_${memberId}_signature_${timestamp}${extension}`;
  }

  /**
   * Upload member signature
   */
  async uploadSignature(
    memberId: number,
    file: Express.Multer.File,
  ): Promise<{ signatureUrl: string }> {
    // Validate file
    this.validateFile(file);

    // Check if member exists
    const member = await this.memberRepository.findOne({
      where: { id: memberId },
    });

    if (!member) {
      throw new NotFoundException(`Member with ID ${memberId} not found`);
    }

    try {
      // Delete existing signature if exists
      if (member.signatureImagePath) {
        await this.deleteSignatureFile(member.signatureImagePath);
      }

      // Generate new filename
      const fileName = this.generateFileName(memberId, file.originalname);
      const filePath = path.join(this.uploadPath, fileName);

      // Save file to disk
      await writeFile(filePath, file.buffer);

      // Update member record with new signature path
      await this.memberRepository.update(memberId, {
        signatureImagePath: filePath,
      });

      return {
        signatureUrl: `/api/v1/members/${memberId}/signature`,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        'Failed to upload signature image',
      );
    }
  }

  /**
   * Get member signature
   */
  async getSignature(memberId: number): Promise<{
    filePath: string;
    mimeType: string;
  }> {
    const member = await this.memberRepository.findOne({
      where: { id: memberId },
    });

    if (!member) {
      throw new NotFoundException(`Member with ID ${memberId} not found`);
    }

    if (!member.signatureImagePath) {
      throw new NotFoundException('No signature found for this member');
    }

    try {
      await access(member.signatureImagePath);
    } catch {
      throw new NotFoundException('Signature file not found on disk');
    }

    // Determine MIME type from file extension
    const extension = path.extname(member.signatureImagePath).toLowerCase();
    let mimeType = 'image/jpeg';
    if (extension === '.png') {
      mimeType = 'image/png';
    }

    return {
      filePath: member.signatureImagePath,
      mimeType,
    };
  }

  /**
   * Delete member signature
   */
  async deleteSignature(memberId: number): Promise<void> {
    const member = await this.memberRepository.findOne({
      where: { id: memberId },
    });

    if (!member) {
      throw new NotFoundException(`Member with ID ${memberId} not found`);
    }

    if (!member.signatureImagePath) {
      throw new NotFoundException('No signature found for this member');
    }

    try {
      // Delete file from disk
      await this.deleteSignatureFile(member.signatureImagePath);

      // Update member record
      await this.memberRepository.update(memberId, {
        signatureImagePath: null,
      });
    } catch (error) {
      throw new InternalServerErrorException(
        'Failed to delete signature image',
      );
    }
  }

  /**
   * Delete signature file from disk
   */
  private async deleteSignatureFile(filePath: string): Promise<void> {
    try {
      await access(filePath);
      await unlink(filePath);
    } catch {
      // File doesn't exist, ignore error
    }
  }

  /**
   * Validate image dimensions and quality
   */
  private async validateImageProperties(
    file: Express.Multer.File,
  ): Promise<void> {
    // This is a basic implementation
    // In a production environment, you might want to use a library like 'sharp'
    // to validate image dimensions, compress images, etc.
    
    // For now, we'll just validate file size and type
    this.validateFile(file);
  }

  /**
   * Process and optimize image
   */
  async processImage(file: Express.Multer.File): Promise<Buffer> {
    // Basic implementation - in production, you might want to:
    // 1. Resize image to standard dimensions
    // 2. Compress image to reduce file size
    // 3. Convert to standard format (e.g., always save as JPEG)
    // 4. Add watermark if needed
    
    await this.validateImageProperties(file);
    return file.buffer;
  }

  /**
   * Get signature statistics
   */
  async getSignatureStatistics(): Promise<{
    totalMembers: number;
    membersWithSignature: number;
    membersWithoutSignature: number;
    signaturePercentage: number;
  }> {
    const [totalMembers, membersWithSignature] = await Promise.all([
      this.memberRepository.count(),
      this.memberRepository
        .createQueryBuilder('member')
        .where('member.signatureImagePath IS NOT NULL')
        .getCount(),
    ]);

    const membersWithoutSignature = totalMembers - membersWithSignature;
    const signaturePercentage = totalMembers > 0 
      ? (membersWithSignature / totalMembers) * 100 
      : 0;

    return {
      totalMembers,
      membersWithSignature,
      membersWithoutSignature,
      signaturePercentage: Math.round(signaturePercentage * 100) / 100,
    };
  }
}
