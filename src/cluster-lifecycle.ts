export type ClusterLifecycleState = 'disabled' | 'enabling' | 'enabled' | 'disabling'

export class ClusterLifecycle {
  private currentState: ClusterLifecycleState = 'disabled'
  private desiredEnabled = false
  private generation = 0
  private transitionQueue = Promise.resolve()

  public constructor(
    private readonly enableNode: () => Promise<void>,
    private readonly disableNode: () => Promise<void>,
  ) {}

  public get state(): ClusterLifecycleState {
    return this.currentState
  }

  public get isEnabled(): boolean {
    return this.currentState === 'enabled'
  }

  public get wantEnable(): boolean {
    return this.desiredEnabled
  }

  public enable(): Promise<void> {
    this.desiredEnabled = true
    return this.enqueue(async () => {
      if (!this.desiredEnabled || this.currentState === 'enabled') return

      const generation = this.generation
      this.currentState = 'enabling'
      try {
        await this.enableNode()
        if (generation === this.generation) {
          this.currentState = 'enabled'
        }
      } catch (error) {
        if (generation === this.generation) {
          this.currentState = 'disabled'
        }
        throw error
      }
    })
  }

  public disable(): Promise<void> {
    this.desiredEnabled = false
    return this.enqueue(async () => {
      if (this.desiredEnabled || this.currentState === 'disabled') return

      const generation = this.generation
      this.currentState = 'disabling'
      try {
        await this.disableNode()
        if (generation === this.generation) {
          this.currentState = 'disabled'
        }
      } catch (error) {
        if (generation === this.generation) {
          this.currentState = 'enabled'
        }
        throw error
      }
    })
  }

  public markDisconnected(): void {
    this.generation++
    this.currentState = 'disabled'
  }

  private enqueue(transition: () => Promise<void>): Promise<void> {
    const operation = this.transitionQueue.then(transition)
    this.transitionQueue = operation.catch(() => undefined)
    return operation
  }
}
