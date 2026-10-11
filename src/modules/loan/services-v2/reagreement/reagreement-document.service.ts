import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PassThrough, Writable } from 'stream';
import * as PImage from 'pureimage';
import {
    AGREEMENT_WIDTH,
    SIGNATURE_BAND_LINES,
    AgreementData,
    AgreementLayout,
    SignatureSlot,
    buildAgreementLayout,
} from './reagreement-agreement.layout';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

/** DejaVu Sans Mono is bundled under backend/assets/fonts (same depth for src/ and dist/). */
const FONT_DIR = path.resolve(__dirname, '../../../../../assets/fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSansMono.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSansMono-Bold.ttf');
const CHAR_ASPECT = 0.602; // DejaVu Sans Mono advance width / font size

export interface SignatureImage {
    key: string;
    mbno: string | null;
    buffer: Buffer | null;
    mime: 'image/png' | 'image/jpeg' | null;
    sha256: string | null;
    source: string | null;
}

export interface RenderedAgreement {
    text: string;
    textSha256: string;
    pdf: Buffer | null;
    png: Buffer | null;
    pdfSha256: string | null;
    pngSha256: string | null;
    signaturesUsed: Array<{ key: string; mbno: string | null; used: boolean; sha256: string | null; source: string | null }>;
    renderError: string | null;
}

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Renders the stored agreement: text (always), PDF and PNG with the member's and
 * sureties' signature images. All three come from the same layout so they cannot
 * disagree. PDF/PNG failure never loses the text snapshot — it is reported in
 * `renderError` and can be regenerated later from the stored JSON.
 */
@Injectable()
export class ReagreementDocumentService {
    private readonly logger = new Logger(ReagreementDocumentService.name);
    private fontsRegistered = false;

    constructor(private readonly dataSource: DataSource) { }

    // ------------------------------------------------------------------ text
    buildLayout(data: AgreementData): AgreementLayout {
        return buildAgreementLayout(data);
    }

    renderText(layout: AgreementLayout): string {
        return layout.lines.join('\n') + '\n';
    }

    // ------------------------------------------------------------ signatures
    async loadSignatures(layout: AgreementLayout, runner?: QueryRunner | DataSource): Promise<SignatureImage[]> {
        const db = runner ?? this.dataSource;
        const out: SignatureImage[] = [];
        const seen = new Map<string, SignatureImage>();
        for (const slot of layout.signatureSlots) {
            if (!slot.mbno) {
                out.push({ key: slot.key, mbno: null, buffer: null, mime: null, sha256: null, source: null });
                continue;
            }
            if (seen.has(slot.mbno)) {
                const prev = seen.get(slot.mbno)!;
                out.push({ ...prev, key: slot.key });
                continue;
            }
            let img: SignatureImage = { key: slot.key, mbno: slot.mbno, buffer: null, mime: null, sha256: null, source: null };
            try {
                const rows = await db.query(
                    `SELECT signature_image_path FROM member_master WHERE mbno = $1`, [slot.mbno],
                );
                const rel: string | null = rows[0]?.signature_image_path || null;
                if (rel) {
                    const full = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
                    if (fs.existsSync(full)) {
                        const buffer = fs.readFileSync(full);
                        const mime = this.sniffMime(buffer);
                        if (mime) img = { key: slot.key, mbno: slot.mbno, buffer, mime, sha256: sha256(buffer), source: rel };
                    }
                }
            } catch (e: any) {
                this.logger.warn(`Signature lookup failed for member ${slot.mbno}: ${e.message}`);
            }
            seen.set(slot.mbno, img);
            out.push(img);
        }
        return out;
    }

    private sniffMime(b: Buffer): 'image/png' | 'image/jpeg' | null {
        if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
        if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
        return null;
    }

    // ------------------------------------------------------------------- PDF
    async renderPdf(layout: AgreementLayout, sigs: SignatureImage[], draft: boolean): Promise<Buffer> {
        const fontSize = 9;
        const lh = 11.4;
        const margin = 36;
        const charW = CHAR_ASPECT * fontSize;
        const doc = new PDFDocument({ size: 'A4', margin, info: { Title: 'Loan Re-agreement', Producer: 'Espat Society' } });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        const done = new Promise<Buffer>((resolve, reject) => {
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
        });

        doc.registerFont('Mono', FONT_REGULAR);
        doc.registerFont('MonoB', FONT_BOLD);
        const pageH = doc.page.height;
        const bottom = pageH - margin;
        const sigByKey = new Map(sigs.map(s => [s.key, s]));
        const slotsByLine = new Map<number, SignatureSlot[]>();
        for (const s of layout.signatureSlots) {
            const arr = slotsByLine.get(s.lineIndex) || [];
            arr.push(s);
            slotsByLine.set(s.lineIndex, arr);
        }

        const watermark = () => {
            if (!draft) return;
            doc.save();
            doc.fillColor('#000000').fillOpacity(0.07);
            doc.rotate(-40, { origin: [doc.page.width / 2, doc.page.height / 2] });
            doc.font('MonoB').fontSize(110).text('DRAFT', 60, doc.page.height / 2 - 60, { lineBreak: false });
            doc.restore();
        };
        watermark();

        let y = margin;
        for (let i = 0; i < layout.lines.length; i++) {
            const bandSlots = slotsByLine.get(i);
            const need = bandSlots ? (SIGNATURE_BAND_LINES + 3) * lh : lh;
            if (y + need > bottom) {
                doc.addPage();
                watermark();
                y = margin;
            }
            if (bandSlots) {
                for (const slot of bandSlots) {
                    const sig = sigByKey.get(slot.key);
                    if (sig?.buffer) {
                        try {
                            doc.image(sig.buffer, margin + slot.column * charW, y,
                                { fit: [slot.widthCols * charW, SIGNATURE_BAND_LINES * lh - 2], align: 'left', valign: 'bottom' });
                        } catch (e: any) {
                            this.logger.warn(`PDF signature draw failed (${slot.key}): ${e.message}`);
                        }
                    }
                }
            }
            const line = layout.lines[i];
            const bold = /^\s*(LOAN RE-AGREEMENT|\*\*\* DRAFT)/.test(line);
            doc.fillColor('#000000').font(bold ? 'MonoB' : 'Mono').fontSize(fontSize)
                .text(line, margin, y, { lineBreak: false, characterSpacing: 0 });
            y += lh;
        }
        doc.end();
        return done;
    }

