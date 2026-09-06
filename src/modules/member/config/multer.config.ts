import { BadRequestException } from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { diskStorage } from 'multer';
import { extname } from 'path';
import * as fs from 'fs';

// BUG FIX (path traversal): destination/filename builders below used
// req.params.mbno / req.params.type / req.body.docType directly in filesystem
// paths. Confirmed live that mbno="..%2Ftraversal_poc_TEST" made multer create
// a directory outside the intended uploads/documents/ scoping. Every one of
// these values is attacker-controlled (URL/body), so every use is stripped to
// a safe charset first — no dots, slashes, or path separators can survive.
const sanitizeSegment = (value: unknown, fallback: string): string => {
  const cleaned = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || fallback;
};

export const photoUploadConfig: MulterOptions = {
  storage: diskStorage({
    destination: (req, _file, callback) => {
      const type = sanitizeSegment(req.params.type, 'general');
      const dir = `./uploads/photos/${type}`;
      fs.mkdirSync(dir, { recursive: true });
      callback(null, dir);
    },
    filename: (req, file, callback) => {
      const mbno = sanitizeSegment(req.params.mbno, 'unknown');
      const type = sanitizeSegment(req.params.type, 'photo').toUpperCase();
      const ext = extname(file.originalname) || '.jpg';
      callback(null, `${type}_${mbno}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype)) {
      return callback(new BadRequestException('Only JPEG and PNG images are allowed'), false);
    }
    callback(null, true);
  },
};

export const documentUploadConfig: MulterOptions = {
  storage: diskStorage({
    destination: (req, _file, callback) => {
      const mbno = sanitizeSegment(req.params.mbno, 'unknown');
      const dir = `./uploads/documents/${mbno}`;
      fs.mkdirSync(dir, { recursive: true });
      callback(null, dir);
    },
    filename: (req, file, callback) => {
      const mbno = sanitizeSegment(req.params.mbno, 'unknown');
      const docType = sanitizeSegment(req.body?.docType, 'DOC').toUpperCase();
      const ext = extname(file.originalname) || '';
      callback(null, `${docType}_${mbno}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10MB (KYC scans/PDFs)
  fileFilter: (_req, file, callback) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      return callback(new BadRequestException('Only JPEG, PNG and PDF files are allowed'), false);
    }
    callback(null, true);
  },
};

export const signatureUploadConfig: MulterOptions = {
  storage: diskStorage({
    destination: './uploads/signatures',
    filename: (req, file, callback) => {
      // Works for both /:id/signature (TypeORM) and /master/:mbno/signature (member_master)
      const memberId = sanitizeSegment(req.params.id || req.params.mbno, 'unknown');
      const timestamp = Date.now();
      const ext = extname(file.originalname) || '.png';
      callback(null, `SIG_${memberId}_${timestamp}${ext}`);
    },
  }),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
    files: 1,
  },
  fileFilter: (req, file, callback) => {
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png'];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return callback(
        new BadRequestException(
          'Invalid file type. Only JPEG and PNG images are allowed',
        ),
        false,
      );
    }

    callback(null, true);
  },
};
