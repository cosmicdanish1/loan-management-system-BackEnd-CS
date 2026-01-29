import { BadRequestException } from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { diskStorage } from 'multer';
import { extname } from 'path';

export const signatureUploadConfig: MulterOptions = {
  storage: diskStorage({
    destination: './uploads/signatures',
    filename: (req, file, callback) => {
      const memberId = req.params.id || 'unknown';
      const timestamp = Date.now();
      const ext = extname(file.originalname);
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
