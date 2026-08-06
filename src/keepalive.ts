import {clearTimeout} from 'node:timers'
import ms from 'ms'
import pTimeout from 'p-timeout'
import prettyBytes from 'pretty-bytes'
import type {KeepAlivePayload} from './controller-socket.js'
import {logger} from './logger.js'
import type {TrafficMeter, TrafficSnapshot} from './traffic-meter.js'

interface KeepAliveTransport {
  keepAlive(payload: KeepAlivePayload): Promise<boolean>
}

interface KeepAliveNode {
  isEnabled: boolean
  disable(): Promise<void>
  connect(): void
  enable(): Promise<void>
  exit(code?: number): void
}

export class Keepalive {
  public timer?: NodeJS.Timeout
  private active = false
  private generation = 0
  private transport?: KeepAliveTransport
  private keepAliveError = 0

  constructor(
    private readonly interval: number,
    private readonly cluster: KeepAliveNode,
    private readonly traffic: TrafficMeter,
  ) {}

  public start(transport: KeepAliveTransport): void {
    this.active = true
    this.generation++
    this.keepAliveError = 0
    this.transport = transport
    this.schedule(this.generation)
  }

  public stop(): void {
    this.active = false
    this.generation++
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(generation: number): void {
    if (!this.isCurrent(generation)) return
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.isCurrent(generation)) return
      logger.trace('start keep alive')
      void this.emitKeepAlive(generation)
    }, this.interval)
  }

  private async emitKeepAlive(generation: number = this.generation): Promise<void> {
    try {
      const {status, counters} = await pTimeout(this.keepAlive(), {
        milliseconds: ms('10s'),
      })
      if (!this.isCurrent(generation)) return
      const bytes = prettyBytes(counters.bytes, {binary: true})
      logger.info(`keep alive success, serve ${counters.hits} files, ${bytes}`)
      if (!status) {
        logger.fatal('kicked by server')
        return await this.restart(generation)
      }
      this.traffic.acknowledge(counters)
      this.keepAliveError = 0
    } catch (e) {
      if (!this.isCurrent(generation)) return
      this.keepAliveError++
      logger.error(e, 'keep alive error')
      if (this.keepAliveError >= 3) {
        await this.restart(generation)
      }
    } finally {
      this.schedule(generation)
    }
  }

  private async keepAlive(): Promise<{status: boolean; counters: TrafficSnapshot}> {
    if (!this.cluster.isEnabled) {
      throw new Error('节点未启用')
    }
    if (!this.transport) {
      throw new Error('未连接到服务器')
    }

    const counters = this.traffic.snapshot()
    const status = await this.transport.keepAlive({
      time: new Date(),
      ...counters,
    })
    return {status, counters}
  }

  private async restart(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return
    try {
      await pTimeout(
        (async () => {
          await this.cluster.disable()
          this.cluster.connect()
          await this.cluster.enable()
        })(),
        {milliseconds: ms('10m'), message: 'restart timeout'},
      )
    } catch (e) {
      logger.error(e, 'restart failed')
      this.cluster.exit(1)
    }
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation
  }
}
