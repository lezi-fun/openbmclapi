import ms from 'ms'
import {connect, type Socket} from 'socket.io-client'
import type {IConfigFlavor} from './config.js'
import {logger} from './logger.js'
import {abortable, abortReason} from './runtime-lifecycle.js'
import type {TokenManager} from './token.js'

export interface NodeRegistrationPayload {
  host?: string
  port: number | string
  version: string
  byoc: boolean | undefined
  noFastEnable: boolean
  flavor: IConfigFlavor
}

export interface KeepAlivePayload {
  time: Date
  hits: number
  bytes: number
}

export interface ControllerSocketHandlers {
  onAuthenticationError?: (error: unknown) => void
  onConnectionError?: (event: string, error: Error) => void
  onDisconnect?: (reason: string) => void
  onReconnect?: (attempt: number) => void
}

export interface ControllerSocketOptions {
  handlers?: ControllerSocketHandlers
  socketFactory?: typeof connect
}

export class ControllerSocket {
  private socket?: Socket
  private readonly handlers: ControllerSocketHandlers
  private readonly socketFactory: typeof connect

  public constructor(
    private readonly prefixUrl: string,
    private readonly tokenManager: Pick<TokenManager, 'getToken'>,
    private readonly signal: AbortSignal,
    options: ControllerSocketOptions = {},
  ) {
    this.handlers = options.handlers ?? {}
    this.socketFactory = options.socketFactory ?? connect
  }

  public get connected(): boolean {
    return this.socket?.connected ?? false
  }

  public connect(): void {
    if (this.socket) {
      if (!this.socket.connected) {
        this.socket.connect()
      }
      return
    }

    const socket = this.socketFactory(this.prefixUrl, {
      transports: ['websocket'],
      auth: (callback) => {
        this.tokenManager
          .getToken()
          .then((token) => callback({token}))
          .catch((error: unknown) => this.handlers.onAuthenticationError?.(error))
      },
    })
    this.socket = socket

    socket.on('error', (error: Error) => this.handlers.onConnectionError?.('error', error))
    socket.on('message', (message) => logger.info(message))
    socket.on('connect', () => logger.debug('connected'))
    socket.on('disconnect', (reason) => this.handlers.onDisconnect?.(reason))
    socket.on('exception', (error) => logger.error(error, 'exception'))
    socket.on('warden-error', (data) => logger.warn(data, '主控回报巡检异常'))

    socket.io.on('reconnect', (attempt: number) => this.handlers.onReconnect?.(attempt))
    socket.io.on('reconnect_error', (error) => logger.error(error, 'reconnect_error'))
    socket.io.on('reconnect_failed', () =>
      this.handlers.onConnectionError?.('reconnect_failed', new Error('reconnect failed')),
    )
  }

  public disconnect(): void {
    this.socket?.disconnect()
  }

  public async portCheck(payload: NodeRegistrationPayload): Promise<void> {
    const [error, acknowledged] = (await abortable(
      this.getSocket().emitWithAck('port-check', payload),
      this.signal,
    )) as [object, boolean]
    if (error && typeof error === 'object' && 'message' in error) {
      throw new Error(error.message as string)
    }
    if (!acknowledged) {
      throw new Error('检查端口失败')
    }
  }

  public async requestCert(): Promise<{cert: string; key: string}> {
    const [error, cert] = (await abortable(this.getSocket().emitWithAck('request-cert'), this.signal)) as [
      object,
      {cert: string; key: string},
    ]
    if (error) {
      if (typeof error === 'object' && 'message' in error) {
        throw new Error(error.message as string)
      }
      throw new Error('请求证书失败', {cause: error})
    }
    return cert
  }

  public async enable(payload: NodeRegistrationPayload): Promise<void> {
    const socket = this.getSocket()
    let error: unknown
    let acknowledged: unknown
    try {
      const response = (await abortable(
        socket.timeout(ms('5m')).emitWithAck('enable', payload),
        this.signal,
      )) as unknown
      if (Array.isArray(response)) {
        ;[error, acknowledged] = response as unknown[]
      }
    } catch (cause) {
      if (this.signal.aborted) {
        throw abortReason(this.signal)
      }
      throw new Error('节点注册超时', {cause})
    }

    if (error && typeof error === 'object' && 'message' in error) {
      throw new Error(error.message as string)
    }
    if (acknowledged !== true) {
      throw new Error('节点注册失败')
    }
  }

  public async disable(): Promise<void> {
    const socket = this.socket
    if (!socket?.connected) return

    const [error, acknowledged] = (await socket.emitWithAck('disable', null)) as [object, boolean]
    if (error && typeof error === 'object' && 'message' in error) {
      throw new Error(error.message as string)
    }
    if (acknowledged !== true) {
      throw new Error('节点禁用失败')
    }
    socket.disconnect()
  }

  public async keepAlive(payload: KeepAlivePayload): Promise<boolean> {
    const [error, date] = (await this.getSocket().emitWithAck('keep-alive', payload)) as [object, unknown]
    if (error) throw new Error('keep alive error', {cause: error})
    return !!date
  }

  private getSocket(): Socket {
    if (!this.socket) throw new Error('未连接到服务器')
    return this.socket
  }
}
