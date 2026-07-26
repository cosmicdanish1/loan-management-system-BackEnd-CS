import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { FixedDeposit, RecurringDeposit } from '../entities';
import { Member } from '../../member/entities/member.entity';
import { CertificateTemplateService } from '../../admin/services/certificate-template.service';
import { numberToWords } from '../../shared/utils/number-to-words';

export interface CertificateConfig {
  organizationName: string;
  organizationAddress: string;
  organizationPhone: string;
  organizationEmail: string;
  logoPath?: string;
  signaturePath?: string;
  authorizedSignatory: string;
  designation: string;
}

export interface CertificateData {
  certificateNumber: string;
  memberName: string;
  memberNumber: string;
  accountNumber: string;
  principalAmount: number;
  interestRate: number;
  depositDate: Date;
  maturityDate: Date;
  maturityAmount: number;
  tenureMonths: number;
  certificateType: 'FIXED_DEPOSIT' | 'RECURRING_DEPOSIT' | 'SHARE';
}

@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);
  private readonly certificatesPath: string;
  private readonly defaultConfig: CertificateConfig;

  constructor(
    @InjectRepository(FixedDeposit)
    private readonly fixedDepositRepository: Repository<FixedDeposit>,
    @InjectRepository(RecurringDeposit)
    private readonly recurringDepositRepository: Repository<RecurringDeposit>,
    @InjectRepository(Member)
    private readonly memberRepository: Repository<Member>,
    private readonly configService: ConfigService,
    private readonly templateService: CertificateTemplateService,
  ) {
    this.certificatesPath = this.configService.get('CERTIFICATES_PATH', './uploads/certificates');
    this.ensureDirectoryExists(this.certificatesPath);

    this.defaultConfig = {
      organizationName: this.configService.get('ORG_NAME', 'Loan Management System'),
      organizationAddress: this.configService.get('ORG_ADDRESS', 'Organization Address'),
      organizationPhone: this.configService.get('ORG_PHONE', '+91-XXXXXXXXXX'),
      organizationEmail: this.configService.get('ORG_EMAIL', 'info@lms.com'),
      logoPath: this.configService.get('ORG_LOGO_PATH'),
      signaturePath: this.configService.get('SIGNATURE_PATH'),
      authorizedSignatory: this.configService.get('AUTHORIZED_SIGNATORY', 'Manager'),
      designation: this.configService.get('SIGNATORY_DESIGNATION', 'General Manager'),
    };
  }

  async generateFixedDepositCertificate(depositId: number, config?: Partial<CertificateConfig>): Promise<string> {
    const deposit = await this.fixedDepositRepository.findOne({
      where: { id: depositId },
      relations: ['member'],
    });

    if (!deposit) {
      throw new NotFoundException(`Fixed deposit with ID ${depositId} not found`);
    }

    if (deposit.status !== 'ACTIVE' && deposit.status !== 'MATURED') {
      throw new BadRequestException('Certificate can only be generated for active or matured deposits');
    }

    const certificateData: CertificateData = {
      certificateNumber: await this.generateCertificateNumber('FD'),
      memberName: deposit.member.fullName,
      memberNumber: deposit.member.memberNumber,
      accountNumber: deposit.accountNumber,
      principalAmount: Number(deposit.principalAmount),
      interestRate: Number(deposit.interestRate),
      depositDate: deposit.depositDate,
      maturityDate: deposit.maturityDate,
      maturityAmount: Number(deposit.maturityAmount),
      tenureMonths: deposit.tenureMonths,
      certificateType: 'FIXED_DEPOSIT',
    };

    return await this.generatePDFCertificate(certificateData, { ...this.defaultConfig, ...config });
  }

  async generateRecurringDepositCertificate(depositId: number, config?: Partial<CertificateConfig>): Promise<string> {
    const deposit = await this.recurringDepositRepository.findOne({
      where: { id: depositId },
      relations: ['member'],
    });

    if (!deposit) {
      throw new NotFoundException(`Recurring deposit with ID ${depositId} not found`);
    }

    if (deposit.status !== 'ACTIVE' && deposit.status !== 'MATURED') {
      throw new BadRequestException('Certificate can only be generated for active or matured deposits');
    }

    const certificateData: CertificateData = {
      certificateNumber: await this.generateCertificateNumber('RD'),
      memberName: deposit.member.fullName,
      memberNumber: deposit.member.memberNumber,
      accountNumber: deposit.accountNumber,
      principalAmount: Number(deposit.monthlyInstallment) * deposit.tenureMonths,
      interestRate: Number(deposit.interestRate),
      depositDate: deposit.startDate,
      maturityDate: deposit.maturityDate,
      maturityAmount: Number(deposit.maturityAmount),
      tenureMonths: deposit.tenureMonths,
      certificateType: 'RECURRING_DEPOSIT',
    };

    return await this.generatePDFCertificate(certificateData, { ...this.defaultConfig, ...config });
  }

  async generateShareCertificate(memberId: number, shareAmount: number, config?: Partial<CertificateConfig>): Promise<string> {
    const member = await this.memberRepository.findOne({ where: { id: memberId } });

    if (!member) {
      throw new NotFoundException(`Member with ID ${memberId} not found`);
    }

    const certificateData: CertificateData = {
      certificateNumber: await this.generateCertificateNumber('SH'),
      memberName: member.fullName,
      memberNumber: member.memberNumber,
      accountNumber: `SH${member.memberNumber}`,
      principalAmount: shareAmount,
      interestRate: 0,
      depositDate: member.createdAt,
      maturityDate: new Date(), // Shares don't have maturity
      maturityAmount: shareAmount,
      tenureMonths: 0,
      certificateType: 'SHARE',
    };

    return await this.generatePDFCertificate(certificateData, { ...this.defaultConfig, ...config });
  }

  private async generatePDFCertificate(data: CertificateData, config: CertificateConfig): Promise<string> {
    const fileName = `${data.certificateType}_${data.certificateNumber}_${Date.now()}.pdf`;
    const filePath = path.join(this.certificatesPath, fileName);

    // Fetch dynamic template
    let template;
    try {
      template = await this.templateService.findDefaultByAccountType(data.certificateType);
    } catch (e) {
      this.logger.warn(`No template found for ${data.certificateType}, falling back to static layout.`);
    }

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        if (template) {
          this.applyDynamicTemplate(doc, data, config, template);
        } else {
          // Fallback to static header
          this.addHeader(doc, config);
          // Certificate Title
          this.addCertificateTitle(doc, data.certificateType);
          // Certificate Content
          this.addCertificateContent(doc, data, config);
          // Footer
          this.addFooter(doc, config);
        }

        doc.end();

        stream.on('finish', () => {
          resolve(fileName);
        });

        stream.on('error', (error) => {
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private applyDynamicTemplate(
    doc: PDFKit.PDFDocument,
    data: CertificateData,
    config: CertificateConfig,
    template: any
  ): void {
    // 1. Add background/border if needed (can be expanded later)
    doc.rect(20, 20, 555, 802).stroke(); // Simple border

    // 2. Map data to keys (Dynamic Data Bridge)
    const dataMap: any = {
      ...config,
      ...data,
      // Formatters
      memberName: data.memberName.toUpperCase(),
      principalAmount: `Rs. ${data.principalAmount.toLocaleString('en-IN')}`,
      maturityAmount: `Rs. ${data.maturityAmount.toLocaleString('en-IN')}`,
      depositDate: data.depositDate.toLocaleDateString('en-IN'),
      maturityDate: data.maturityDate.toLocaleDateString('en-IN'),
      interestRate: `${data.interestRate}%`,
      todayDate: new Date().toLocaleDateString('en-IN'),
    };

    // 3. Process each field in the template
    template.fields.forEach((field: any) => {
      if (!field.isVisible) return;

      const value = dataMap[field.dataKey] || "";
      let displayText = value.toString();

      // Apply transformations
      if (field.transformMode === 'UPPER') displayText = displayText.toUpperCase();
      if (field.transformMode === 'LOWER') displayText = displayText.toLowerCase();
      if (field.transformMode === 'WORDS' && !isNaN(Number(value))) {
        displayText = numberToWords(Number(value));
      }

      // Calculate coordinates (1 row = 15 units, 1 col = 5 units - simplified grid)
      const x = 50 + (field.colPos * 8);
      const y = 60 + (field.rowPos * 18);

      doc.fontSize(10).font('Helvetica').text(displayText, x, y);
    });

    // 4. Handle Signature (usually fixed position or special field)
    const sigY = 700;
    doc.fontSize(10).text('Authorized Signatory', 400, sigY);
    if (config.signaturePath && fs.existsSync(config.signaturePath)) {
      doc.image(config.signaturePath, 400, sigY - 40, { width: 100 });
    }
  }

  private addHeader(doc: PDFKit.PDFDocument, config: CertificateConfig): void {
    // Add logo if available
    if (config.logoPath && fs.existsSync(config.logoPath)) {
      doc.image(config.logoPath, 50, 50, { width: 80 });
    }

    // Organization details
    doc.fontSize(20)
      .font('Helvetica-Bold')
      .text(config.organizationName, 150, 60, { align: 'center' });

    doc.fontSize(12)
      .font('Helvetica')
      .text(config.organizationAddress, 150, 85, { align: 'center' })
      .text(`Phone: ${config.organizationPhone} | Email: ${config.organizationEmail}`, 150, 100, { align: 'center' });

    // Decorative line
    doc.moveTo(50, 130)
      .lineTo(545, 130)
      .stroke();
  }

  private addCertificateTitle(doc: PDFKit.PDFDocument, type: string): void {
    let title = '';
    switch (type) {
      case 'FIXED_DEPOSIT':
        title = 'FIXED DEPOSIT CERTIFICATE';
        break;
      case 'RECURRING_DEPOSIT':
        title = 'RECURRING DEPOSIT CERTIFICATE';
        break;
      case 'SHARE':
        title = 'SHARE CERTIFICATE';
        break;
    }

    doc.fontSize(18)
      .font('Helvetica-Bold')
      .text(title, 50, 160, { align: 'center' });

    // Decorative line
    doc.moveTo(200, 185)
      .lineTo(395, 185)
      .stroke();
  }

  private addCertificateContent(doc: PDFKit.PDFDocument, data: CertificateData, config: CertificateConfig): void {
    const startY = 220;
    let currentY = startY;

    // Certificate details
    doc.fontSize(12).font('Helvetica');

    // Certificate number
    doc.text(`Certificate No: ${data.certificateNumber}`, 50, currentY);
    doc.text(`Date: ${new Date().toLocaleDateString('en-IN')}`, 400, currentY);
    currentY += 30;

    // Main content
    doc.fontSize(14).font('Helvetica');

    const content = this.getCertificateContent(data);
    doc.text(content, 50, currentY, { width: 495, align: 'justify' });
    currentY += 120;

    // Details table
    this.addDetailsTable(doc, data, currentY);
    currentY += 200;

    // Terms and conditions
    doc.fontSize(10).font('Helvetica');
    const terms = this.getTermsAndConditions(data.certificateType);
    doc.text('Terms & Conditions:', 50, currentY, { underline: true });
    currentY += 15;
    doc.text(terms, 50, currentY, { width: 495 });
    currentY += 80;

    // Signature section
    this.addSignatureSection(doc, config, currentY);
  }

  private getCertificateContent(data: CertificateData): string {
    const formatCurrency = (amount: number) => `₹${amount.toLocaleString('en-IN')}`;

    switch (data.certificateType) {
      case 'FIXED_DEPOSIT':
        return `This is to certify that ${data.memberName} (Member No: ${data.memberNumber}) has deposited ${formatCurrency(data.principalAmount)} in our Fixed Deposit Scheme under Account No: ${data.accountNumber}. The deposit was made on ${data.depositDate.toLocaleDateString('en-IN')} for a period of ${data.tenureMonths} months at an interest rate of ${data.interestRate}% per annum. The deposit will mature on ${data.maturityDate.toLocaleDateString('en-IN')} with a maturity value of ${formatCurrency(data.maturityAmount)}.`;

      case 'RECURRING_DEPOSIT':
        return `This is to certify that ${data.memberName} (Member No: ${data.memberNumber}) has opened a Recurring Deposit Account No: ${data.accountNumber} with us. The monthly installment amount is ${formatCurrency(data.principalAmount / data.tenureMonths)} for a period of ${data.tenureMonths} months at an interest rate of ${data.interestRate}% per annum. The deposit was started on ${data.depositDate.toLocaleDateString('en-IN')} and will mature on ${data.maturityDate.toLocaleDateString('en-IN')} with a maturity value of ${formatCurrency(data.maturityAmount)}.`;

      case 'SHARE':
        return `This is to certify that ${data.memberName} (Member No: ${data.memberNumber}) is a member of our organization and holds shares worth ${formatCurrency(data.principalAmount)} as per our records. This certificate is issued as proof of membership and shareholding in the organization.`;

      default:
        return '';
    }
  }

  private addDetailsTable(doc: PDFKit.PDFDocument, data: CertificateData, startY: number): void {
    const tableData = [
      ['Member Name', data.memberName],
      ['Member Number', data.memberNumber],
      ['Account Number', data.accountNumber],
      ['Principal Amount', `₹${data.principalAmount.toLocaleString('en-IN')}`],
    ];

    if (data.certificateType !== 'SHARE') {
      tableData.push(
        ['Interest Rate', `${data.interestRate}% per annum`],
        ['Deposit Date', data.depositDate.toLocaleDateString('en-IN')],
        ['Maturity Date', data.maturityDate.toLocaleDateString('en-IN')],
        ['Maturity Amount', `₹${data.maturityAmount.toLocaleString('en-IN')}`],
      );
    }

    // Table header
    doc.rect(50, startY, 495, 20).fill('#f0f0f0');
    doc.fillColor('black')
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('Deposit Details', 52, startY + 5);

    let currentY = startY + 25;

    // Table rows
    tableData.forEach((row, index) => {
      const rowY = currentY + (index * 20);

      // Alternate row colors
      if (index % 2 === 0) {
        doc.rect(50, rowY, 495, 20).fill('#f9f9f9');
      }

      doc.fillColor('black')
        .fontSize(10)
        .font('Helvetica-Bold')
        .text(row[0], 55, rowY + 5, { width: 200 })
        .font('Helvetica')
        .text(row[1], 260, rowY + 5, { width: 280 });
    });

    // Table border
    doc.rect(50, startY, 495, 25 + (tableData.length * 20)).stroke();
  }

  private getTermsAndConditions(type: string): string {
    const common = '1. This certificate is issued based on the records maintained by the organization.\n2. In case of any discrepancy, the organization\'s records will be final.\n3. This certificate should be produced for any transactions related to the account.\n4. Loss of this certificate should be immediately reported to the organization.';

    switch (type) {
      case 'FIXED_DEPOSIT':
        return `${common}\n5. Premature withdrawal may attract penalty as per organization rules.\n6. Interest will be calculated as per the prevailing rates at the time of deposit.\n7. TDS will be deducted as per Income Tax rules.`;

      case 'RECURRING_DEPOSIT':
        return `${common}\n5. Regular monthly installments are mandatory to keep the account active.\n6. Default in payments may attract penalty charges.\n7. Premature closure may result in reduced interest rates.`;

      case 'SHARE':
        return `${common}\n5. Shares are non-transferable without prior approval from the organization.\n6. Dividend will be paid as per the organization's profit-sharing policy.\n7. Member rights and obligations are governed by the organization's bylaws.`;

      default:
        return common;
    }
  }

  private addSignatureSection(doc: PDFKit.PDFDocument, config: CertificateConfig, startY: number): void {
    // Date and place
    doc.fontSize(10)
      .text(`Date: ${new Date().toLocaleDateString('en-IN')}`, 50, startY);
    doc.text('Place: _______________', 50, startY + 15);

    // Signature
    if (config.signaturePath && fs.existsSync(config.signaturePath)) {
      doc.image(config.signaturePath, 400, startY - 10, { width: 100 });
    }

    doc.text('For ' + config.organizationName, 400, startY + 40);
    doc.moveTo(400, startY + 55)
      .lineTo(500, startY + 55)
      .stroke();
    doc.text(config.authorizedSignatory, 400, startY + 60);
    doc.text(config.designation, 400, startY + 75);
  }

  private addFooter(doc: PDFKit.PDFDocument, config: CertificateConfig): void {
    const pageHeight = doc.page.height;

    doc.fontSize(8)
      .text('This is a computer-generated certificate and does not require a physical signature.', 50, pageHeight - 50, { align: 'center' });
  }

  private async generateCertificateNumber(type: 'FD' | 'RD' | 'SH'): Promise<string> {
    const year = new Date().getFullYear().toString();
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');

    // Generate a random 4-digit number for uniqueness
    const random = Math.floor(1000 + Math.random() * 9000);

    return `${type}CERT${year}${month}${random}`;
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // Utility method to get certificate file path
  getCertificateFilePath(fileName: string): string {
    return path.join(this.certificatesPath, fileName);
  }

  // Method to delete certificate file
  async deleteCertificate(fileName: string): Promise<void> {
    const filePath = this.getCertificateFilePath(fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
