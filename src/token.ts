import got, {type Got} from 'got'
import ms from 'ms'
import {createHmac} from 'node:crypto'
import {clearTimeout, setTimeout} from 'node:timers'
import {logger} from './logger.js'
import {beforeError} from './modules/got-hooks.js'

type RefreshTimer = ReturnType<typeof setTimeout>

export interface TokenManagerOptions {
  client?: Got
  schedule?: (callback: () => void, delay: number) => RefreshTimer
  cancel?: (timer: RefreshTimer) => void
  refreshRetryDelay?: number
}

export class TokenManager {
  private token: string | undefined
  private readonly got: Got
  private readonly schedule: (callback: () => void, delay: number) => RefreshTimer
  private readonly cancel: (timer: RefreshTimer) => void
  private readonly refreshRetryDelay: number
  private tokenRequest?: Promise<string>
  private refreshRequest?: Promise<void>
  private refreshTimer?: RefreshTimer
  private stopped = false

  private readonly prefixUrl = process.env.CLUSTER_BMCLAPI ?? 'https://openbmclapi.bangbang93.com'

  constructor(
    private readonly clusterId: string,
    private readonly clusterSecret: string,
    version: string,
    options: TokenManagerOptions = {},
  ) {
    this.got =
      options.client ??
      got.extend({
        prefixUrl: this.prefixUrl,
        headers: {
          'user-agent': `openbmclapi-cluster/${version}`,
        },
        timeout: {
          request: ms('5m'),
        },
        hooks: {
          beforeError,
        },
      })
    this.schedule = options.schedule ?? setTimeout
    this.cancel = options.cancel ?? clearTimeout
    this.refreshRetryDelay = options.refreshRetryDelay ?? ms('1m')
  }

  public async getToken(): Promise<string> {
    if (this.token) {
      return this.token
    }

    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchToken().finally(() => {
        this.tokenRequest = undefined
      })
    }
    return await this.tokenRequest
  }

  public stop(): void {
    this.stopped = true
    this.clearRefreshTimer()
  }

  private async fetchToken(): Promise<string> {
    const challenge = await this.got
      .get('openbmclapi-agent/challenge', {
        searchParams: {
          clusterId: this.clusterId,
        },
      })
      .json<{challenge: string}>()
    const signature = createHmac('sha256', this.clusterSecret).update(challenge.challenge).digest('hex')
    const token = await this.got
      .post('openbmclapi-agent/token', {
        json: {
          clusterId: this.clusterId,
          challenge: challenge.challenge,
          signature,
        },
      })
      .json<{token: string; ttl: number}>()
    this.token = token.token
    this.scheduleRefreshToken(token.ttl)
    return token.token
  }

  private scheduleRefreshToken(ttl: number): void {
    const next = Math.max(ttl - ms('10m'), ttl / 2)
    this.scheduleRefresh(next)
    logger.trace(`schedule refresh token in ${next}ms`)
  }

  private async refreshToken(): Promise<void> {
    if (!this.refreshRequest) {
      this.refreshRequest = this.performRefresh().finally(() => {
        this.refreshRequest = undefined
      })
    }
    await this.refreshRequest
  }

  private async performRefresh(): Promise<void> {
    const token = await this.got
      .post('openbmclapi-agent/token', {
        json: {
          clusterId: this.clusterId,
          token: this.token,
        },
      })
      .json<{token: string; ttl: number}>()
    this.token = token.token
    logger.debug('success refresh token')
    this.scheduleRefreshToken(token.ttl)
  }

  private scheduleRefresh(delay: number): void {
    if (this.stopped) return

    this.clearRefreshTimer()
    let timer: RefreshTimer
    timer = this.schedule(() => {
      if (this.refreshTimer !== timer) return
      this.refreshTimer = undefined
      if (this.stopped) return
      void this.runScheduledRefresh()
    }, delay)
    this.refreshTimer = timer
    timer.unref?.()
  }

  private clearRefreshTimer(): void {
    if (!this.refreshTimer) return
    const timer = this.refreshTimer
    this.refreshTimer = undefined
    this.cancel(timer)
  }

  private async runScheduledRefresh(): Promise<void> {
    try {
      await this.refreshToken()
    } catch (err) {
      logger.error(err, 'refresh token error')
      this.scheduleRefresh(this.refreshRetryDelay)
    }
  }
}
