import type {Response} from 'express'
import got, {type Response as GotResponse} from 'got'
import Keyv from 'keyv'
import {KeyvFile} from 'keyv-file'
import ms from 'ms'
import {join} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {z} from 'zod'
import {fromZodError} from 'zod-validation-error'
import {
  applyAttachmentHeader,
  copyDownloadHeaders,
  type StorageDownloadRequest,
  type StorageDownloadResult,
  successfulDownload,
} from './download-response.js'
import {WebdavStorage} from './webdav.storage.js'

const storageConfigSchema = WebdavStorage.configSchema.extend({
  cacheTtl: z.union([z.string().optional(), z.number().int()]).default('1h'),
})

export class AlistWebdavStorage extends WebdavStorage {
  public readonly configSchema = storageConfigSchema

  protected readonly redirectUrlCache: Keyv<string>
  protected readonly storageConfig: z.infer<typeof storageConfigSchema>

  constructor(storageConfig: unknown) {
    super(storageConfig)
    try {
      this.storageConfig = this.configSchema.parse(storageConfig)
    } catch (e) {
      if (e instanceof z.ZodError) {
        throw new Error(`alist存储选项无效: ${fromZodError(e).message}`, {cause: e})
      } else {
        throw new Error('alist存储选项无效', {cause: e})
      }
    }
    let ttl: number
    if (typeof this.storageConfig.cacheTtl === 'string') {
      ttl = ms(this.storageConfig.cacheTtl as ms.StringValue)
    } else {
      ttl = this.storageConfig.cacheTtl
    }
    this.redirectUrlCache = new Keyv<string>({
      namespace: 'redirectUrl',
      ttl,
      store: new KeyvFile({
        filename: join(process.cwd(), 'cache', 'redirectUrl.json'),
        writeDelay: ms('1m'),
      }),
    })
  }

  public override async serve(request: StorageDownloadRequest, res: Response): Promise<StorageDownloadResult> {
    request.signal?.throwIfAborted()
    applyAttachmentHeader(res, request)
    if (this.emptyFiles.has(request.hashPath)) {
      res.end()
      return {bytes: 0, hits: 1}
    }
    const fileSize = this.files.get(request.hash)?.size ?? 0
    const cachedUrl = await this.redirectUrlCache.get(request.hashPath)
    if (request.attachmentName) {
      const path = join(this.basePath, request.hashPath)
      return await this.proxyDownload(cachedUrl ?? this.client.getFileDownloadLink(path), request, res, fileSize)
    }
    if (cachedUrl) {
      res.status(302).location(cachedUrl).send()
      return successfulDownload(fileSize, request)
    }
    const path = join(this.basePath, request.hashPath)
    const url = this.client.getFileDownloadLink(path)
    const resp = await got.get(url, {
      followRedirect: false,
      responseType: 'buffer',
      headers: {
        range: request.range,
      },
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      https: {
        rejectUnauthorized: false,
      },
      timeout: {
        request: 30e3,
      },
      signal: request.signal,
    })
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      copyDownloadHeaders(resp.headers, res)
      res.status(resp.statusCode).send(resp.body)
      return successfulDownload(fileSize, request)
    }
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      res.status(resp.statusCode).location(resp.headers.location).send()
      await this.redirectUrlCache.set(request.hashPath, resp.headers.location)
      return successfulDownload(fileSize, request)
    }
    res.status(resp.statusCode).send(resp.body)
    return {bytes: 0, hits: 0}
  }

  private async proxyDownload(
    url: string,
    request: StorageDownloadRequest,
    res: Response,
    fileSize: number,
  ): Promise<StorageDownloadResult> {
    const upstream = got.stream(url, {
      followRedirect: true,
      headers: {
        range: request.range,
      },
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      https: {
        rejectUnauthorized: false,
      },
      timeout: {
        request: 30e3,
      },
      signal: request.signal,
    })
    const upstreamResponse = await new Promise<GotResponse>((resolve, reject) => {
      upstream.once('response', resolve)
      upstream.once('error', reject)
    })
    res.status(upstreamResponse.statusCode)
    copyDownloadHeaders(upstreamResponse.headers, res)
    applyAttachmentHeader(res, request)
    await pipeline(upstream, res, {signal: request.signal})
    return successfulDownload(fileSize, request)
  }
}
