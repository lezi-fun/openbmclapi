import {cp, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import ipaddr from 'ipaddr.js'
import ms from 'ms'
import prettyBytes from 'pretty-bytes'
import {config, type OpenbmclapiAgentConfiguration} from './config.js'
import {ClusterLifecycle, type ClusterLifecycleState} from './cluster-lifecycle.js'
import {rainbowText} from './console-style.js'
import {ControllerClient} from './controller-client.js'
import {ControllerSocket, type NodeRegistrationPayload} from './controller-socket.js'
import {DataPlaneServer, type DataPlaneServerInstance} from './data-plane-server.js'
import {storeVerifiedDownload} from './download.js'
import {FileSynchronizer} from './file-synchronizer.js'
import {pathExists, writeFileWithParents} from './fs.js'
import {Keepalive} from './keepalive.js'
import {logger} from './logger.js'
import {NginxService} from './nginx-service.js'
import {isAbortReason, RuntimeLifecycle} from './runtime-lifecycle.js'
import {getStorage, type IStorage} from './storage/base.storage.js'
import type {TokenManager} from './token.js'
import type {IFileList} from './types.js'
import {TrafficMeter, type TrafficSnapshot} from './traffic-meter.js'
import {setupUpnp} from './upnp.js'

export class Cluster {
  public readonly traffic = new TrafficMeter()
  public readonly storage: IStorage

  private readonly prefixUrl: string
  private host?: string
  private _port: number | string
  private readonly publicPort: number
  private readonly controller: ControllerClient
  private readonly tmpDir = join(tmpdir(), 'openbmclapi')
  private readonly keepalive: Keepalive
  private readonly lifecycle: ClusterLifecycle
  private readonly controllerSocket: ControllerSocket
  private readonly dataPlane: DataPlaneServer
  private readonly synchronizer: FileSynchronizer
  private readonly nginx: NginxService

  public constructor(
    clusterSecret: string,
    private readonly version: string,
    tokenManager: TokenManager,
    private readonly runtime: RuntimeLifecycle = new RuntimeLifecycle(),
    controller?: ControllerClient,
  ) {
    this.host = config.clusterIp
    this._port = config.port
    this.publicPort = config.clusterPublicPort ?? config.port
    this.controller = controller ?? new ControllerClient(version, tokenManager, runtime.signal)
    this.prefixUrl = this.controller.prefixUrl
    this.lifecycle = new ClusterLifecycle(
      async () => await this.enableNode(),
      async () => await this.disableNode(),
    )
    this.keepalive = new Keepalive(ms('1m'), this, this.traffic)
    this.controllerSocket = new ControllerSocket(this.prefixUrl, tokenManager, runtime.signal, {
      handlers: {
        onAuthenticationError: (error) => {
          logger.error(error, 'get token error')
          this.exit(1)
        },
        onConnectionError: (event, error) => this.onConnectionError(event, error),
        onDisconnect: (reason) => {
          logger.warn(`与服务器断开连接: ${reason}`)
          this.lifecycle.markDisconnected()
          this.keepalive.stop()
        },
        onReconnect: (attempt) => {
          logger.info(`在重试${attempt}次后恢复连接`)
          if (this.wantEnable) {
            logger.info('正在尝试重新启用服务')
            this.enable()
              .then(() => logger.info('重试连接并且准备就绪'))
              .catch((error: Error) => this.onConnectionError('reconnect', error))
          }
        },
      },
    })
    this.storage = getStorage(config)
    this.synchronizer = new FileSynchronizer(this.controller, this.storage, runtime)
    this.nginx = new NginxService({
      disableAccessLog: config.disableAccessLog ?? false,
      tmpDir: this.tmpDir,
      traffic: this.traffic,
    })
    this.dataPlane = new DataPlaneServer({
      certDirectory: this.tmpDir,
      config: {
        clusterSecret,
        disableAccessLog: config.disableAccessLog,
      },
      downloadFile: async (hash) => await this.downloadFile(hash),
      runtime,
      storage: this.storage,
      traffic: this.traffic,
    })
  }

  public get port(): number | string {
    return this._port
  }

  public get counters(): TrafficSnapshot {
    return this.traffic.snapshot()
  }

  public get lifecycleState(): ClusterLifecycleState {
    return this.lifecycle.state
  }

  public get isEnabled(): boolean {
    return this.lifecycle.isEnabled
  }

  public get wantEnable(): boolean {
    return this.lifecycle.wantEnable
  }

  public async init(): Promise<void> {
    await this.storage.init?.()
    if (config.enableUpnp) {
      const ip = await setupUpnp(config.port, config.clusterPublicPort, this.runtime.signal)
      const addr = ipaddr.parse(ip)
      if (addr.kind() !== 'ipv4') {
        throw new Error('不支持ipv6')
      }
      if (addr.range() !== 'unicast') {
        throw new Error(`无法获取公网IP, UPNP返回的IP位于私有地址段, IP: ${ip}`)
      }
      logger.info(`upnp映射成功，外网IP: ${ip}`)
      this.host ??= ip
    }
  }

  public async getFileList(lastModified?: number): Promise<IFileList> {
    return await this.controller.getFileList(lastModified)
  }

  public async getConfiguration(): Promise<OpenbmclapiAgentConfiguration> {
    return await this.controller.getConfiguration()
  }

  public async syncFiles(fileList: IFileList, syncConfig: OpenbmclapiAgentConfiguration['sync']): Promise<void> {
    await this.synchronizer.sync(fileList, syncConfig)
  }

  public setupExpress(https: boolean): DataPlaneServerInstance {
    return this.dataPlane.setup(https)
  }

  public async setupNginx(pwd: string, appPort: number, proto: string): Promise<void> {
    this._port = await this.nginx.start(pwd, appPort, proto)
  }

  public async listen(): Promise<void> {
    await this.dataPlane.listen(this._port)
  }

  public async closeServer(): Promise<void> {
    await this.dataPlane.close()
  }

  public stopNginx(): void {
    this.nginx.stop()
  }

  public connect(): void {
    this.controllerSocket.connect()
  }

  public async portCheck(): Promise<void> {
    await this.controllerSocket.portCheck(this.nodeRegistrationPayload)
  }

  public async enable(): Promise<void> {
    logger.trace('enable')
    await this.lifecycle.enable()
  }

  public async disable(): Promise<void> {
    logger.trace('disable')
    await this.lifecycle.disable()
  }

  public disconnect(): void {
    this.keepalive.stop()
    this.controllerSocket.disconnect()
  }

  public async downloadFile(hash: string): Promise<void> {
    const body = await this.controller.downloadOnDemand(hash)
    this.runtime.signal.throwIfAborted()
    await storeVerifiedDownload(this.storage, hash, body)
  }

  public async requestCert(): Promise<void> {
    const cert = await this.controllerSocket.requestCert()
    await writeFileWithParents(join(this.tmpDir, 'cert.pem'), cert.cert)
    await writeFileWithParents(join(this.tmpDir, 'key.pem'), cert.key)
  }

  public async useSelfCert(): Promise<void> {
    if (!config.sslCert) {
      throw new Error('缺少ssl证书')
    }
    if (!config.sslKey) {
      throw new Error('缺少ssl私钥')
    }

    await mkdir(this.tmpDir, {recursive: true})
    if (await pathExists(config.sslCert)) {
      await cp(config.sslCert, join(this.tmpDir, 'cert.pem'), {force: true})
    } else {
      await writeFileWithParents(join(this.tmpDir, 'cert.pem'), config.sslCert)
    }
    if (await pathExists(config.sslKey)) {
      await cp(config.sslKey, join(this.tmpDir, 'key.pem'), {force: true})
    } else {
      await writeFileWithParents(join(this.tmpDir, 'key.pem'), config.sslKey)
    }
  }

  public exit(code: number = 0): void {
    this.stopNginx()
    // eslint-disable-next-line n/no-process-exit
    process.exit(code)
  }

  public gcBackground(files: IFileList): void {
    const task = this.storage
      .gc(files.files, this.runtime.signal)
      .then((res) => {
        if (res.count === 0) {
          logger.info('没有过期文件')
        } else {
          logger.info(`文件回收完成，共删除${res.count}个文件，释放空间${prettyBytes(res.size)}`)
        }
      })
      .catch((e: unknown) => {
        if (!isAbortReason(e, this.runtime.signal)) {
          logger.error({err: e}, 'gc error')
        }
      })
    void this.runtime.track(task)
  }

  private async enableNode(): Promise<void> {
    await this.controllerSocket.enable(this.nodeRegistrationPayload)
    logger.info(rainbowText('start doing my job'))
    this.keepalive.start(this.controllerSocket)
  }

  private async disableNode(): Promise<void> {
    this.keepalive.stop()
    if (!this.controllerSocket.connected) return

    try {
      await this.controllerSocket.disable()
    } catch (error) {
      if (this.controllerSocket.connected && !this.runtime.signal.aborted) {
        this.keepalive.start(this.controllerSocket)
      }
      throw error
    }
  }

  private get nodeRegistrationPayload(): NodeRegistrationPayload {
    return {
      host: this.host,
      port: this.publicPort,
      version: this.version,
      byoc: config.byoc,
      noFastEnable: process.env.NO_FAST_ENABLE === 'true',
      flavor: config.flavor,
    }
  }

  private onConnectionError(event: string, err: Error): void {
    logger.error({err}, `${event}: cannot connect to server`)
    void this.dataPlane.close().finally(() => this.exit(1))
  }
}