    // ------------------------------------------------------------------- PNG
    private ensureFonts() {
        if (this.fontsRegistered) return;
        PImage.registerFont(FONT_REGULAR, 'DejaVuMono').loadSync();
        PImage.registerFont(FONT_BOLD, 'DejaVuMonoBold').loadSync();
        this.fontsRegistered = true;
    }

    async renderPng(layout: AgreementLayout, sigs: SignatureImage[]): Promise<Buffer> {
        this.ensureFonts();
        const fontPx = 20;
        const charW = CHAR_ASPECT * fontPx;
        const lh = 26;
        const marginX = 70;
        const marginY = 60;
        const width = Math.ceil(marginX * 2 + AGREEMENT_WIDTH * charW);
        const height = Math.ceil(marginY * 2 + layout.lines.length * lh);
        const img = PImage.make(width, height);
        const ctx = img.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#000000';

        const sigByKey = new Map(sigs.map(s => [s.key, s]));
        for (const slot of layout.signatureSlots) {
            const sig = sigByKey.get(slot.key);
            if (!sig?.buffer || !sig.mime) continue;
            try {
                const bmp = sig.mime === 'image/png'
                    ? await PImage.decodePNGFromStream(new PassThrough().end(sig.buffer))
                    : await PImage.decodeJPEGFromStream(new PassThrough().end(sig.buffer));
                const boxW = slot.widthCols * charW;
                const boxH = SIGNATURE_BAND_LINES * lh - 4;
                const scale = Math.min(boxW / bmp.width, boxH / bmp.height, 1);
                const w = Math.max(1, Math.floor(bmp.width * scale));
                const h = Math.max(1, Math.floor(bmp.height * scale));
                const x = marginX + slot.column * charW;
                const y = marginY + slot.lineIndex * lh + (boxH - h) + 2;
                ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, x, y, w, h);
            } catch (e: any) {
                this.logger.warn(`PNG signature draw failed (${slot.key}): ${e.message}`);
            }
        }

        layout.lines.forEach((line, i) => {
            const bold = /^\s*(LOAN RE-AGREEMENT|\*\*\* DRAFT)/.test(line);
            ctx.font = `${fontPx}px ${bold ? 'DejaVuMonoBold' : 'DejaVuMono'}`;
            ctx.fillText(line, marginX, marginY + i * lh + fontPx);
        });

        const chunks: Buffer[] = [];
        const sink = new Writable({
            write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
        });
        await PImage.encodePNGToStream(img, sink);
        return Buffer.concat(chunks);
    }

    // ------------------------------------------------------------ all-in-one
    async renderAll(data: AgreementData, runner?: QueryRunner | DataSource): Promise<RenderedAgreement & { layout: AgreementLayout }> {
        const layout = this.buildLayout(data);
        const text = this.renderText(layout);
        const result: RenderedAgreement & { layout: AgreementLayout } = {
            layout, text, textSha256: sha256(text),
            pdf: null, png: null, pdfSha256: null, pngSha256: null,
            signaturesUsed: [], renderError: null,
        };
        let sigs: SignatureImage[] = [];
        try {
            sigs = await this.loadSignatures(layout, runner);
            result.signaturesUsed = sigs.map(s => ({ key: s.key, mbno: s.mbno, used: !!s.buffer, sha256: s.sha256, source: s.source }));
        } catch (e: any) {
            this.logger.warn(`Signature load failed: ${e.message}`);
        }
        try {
            result.pdf = await this.renderPdf(layout, sigs, data.status === 'DRAFT');
            result.pdfSha256 = sha256(result.pdf);
        } catch (e: any) {
            result.renderError = `PDF: ${e.message}`;
            this.logger.error(`PDF render failed: ${e.stack || e.message}`);
        }
        try {
            result.png = await this.renderPng(layout, sigs);
            result.pngSha256 = sha256(result.png);
        } catch (e: any) {
            result.renderError = `${result.renderError ? result.renderError + '; ' : ''}PNG: ${e.message}`;
            this.logger.error(`PNG render failed: ${e.stack || e.message}`);
        }
        return result;
    }
}
