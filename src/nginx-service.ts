import {spawn, type ChildProcess} from 'node:child_process'
import {cp, mkdtemp, open, readFile, rm, type FileHandle} from 'node:fs/promises'
import {tmpdir, userInfo} from 'node:os'
import {dirname, join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {template} from 'lodash-es'
import ms from 'ms'
import {Tail} from 'tail'
import {logger} from './logger.js'
import {writeFileWithParents} from './fs.js'

const sourceRoot = join(import.meta.dirname, '..')
const accessLogPattern =
  /^(?<client>\S+) \S+ (?<userid>\S+) \[(?<datetime>[^\]]+)] "(?<method>[A-Z]+) (?<request>[^ "]+)? HTTP\/[0-9.]+" (?<status>[0-9]{3}) (?<size>[0-9]+|-) "(?<referrer>[^"]*)" "(?<useragent>[^"]*)"/

export interface NginxCounters {
  hits: number
  bytes: number
}

export interface NginxTemplateValues {
  root: string
  port: number
  ssl: boolean
  sock: string
  user: string
  tmpdir: string
}

export interface NginxServiceOptions {
  counters: NginxCounters
  disableAccessLog: boolean
  tmpDir: string
  socketPath?: string
  templateDirectory?: string
  spawnProcess?: typeof spawn
  tailFactory?: (path: string) => Tail
  wait?: (milliseconds: number) => Promise<unknown>
}

export interface ParsedNginxAccessLog {
  bytes: number
}

export function parseNginxAccessLog(line: string): ParsedNginxAccessLog | undefined {
  const match = line.match(accessLogPattern)
  if (!match) return undefined
  return {bytes: Number.parseInt(match.groups?.size ?? '0', 10) || 0}
}

export function renderNginxConfig(source: string, values: NginxTemplateValues): string {
  return template(source)(values)
}

export class NginxService {
  private readonly counters: NginxCounters
  private readonly disableAccessLog: boolean
  private readonly tmpDir: string
  private readonly socketPath: string
  private readonly templateDirectory: string
  private readonly spawnProcess: typeof spawn
  private readonly tailFactory: (path: string) => Tail
  private readonly wait: (milliseconds: number) => Promise<unknown>
  private nginxProcess?: ChildProcess
  private logFd?: FileHandle
  private tail?: Tail
  private truncateInterval?: NodeJS.Timeout

  public constructor(options: NginxServiceOptions) {
    this.counters = options.counters
    this.disableAccessLog = options.disableAccessLog
    this.tmpDir = options.tmpDir
    this.socketPath = options.socketPath ?? '/tmp/openbmclapi.sock'
    this.templateDirectory = options.templateDirectory ?? join(sourceRoot, 'nginx')
    this.spawnProcess = options.spawnProcess ?? spawn
    this.tailFactory = options.tailFactory ?? ((path) => new Tail(path))
    this.wait = options.wait ?? (async (milliseconds) => await delay(milliseconds))
  }

  public get port(): string {
    return this.socketPath
  }

  public async start(appRoot: string, appPort: number, proto: string): Promise<string> {
    this.stop()
    await rm(this.socketPath, {force: true})

    const directory = await mkdtemp(join(tmpdir(), 'openbmclapi'))
    const confFile = `${directory}/nginx/nginx.conf`
    const confTemplate = await readFile(join(this.templateDirectory, 'nginx.conf'), 'utf8')
    logger.debug({confFile}, 'nginx conf')

    await cp(this.templateDirectory, dirname(confFile), {recursive: true, force: true})
    await writeFileWithParents(
      confFile,
      renderNginxConfig(confTemplate, {
        root: appRoot,
        port: appPort,
        ssl: proto === 'https',
        sock: this.socketPath,
        user: userInfo().username,
        tmpdir: this.tmpDir,
      }),
    )

    const logFile = join(appRoot, 'access.log')
    const logFd = await open(logFile, 'a')
    await logFd.truncate()
    this.logFd = logFd

    this.nginxProcess = this.spawnProcess('nginx', ['-c', confFile], {
      stdio: [null, logFd.fd, 'inherit'],
    })

    await this.wait(ms('1s'))
    if (this.nginxProcess.exitCode !== null) {
      const exitCode = this.nginxProcess.exitCode
      this.stop()
      throw new Error(`nginx exit with code ${exitCode}`)
    }

    const tail = this.tailFactory(logFile)
    this.tail = tail
    if (!this.disableAccessLog) {
      tail.on('line', (line: string) => {
        process.stdout.write(line)
        process.stdout.write('\n')
      })
    }
    tail.on('line', (line: string) => {
      const parsed = parseNginxAccessLog(line)
      if (!parsed) {
        logger.debug(`cannot parse nginx log: ${line}`)
        return
      }
      this.counters.hits++
      this.counters.bytes += parsed.bytes
    })
    tail.on('error', (error: unknown) => logger.warn({err: error}, 'nginx access log tail error'))

    this.truncateInterval = setInterval(() => {
      void this.logFd
        ?.truncate()
        .catch((error: unknown) => logger.warn({err: error}, 'nginx access log truncate error'))
    }, ms('60s'))

    return this.socketPath
  }

  public stop(): void {
    if (this.truncateInterval) {
      clearInterval(this.truncateInterval)
      this.truncateInterval = undefined
    }
    this.tail?.unwatch()
    this.tail = undefined
    const nginxProcess = this.nginxProcess
    this.nginxProcess = undefined
    nginxProcess?.kill()

    const logFd = this.logFd
    this.logFd = undefined
    if (logFd) {
      void logFd.close().catch((error: unknown) => logger.warn({err: error}, 'close nginx access log failed'))
    }
  }
}
