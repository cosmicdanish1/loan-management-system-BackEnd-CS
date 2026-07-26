import { BadRequestException } from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { diskStorage } from 'multer';
import { extname } from 'path';
import * as fs from 'fs';

export const photoUploadConfig: MulterOptions = {
  storage: diskStorage({
    destination: (req, _file, callback) => {
      const type = req.params.type || 'general';
      const dir = `./uploads/photos/${type}`;
      fs.mkdirSync(dir, { recursive: true });
      callback(null, dir);
    },
    filename: (req, file, callback) => {
      const mbno = req.params.mbno || 'unknown';
      const type = (req.params.type || 'photo').toUpperCase();
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
      const mbno = req.params.mbno || 'unknown';
      const dir = `./uploads/documents/${mbno}`;
      fs.mkdirSync(dir, { recursive: true });
      callback(null, dir);
    },
    filename: (req, file, callback) => {
      const mbno = req.params.mbno || 'unknown';
      const docType = (req.body?.docType || 'DOC').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
      const ext = extname(file.originalname) || '';
      callback(null, `${docType || 'DOC'}_${mbno}_${Date.now()}${ext}`);
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
      const memberId = req.params.id || req.params.mbno || 'unknown';
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
