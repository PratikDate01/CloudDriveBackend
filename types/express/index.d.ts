import type { File } from "multer";

declare global {
  namespace Express {
    export interface Request {
      file?: File;
      files?: File[];
    }
  }
}

export {};