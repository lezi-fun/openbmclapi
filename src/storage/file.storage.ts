import type {Response} from 'express'
import {mkdir, readdir, rm, stat, unlink, writeFile} from 'node:fs/promises'
import {join, sep} from 'node:path'
import pMap from 'p-map'
import {grayText} from '../console-style.js'
import {pathExists, writeFileAtomic} from '../fs.js'
import {logger} from '../logger.js'
import {abortReason} from '../runtime-lifecycle.js'
import {IFileInfo, IGCCounter} from '../types.js'
import {hashToFilename} from '../util.js'
import type {IStorage} from './base.storage.js'
import {
  applyAttachmentHeader,
  type StorageDownloadRequest,
  type StorageDownloadResult,
  successfulDownload,
} from './download-response.js'

export class FileStorage implements IStorage {
  constructor(public readonly cacheDir: string) {}

  public async check(): Promise<boolean> {
    try {
      await mkdir(this.cacheDir, {recursive: true})
      await writeFile(join(this.cacheDir, '.check'), '')
      return true
    } catch (e) {
      logger.error(e, '存储检查异常')
      return false
    } finally {
      await rm(join(this.cacheDir, '.check'), {recursive: true, force: true})
    }
  }

  public async writeFile(path: string, content: Buffer): Promise<void> {
    await writeFileAtomic(join(this.cacheDir, path), content)
  }

  public async exists(path: string): Promise<boolean> {
    return await pathExists(join(this.cacheDir, path))
  }

  public async getMissingFiles(files: IFileInfo[], signal?: AbortSignal): Promise<IFileInfo[]> {
    const missingFiles = await pMap(
      files,
      async (file) => {
        const st = await stat(join(this.cacheDir, hashToFilename(file.hash))).catch(() => null)
        return st?.size !== file.size ? file : undefined
      },
      {
        concurrency: 1e3,
        signal,
      },
    )
    return missingFiles.filter((file) => file !== undefined)
  }

  public async gc(files: {path: string; hash: string; size: number}[], signal?: AbortSignal): Promise<IGCCounter> {
    const counter = {count: 0, size: 0}
    const fileSet = new Set<string>()
    for (const file of files) {
      fileSet.add(hashToFilename(file.hash))
    }
    const queue = [this.cacheDir]
    do {
      signal?.throwIfAborted()
      const dir = queue.pop()
      if (!dir) break
      const entries = await readdir(dir)
      for (const entry of entries) {
        signal?.throwIfAborted()
        const p = join(dir, entry)
        const s = await stat(p)
        if (s.isDirectory()) {
          queue.push(p)
          continue
        }
        const cacheDirWithSep = this.cacheDir + sep
        if (!fileSet.has(p.replace(cacheDirWithSep, ''))) {
          logger.info(grayText(`delete expire file: ${p}`))
          await unlink(p)
          counter.count++
          counter.size += s.size
        }
      }
    } while (queue.length !== 0)
    return counter
  }

  public async serve(request: StorageDownloadRequest, res: Response): Promise<StorageDownloadResult> {
    request.signal?.throwIfAborted()
    applyAttachmentHeader(res, request)
    const path = this.getAbsolutePath(request.hashPath)
    const file = await stat(path)
    request.signal?.throwIfAborted()
    const result = successfulDownload(file.size, request)
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        if (request.signal) {
          const reason = abortReason(request.signal)
          res.destroy(reason)
          reject(reason)
        }
      }
      request.signal?.addEventListener('abort', onAbort, {once: true})
      if (request.signal?.aborted) {
        request.signal.removeEventListener('abort', onAbort)
        reject(abortReason(request.signal))
        return
      }
      res.sendFile(path, {maxAge: '30d'}, (err) => {
        request.signal?.removeEventListener('abort', onAbort)
        if (request.signal?.aborted) {
          reject(abortReason(request.signal))
          return
        }
        if (!err || err?.message === 'Request aborted' || err?.message === 'write EPIPE') {
          resolve(result)
        } else {
          reject(err)
        }
      })
    })
  }

  private getAbsolutePath(path: string): string {
    return join(this.cacheDir, path)
  }
}
