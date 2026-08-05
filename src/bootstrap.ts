import nodeCluster from 'node:cluster'
import {join} from 'node:path'
import {HTTPError} from 'got'
import ms from 'ms'
import {Cluster} from './cluster.js'
import {greenText, rainbowText} from './console-style.js'
import {config} from './config.js'
import {refreshFileList} from './file-list.js'
import {logger} from './logger.js'
import {isAbortReason, RuntimeLifecycle} from './runtime-lifecycle.js'
import {TokenManager} from './token.js'
import {IFileList} from './types.js'

export async function bootstrap(version: string): Promise<void> {
  const runtime = new RuntimeLifecycle()
  let tokenManager: TokenManager | undefined
  let cluster: Cluster | undefined
  let server: ReturnType<Cluster['setupExpress']> | undefined
  let checkFileInterval: NodeJS.Timeout | undefined
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
    server = cluster.setupExpress(proto === 'https' && !config.enableNginx)
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
      scheduleFileCheck(files)
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

  function scheduleFileCheck(lastFileList: IFileList): void {
    if (runtime.signal.aborted) return
    checkFileInterval = setTimeout(() => {
      if (runtime.signal.aborted) return
      const task = runtime.track(checkFile(lastFileList))
      void task.catch((error) => {
        if (!isAbortReason(error, runtime.signal)) {
          logger.error(error, 'check file error')
        }
      })
    }, ms('10m'))
    checkFileInterval.unref()
  }

  async function checkFile(lastFileList: IFileList): Promise<void> {
    runtime.signal.throwIfAborted()
    logger.debug('refresh files')
    try {
      if (!cluster) return
      const nextFileList = await refreshFileList(cluster, lastFileList)
      if (nextFileList === lastFileList) {
        logger.debug('没有新文件')
        return
      }
      lastFileList = nextFileList
    } finally {
      scheduleFileCheck(lastFileList)
    }
  }

  async function shutdown(signal: string): Promise<void> {
    logger.info(`got ${signal}, unregistering cluster`)
    cluster?.nginxProcess?.kill()
    const serverClose = server ? closeServer(server) : Promise.resolve()
    runtime.abort(new Error(`received ${signal}`))
    tokenManager?.stop()
    if (checkFileInterval) {
      clearTimeout(checkFileInterval)
    }
    if (cluster?.interval) {
      clearInterval(cluster.interval)
    }

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

async function closeServer(server: ReturnType<Cluster['setupExpress']>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}
