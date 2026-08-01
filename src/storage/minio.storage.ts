import colors from 'colors/safe.js'
import type {Response} from 'express'
import Keyv from 'keyv'
import {BucketItem, Client, S3Error} from 'minio'
import ms from 'ms'
import {posix} from 'path'
import {z} from 'zod'
import {logger} from '../logger.js'
import {IFileInfo, IGCCounter} from '../types.js'
import {getSize} from '../util.js'
import type {DownloadRequest, IStorage} from './base.storage.js'
import {minioObjectHash, minioObjectKey, minioObjectPrefix, minioRelativePath} from './minio-path.js'

const storageConfigSchema = z.object({
  url: z.string(),
  internalUrl: z.string().optional(),
})

export class MinioStorage implements IStorage {
  /** Map<hash, FileInfo> */
  protected files = new Map<string, {size: number; path: string}>()
  protected existsCache = new Keyv({
    ttl: ms('1h'),
  })

  private readonly client: Client
  private readonly internalClient: Client
  private readonly prefix: string
  private readonly bucket: string

  constructor(storageConfig: unknown) {
    const config = storageConfigSchema.parse(storageConfig)
    const url = new URL(config.url)
    this.client = new Client({
      endPoint: url.hostname,
      accessKey: url.username,
      secretKey: url.password,
      port: parseInt(url.port, 10),
      useSSL: url.protocol === 'https:',
      region: url.searchParams.get('region') ?? undefined,
    })
    if (config.internalUrl) {
      const internalUrl = new URL(config.internalUrl)
      this.internalClient = new Client({
        endPoint: internalUrl.hostname,
        accessKey: internalUrl.username,
        secretKey: internalUrl.password,
        port: parseInt(internalUrl.port, 10),
        useSSL: internalUrl.protocol === 'https:',
        region: url.searchParams.get('region') ?? undefined,
      })
    } else {
      this.internalClient = this.client
    }
    const [bucket, ...prefix] = url.pathname.split('/').filter(Boolean)
    this.bucket = bucket
    this.prefix = prefix.join('/')
  }

  public async check(): Promise<boolean> {
    try {
      await this.internalClient.putObject(
        this.bucket,
        minioObjectKey(this.prefix, '.check'),
        Buffer.from(Date.now().toString()),
      )
      await this.client.putObject(
        this.bucket,
        minioObjectKey(this.prefix, '.check'),
        Buffer.from(Date.now().toString()),
      )
      return true
    } catch (e) {
      logger.error(e, '存储检查异常')
      return false
    } finally {
      try {
        await this.internalClient.removeObject(this.bucket, minioObjectKey(this.prefix, '.check'))
        await this.client.removeObject(this.bucket, minioObjectKey(this.prefix, '.check'))
      } catch (e) {
        logger.warn(e, '删除临时文件失败')
      }
    }
  }

  public async exists(path: string): Promise<boolean> {
    try {
      if (await this.existsCache.has(path)) {
        return true
      }
      await this.internalClient.statObject(this.bucket, minioObjectKey(this.prefix, path))
      await this.existsCache.set(path, true)
      return true
    } catch (e) {
      if (e instanceof S3Error) {
        if (e.code === 'NoSuchKey') {
          return false
        }
      }
      throw e
    }
  }

  public async express(
    hashPath: string,
    req: DownloadRequest,
    res: Response,
  ): Promise<{
    bytes: number
    hits: number
  }> {
    const path = minioObjectKey(this.prefix, hashPath)
    let resHeaders: {'response-content-disposition': string} | undefined
    const fileInfo = this.files.get(req.params.hash)
    if (fileInfo) {
      const name = posix.basename(fileInfo.path)
      resHeaders = {
        'response-content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      }
    }
    const url = await this.client.presignedGetObject(this.bucket, path, 60, resHeaders)
    res.redirect(url)
    const size = getSize(this.files.get(req.params.hash)?.size ?? 0, req.headers.range)
    return {bytes: size, hits: 1}
  }

  public async gc(files: {path: string; hash: string; size: number}[]): Promise<IGCCounter> {
    const counter = {count: 0, size: 0}
    const fileSet = new Set<string>()
    for (const file of files) {
      fileSet.add(file.hash)
    }
    const scanStream = this.internalClient.listObjectsV2(this.bucket, minioObjectPrefix(this.prefix))
    for await (const file of scanStream) {
      const item = file as BucketItem
      if (!item.name) continue
      const path = minioRelativePath(this.prefix, item.name)
      if (!path) continue
      const hash = minioObjectHash(path)
      if (!fileSet.has(hash)) {
        logger.info(colors.gray(`delete expire file: ${path}`))
        await this.internalClient.removeObject(this.bucket, item.name)
        this.files.delete(hash)
        await this.existsCache.delete(path)
        counter.count++
        counter.size += item.size
      }
    }
    return counter
  }

  public async getMissingFiles(files: IFileInfo[]): Promise<IFileInfo[]> {
    const remoteFileList = new Map(files.map((file) => [file.hash, file]))
    if (this.files.size !== 0) {
      for (const hash of this.files.keys()) {
        remoteFileList.delete(hash)
      }
      return [...remoteFileList.values()]
    }

    const scanStream = this.internalClient.listObjectsV2(this.bucket, minioObjectPrefix(this.prefix), true)
    for await (const file of scanStream) {
      const item = file as BucketItem
      if (!item.name) continue
      const path = minioRelativePath(this.prefix, item.name)
      if (!path) continue
      const hash = minioObjectHash(path)
      const existsFile = remoteFileList.get(hash)
      if (existsFile && existsFile.size === item.size) {
        this.files.set(hash, {size: item.size, path})
        remoteFileList.delete(hash)
      }
    }
    return [...remoteFileList.values()]
  }

  public async writeFile(path: string, content: Buffer, fileInfo: IFileInfo): Promise<void> {
    await this.internalClient.putObject(this.bucket, minioObjectKey(this.prefix, path), content)
    this.files.set(fileInfo.hash, fileInfo)
  }
}
