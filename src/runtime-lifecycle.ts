export class RuntimeLifecycle {
  private readonly controller = new AbortController()
  private readonly backgroundTasks = new Set<Promise<unknown>>()

  public get signal(): AbortSignal {
    return this.controller.signal
  }

  public abort(reason?: unknown): void {
    if (!this.signal.aborted) {
      this.controller.abort(reason)
    }
  }

  public track<T>(task: Promise<T>): Promise<T> {
    this.backgroundTasks.add(task)
    task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task),
    )
    return task
  }

  public async waitForBackgroundTasks(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks])
    }
  }
}

export async function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()

  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, {once: true})
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

export function isAbortReason(error: unknown, signal: AbortSignal): boolean {
  const reason: unknown = signal.reason
  return signal.aborted && (error === reason || (error instanceof DOMException && error.name === 'AbortError'))
}

export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('Operation aborted', {cause: reason})
}
