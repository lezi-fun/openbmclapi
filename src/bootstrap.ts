import nodeCluster from 'node:cluster'
import {join} from 'node:path'
import {HTTPError} from 'got'
import {Cluster} from './cluster.js'
import {greenText, rainbowText} from './console-style.js'
import {config} from './config.js'
import {FileListScheduler} from './file-list-scheduler.js'
import {logger} from './logger.js'
import {RuntimeLifecycle} from './runtime-lifecycle.js'
import {TokenManager} from './token.js'

export async function bootstrap(version: string): Promise<void> {
  const runtime = new RuntimeLifecycle()
  let tokenManager: TokenManager | undefined
  let cluster: Cluster | undefined
  let fileListScheduler: FileListScheduler | undefined
  let stopping = false
  let shutdownPromise: Promise<void> | undefined

  const onStop = (signal: string): Promise<void> => {
    if (stopping) {
      // eslint-disable-next-line n/no-process-exit
      process.exit(1)
    }
    stopping = true
    shutdownPromise = shutdown(signal)
    return shutdownPromise
  }

  const onSignal = (signal: string): void => {
    void onStop(signal)
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  if (nodeCluster.isWorker) {
    process.on('disconnect', () => {
      void onStop('disconnect')
    })
  }

  try {
    logger.info(greenText(`booting openbmclapi ${version}`))
    tokenManager = new TokenManager(config.clusterId, config.clusterSecret, version, {signal: runtime.signal})
    await tokenManager.getToken()
    cluster = new Cluster(config.clusterSecret, version, tokenManager, runtime)
    fileListScheduler = new FileListScheduler(cluster, runtime)
    await cluster.init()
    cluster.connect()

    let proto: 'http' | 'https' = 'https'
    if (config.byoc) {
      // 当BYOC但是没有提供证书时，使用http
      if (!config.sslCert || !config.sslKey) {
        proto = 'http'
      } else {
        logger.info('使用自定义证书')
        await cluster.useSelfCert()
      }
    } else {
      logger.info('请求证书')
      await cluster.requestCert()
    }

    if (config.enableNginx) {
      if (typeof cluster.port === 'number') {
        await cluster.setupNginx(join(import.meta.dirname, '..'), cluster.port, proto)
      } else {
        throw new Error('cluster.port is not a number')
      }
    }
    cluster.setupExpress(proto === 'https' && !config.enableNginx)
    await cluster.listen()
    await cluster.portCheck()

    const storageReady = await cluster.storage.check()
    if (!storageReady) {
      throw new Error('存储异常')
    }

    const configuration = await cluster.getConfiguration()
    const files = await cluster.getFileList()
    logger.info(`${files.files.length} files`)
    try {
      await runtime.track(cluster.syncFiles(files, configuration.sync))
    } catch (e) {
      if (e instanceof HTTPError) {
        logger.error({url: e.response.url}, 'download error')
      }
      throw e
    }
    logger.info('回收文件')
    cluster.gcBackground(files)

    try {
      logger.info('请求上线')
      await cluster.enable()

      logger.info(rainbowText(`done, serving ${files.files.length} files`))
      if (nodeCluster.isWorker && typeof process.send === 'function') {
        process.send('ready')
      }
      fileListScheduler.start(files)
    } catch (e) {
      if (runtime.signal.aborted) {
        throw e
      }
      logger.fatal(e)
      if (process.env.NODE_ENV === 'development') {
        logger.fatal('development mode, not exiting')
      } else {
        cluster.exit(1)
      }
    }
  } catch (error) {
    if (runtime.signal.aborted) {
      await shutdownPromise
      return
    }
    throw error
  }

  async function shutdown(signal: string): Promise<void> {
    logger.info(`got ${signal}, unregistering cluster`)
    cluster?.stopNginx()
    const serverClose = cluster?.closeServer() ?? Promise.resolve()
    runtime.abort(new Error(`received ${signal}`))
    tokenManager?.stop()
    fileListScheduler?.stop()
    const disableResult = cluster ? await Promise.allSettled([cluster.disable()]) : []
    const disableError = disableResult[0]
    if (disableError?.status === 'rejected') {
      logger.error(disableError.reason, 'unregister cluster failed')
    }
    cluster?.disconnect()

    await runtime.waitForBackgroundTasks()
    await serverClose
    logger.info('unregister success, background tasks stopped')
  }
}
