/**
 * Minimal ambient typing for the "archiver" package's actual runtime API.
 * @types/archiver@8.0.0 doesn't match archiver@8's real runtime shape closely
 * enough to use directly (see git history on this file for the first, wrong
 * attempt: archiver@8 dropped the classic callable `archiver(format, opts)`
 * factory entirely — the real export is `{ ZipArchive, TarArchive, ... }`
 * classes, verified via `node -e "require('archiver').ZipArchive"`).
 */
declare module "archiver" {
  import { Transform } from "stream";

  interface ZipArchiveOptions {
    zlib?: { level?: number };
  }

  export class ZipArchive extends Transform {
    constructor(options?: ZipArchiveOptions);
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    directory(dirPath: string, destPath: string | false): this;
    finalize(): Promise<void>;
  }
}
