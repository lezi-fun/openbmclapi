import {decompress} from '@mongodb-js/zstd'
import {constants} from 'node:http2'
import {Agent as HttpsAgent} from 'node:https'
import got, {type Got, type Response as GotResponse} from 'got'
import stringifySafe from 'json-stringify-safe'
import ms from 'ms'
import type {OpenbmclapiAgentConfiguration} from './config.js'
import {OpenbmclapiAgentConfigurationSchema} from './config.js'
import {FileListSchema} from './constants.js'
import {beforeError} from './modules/got-hooks.js'
import type {TokenManager} from './token.js'
import type {IFileList} from './types.js'

export interface ControllerClientOptions {
  client?: Got
  prefixUrl?: string
}

export class ControllerClient {
  public readonly prefixUrl: string

  private readonly client: Got
  private readonly requestCache = new Map()

  public constructor(
    version: string,
    tokenManager: Pick<TokenManager, 'getToken'>,
    signal: AbortSignal,
    options: ControllerClientOptions = {},
  ) {
    this.prefixUrl = options.prefixUrl ?? process.env.CLUSTER_BMCLAPI ?? 'https://openbmclapi.bangbang93.com'
    const controllerHost = new URL(this.prefixUrl).hostname
    this.client =
      options.client ??
      got.extend({
        prefixUrl: this.prefixUrl,
        headers: {
          'user-agent': `openbmclapi-cluster/${version}`,
        },
        responseType: 'buffer',
        signal,
        timeout: {
          connect: ms('10s'),
          response: ms('10s'),
          request: ms('5m'),
        },
        agent: {
          https: new HttpsAgent({
            keepAlive: true,
          }),
        },
        hooks: {
          beforeRequest: [
            async (requestOptions) => {
              const url = requestOptions.url
              if (url && shouldAuthorizeControllerUrl(url, controllerHost)) {
                requestOptions.headers.authorization = `Bearer ${await tokenManager.getToken()}`
              }
            },
          ],
          beforeError,
        },
      })
  }

  public async getFileList(lastModified?: number): Promise<IFileList> {
    const response = await this.client.get('openbmclapi/files', {
      responseType: 'buffer',
      cache: this.requestCache,
      searchParams: {
        lastModified,
      },
    })
    if (response.statusCode === constants.HTTP_STATUS_NO_CONTENT) {
      return {files: []}
    }
    const decompressed = await decompress(Buffer.from(response.body))
    return {
      files: FileListSchema.fromBuffer(Buffer.from(decompressed)) as IFileList['files'],
    }
  }

  public async getConfiguration(): Promise<OpenbmclapiAgentConfiguration> {
    const response = await this.client.get('openbmclapi/configuration', {
      responseType: 'json',
      cache: this.requestCache,
    })
    return OpenbmclapiAgentConfigurationSchema.parse(response.body)
  }

  public async downloadFile(path: string, onProgress?: (transferred: number) => void): Promise<GotResponse<Buffer>> {
    const request = this.client
      .get<Buffer>(path.replace(/^\//, ''), {
        retry: {
          limit: 0,
        },
      })
      .on('downloadProgress', (progress) => {
        onProgress?.(progress.transferred)
      })
    return await request
  }

  public async downloadOnDemand(hash: string): Promise<Buffer> {
    const response = await this.client.get(`openbmclapi/download/${hash}`, {
      responseType: 'buffer',
      searchParams: {noopen: 1},
    })
    return Buffer.from(response.body)
  }

  public async reportDownloadError(path: string, redirectUrls: URL[], message: string): Promise<void> {
    await this.client.post('openbmclapi/report', {
      json: {
        urls: [new URL(path, this.prefixUrl).toString(), ...redirectUrls.map((url) => url.toString())],
        error: stringifySafe({message}),
      },
    })
  }
}

export function shouldAuthorizeControllerUrl(url: URL, controllerHost: string): boolean {
  const hostname = url.hostname.toLowerCase()
  const normalizedControllerHost = controllerHost.toLowerCase()
  if (hostname === normalizedControllerHost) return true
  return hostname === 'localhost' || hostname === 'bangbang93.com' || hostname.endsWith('.bangbang93.com')
}
