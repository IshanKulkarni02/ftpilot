/**
 * Minimal ambient typing for the "archiver" package's actual runtime API.
 * @types/archiver@8.0.0 only exports classes/interfaces with no factory
 * function, even though archiver@8's real export is `archiver(format, opts)`
 * (see node_modules/archiver/index.js) — so we can't use it as-is.
 */
declare module "archiver" {
  import { Transform } from "stream";

  interface ArchiverOptions {
    zlib?: { level?: number };
  }

  interface Archiver extends Transform {
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    directory(dirPath: string, destPath: string | false): Archiver;
    finalize(): Promise<void>;
  }

  function archiver(format: "zip" | "tar", options?: ArchiverOptions): Archiver;
  export = archiver;
}
