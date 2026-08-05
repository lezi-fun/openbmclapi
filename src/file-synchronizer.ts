import {MultiBar, type SingleBar} from 'cli-progress'
import {HTTPError, RequestError} from 'got'
import {toString} from 'lodash-es'
import ms from 'ms'
import pMap from 'p-map'
import pRetry from 'p-retry'
import type {OpenbmclapiAgentConfiguration} from './config.js'
import type {ControllerClient} from './controller-client.js'
import {validateFile} from './file.js'
import {logger} from './logger.js'
import {abortReason, isAbortReason, type RuntimeLifecycle} from './runtime-lifecycle.js'
import type {IStorage} from './storage/base.storage.js'
import type {IFileInfo, IFileList} from './types.js'
import {hashToFilename} from './util.js'

export interface FileSyncProgressBar {
  stop(): void
  update(value: number): void
}

export interface FileSyncProgress {
  completeFile(bar: FileSyncProgressBar): void
  createFile(file: IFileInfo): FileSyncProgressBar
  stop(): void
}

export interface FileSynchronizerOptions {
  progressFactory?: (files: IFileInfo[]) => FileSyncProgress
  retry?: typeof pRetry
}

export class FileSynchronizer {
  private readonly progressFactory: (files: IFileInfo[]) => FileSyncProgress
  private readonly retry: typeof pRetry

  public constructor(
    private readonly controller: Pick<ControllerClient, 'downloadFile' | 'reportDownloadError'>,
    private readonly storage: IStorage,
    private readonly runtime: Pick<RuntimeLifecycle, 'signal'>,
    options: FileSynchronizerOptions = {},
  ) {
    this.progressFactory = options.progressFactory ?? ((files) => new CliFileSyncProgress(files))
    this.retry = options.retry ?? pRetry
  }

  public async sync(fileList: IFileList, syncConfig: OpenbmclapiAgentConfiguration['sync']): Promise<void> {
    this.runtime.signal.throwIfAborted()
    const storageReady = await this.storage.check()
    if (!storageReady) {
      throw new Error('存储异常')
    }
    logger.info('正在检查缺失文件')
    const missingFiles = await this.storage.getMissingFiles(fileList.files, this.runtime.signal)
    if (missingFiles.length === 0) return

    logger.info(`mismatch ${missingFiles.length} files, start syncing`)
    logger.info(syncConfig, '同步策略')
    const progress = this.progressFactory(missingFiles)
    let hasError = false
    try {
      await pMap(
        missingFiles,
        async (file) => {
          const bar = progress.createFile(file)
          try {
            await this.syncFile(file, bar)
          } catch (error) {
            if (this.runtime.signal.aborted) {
              throw abortReason(this.runtime.signal)
            }
            hasError = true
            this.logFinalFailure(file, error)
          } finally {
            progress.completeFile(bar)
          }
        },
        {
          concurrency: syncConfig.concurrency,
          signal: this.runtime.signal,
        },
      )
    } finally {
      progress.stop()
    }

    if (hasError) {
      throw new Error('同步失败')
    }
    logger.info('同步完成')
  }

  private async syncFile(file: IFileInfo, bar: FileSyncProgressBar): Promise<void> {
    await this.retry(
      async () => {
        bar.update(0)
        const response = await this.controller.downloadFile(file.path, (transferred) => {
          bar.update(transferred)
        })
        const body = Buffer.from(response.body)
        this.runtime.signal.throwIfAborted()
        if (!validateFile(body, file.hash)) {
          const message = `文件${file.path}校验失败`
          throw new RequestError(message, new Error(message), response.request)
        }
        await this.storage.writeFile(hashToFilename(file.hash), body, file)
      },
      {
        retries: 10,
        signal: this.runtime.signal,
        unref: true,
        onFailedAttempt: async ({error}) => await this.handleFailedAttempt(file, error),
      },
    )
  }

  private async handleFailedAttempt(file: IFileInfo, error: Error): Promise<void> {
    this.runtime.signal.throwIfAborted()
    if (error instanceof HTTPError) {
      logger.debug(
        {redirectUrls: error.response.redirectUrls},
        `下载文件${file.path}失败: ${error.response.statusCode}`,
      )
      logger.trace({err: error}, toString(error.response.body))
    } else {
      logger.debug({err: error}, `下载文件${file.path}失败，正在重试`)
    }

    if (!(error instanceof RequestError)) return
    const redirectUrls = error.response?.redirectUrls
    if (!redirectUrls?.length) return
    await this.controller.reportDownloadError(file.path, redirectUrls, error.message).catch((reportError: unknown) => {
      if (!isAbortReason(reportError, this.runtime.signal)) {
        logger.error(reportError, '上报重定向失败')
      }
    })
  }

  private logFinalFailure(file: IFileInfo, error: unknown): void {
    if (error instanceof HTTPError) {
      logger.error(
        {redirectUrls: error.response.redirectUrls},
        `下载文件${file.path}失败: ${error.response.statusCode}, url: ${error.response.url}`,
      )
      logger.trace({err: error}, toString(error.response.body))
      return
    }
    logger.error({err: error}, `下载文件${file.path}失败`)
  }
}

class CliFileSyncProgress implements FileSyncProgress {
  private readonly multibar = new MultiBar({
    format: ' {bar} | {filename} | {value}/{total}',
    noTTYOutput: true,
    notTTYSchedule: ms('10s'),
  })
  private readonly totalBar: SingleBar

  public constructor(files: IFileInfo[]) {
    this.totalBar = this.multibar.create(files.length, 0, {filename: '总文件数'})
  }

  public createFile(file: IFileInfo): FileSyncProgressBar {
    return this.multibar.create(file.size, 0, {filename: file.path})
  }

  public completeFile(bar: FileSyncProgressBar): void {
    this.totalBar.increment()
    bar.stop()
    this.multibar.remove(bar as SingleBar)
  }

  public stop(): void {
    this.multibar.stop()
  }
}
