import ms from 'ms'
import {refreshFileList, type FileListClient} from './file-list.js'
import {logger} from './logger.js'
import type {RuntimeLifecycle} from './runtime-lifecycle.js'
import {isAbortReason} from './runtime-lifecycle.js'
import type {IFileList} from './types.js'

interface SchedulerTimer {
  unref?: () => void
}

export interface FileListSchedulerOptions {
  intervalMs?: number
  timerFactory?: (callback: () => void, milliseconds: number) => SchedulerTimer
  clearTimer?: (timer: SchedulerTimer) => void
}

const defaultTimerFactory = (callback: () => void, milliseconds: number): SchedulerTimer => {
  return setTimeout(callback, milliseconds)
}

const defaultClearTimer = (timer: SchedulerTimer): void => {
  clearTimeout(timer as ReturnType<typeof setTimeout>)
}

export class FileListScheduler {
  private readonly intervalMs: number
  private readonly timerFactory: (callback: () => void, milliseconds: number) => SchedulerTimer
  private readonly clearTimer: (timer: SchedulerTimer) => void
  private current?: IFileList
  private timer?: SchedulerTimer
  private stopped = true

  public constructor(
    private readonly client: FileListClient,
    private readonly runtime: Pick<RuntimeLifecycle, 'signal' | 'track'>,
    options: FileListSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? ms('10m')
    this.timerFactory = options.timerFactory ?? defaultTimerFactory
    this.clearTimer = options.clearTimer ?? defaultClearTimer
  }

  public start(initial: IFileList): void {
    this.stop()
    this.current = initial
    this.stopped = false
    this.schedule()
  }

  public stop(): void {
    this.stopped = true
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  private schedule(): void {
    if (this.stopped || this.runtime.signal.aborted) return
    this.timer = this.timerFactory(() => {
      this.timer = undefined
      if (this.stopped || this.runtime.signal.aborted) return
      const task = this.runtime.track(this.refresh())
      void task.catch((error: unknown) => {
        if (!isAbortReason(error, this.runtime.signal)) {
          logger.error(error, 'check file error')
        }
      })
    }, this.intervalMs)
    this.timer.unref?.()
  }

  private async refresh(): Promise<void> {
    this.runtime.signal.throwIfAborted()
    logger.debug('refresh files')
    try {
      if (!this.current) return
      const nextFileList = await refreshFileList(this.client, this.current)
      if (nextFileList === this.current) {
        logger.debug('没有新文件')
        return
      }
      this.current = nextFileList
    } finally {
      this.schedule()
    }
  }
}
