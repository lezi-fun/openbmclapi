import type {Response} from 'express'
import {join} from 'node:path'
import type {Config} from '../config.js'
import {logger} from '../logger.js'
import {IFileInfo, IGCCounter} from '../types.js'
import {AlistWebdavStorage} from './alist-webdav.storage.js'
import {FileStorage} from './file.storage.js'
import {MinioStorage} from './minio.storage.js'
import {OssStorage} from './oss.storage.js'
import type {StorageDownloadRequest, StorageDownloadResult} from './download-response.js'

export interface IStorage {
  init?(): Promise<void>

  check(): Promise<boolean>

  writeFile(path: string, content: Buffer, fileInfo: IFileInfo): Promise<void>

  exists(path: string): Promise<boolean>

  getMissingFiles(files: IFileInfo[]): Promise<IFileInfo[]>

  gc(files: {path: string; hash: string; size: number}[]): Promise<IGCCounter>

  serve(request: StorageDownloadRequest, res: Response): Promise<StorageDownloadResult>
}

export function getStorage(config: Config): IStorage {
  let storage: IStorage
  switch (config.storage) {
    case 'file':
      storage = new FileStorage(join(process.cwd(), 'cache'))
      break
    case 'alist':
      storage = new AlistWebdavStorage(config.storageOpts)
      break
    case 'minio':
      storage = new MinioStorage(config.storageOpts)
      break
    case 'oss':
      storage = new OssStorage(config.storageOpts)
      break
    default:
      throw new Error(`未知的存储类型${config.storage}`)
  }
  logger.info(`使用存储类型: ${config.storage}`)
  return storage
}
