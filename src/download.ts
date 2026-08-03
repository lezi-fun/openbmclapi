import {validateFile} from './file.js'
import type {IStorage} from './storage/base.storage.js'
import {hashToFilename} from './util.js'

export class FileIntegrityError extends Error {
  public constructor(hash: string) {
    super(`文件/download/${hash}校验失败`)
    this.name = 'FileIntegrityError'
  }
}

export async function storeVerifiedDownload(
  storage: Pick<IStorage, 'writeFile'>,
  hash: string,
  body: Buffer,
  mtime = Date.now(),
): Promise<void> {
  if (!validateFile(body, hash)) {
    throw new FileIntegrityError(hash)
  }

  await storage.writeFile(hashToFilename(hash), body, {
    path: `/download/${hash}`,
    hash,
    size: body.length,
    mtime,
  })
}
