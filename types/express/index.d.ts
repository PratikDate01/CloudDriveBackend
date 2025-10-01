import * as express from 'express';
import { File } from 'multer';

declare global {
  namespace Express {
    interface Request {
      file?: File;
      files?: File[];
    }
  }
}
