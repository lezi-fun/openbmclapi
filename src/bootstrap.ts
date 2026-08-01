import nodeCluster from 'node:cluster'
import {join} from 'node:path'
import colors from 'colors/safe.js'
import {HTTPError} from 'got'
import ms from 'ms'
import {Cluster} from './cluster.js'
import {config} from './config.js'
import {refreshFileList} from './file-list.js'
import {logger} from './logger.js'
import {TokenManager} from './token.js'
import {IFileList} from './types.js'

export async function bootstrap(version: string): Promise<void> {
  logger.info(colors.green(`booting openbmclapi ${version}`))
  const tokenManager = new TokenManager(config.clusterId, config.clusterSecret, version)
  await tokenManager.getToken()
  const cluster = new Cluster(config.clusterSecret, version, tokenManager)
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
  const server = cluster.setupExpress(proto === 'https' && !config.enableNginx)
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
    await cluster.syncFiles(files, configuration.sync)
  } catch (e) {
    if (e instanceof HTTPError) {
      logger.error({url: e.response.url}, 'download error')
    }
    throw e
  }
  logger.info('回收文件')
  cluster.gcBackground(files)

  let checkFileInterval: NodeJS.Timeout
  try {
    logger.info('请求上线')
    await cluster.enable()

    logger.info(colors.rainbow(`done, serving ${files.files.length} files`))
    if (nodeCluster.isWorker && typeof process.send === 'function') {
      process.send('ready')
    }

    checkFileInterval = setTimeout(() => {
      void checkFile(files).catch((e) => {
        logger.error(e, 'check file error')
      })
    }, ms('10m'))
  } catch (e) {
    logger.fatal(e)
    if (process.env.NODE_ENV === 'development') {
      logger.fatal('development mode, not exiting')
    } else {
      cluster.exit(1)
    }
  }

  async function checkFile(lastFileList: IFileList): Promise<void> {
    logger.debug('refresh files')
    try {
      const nextFileList = await refreshFileList(cluster, lastFileList)
      if (nextFileList === lastFileList) {
        logger.debug('没有新文件')
        return
      }
      lastFileList = nextFileList
    } finally {
      checkFileInterval = setTimeout(() => {
        checkFile(lastFileList).catch((e) => {
          logger.error(e, 'check file error')
        })
      }, ms('10m'))
    }
  }

  let stopping = false
  const onStop = async (signal: string): Promise<void> => {
    logger.info(`got ${signal}, unregistering cluster`)
    if (stopping) {
      // eslint-disable-next-line n/no-process-exit
      process.exit(1)
    }

    stopping = true
    clearTimeout(checkFileInterval)
    if (cluster.interval) {
      clearInterval(cluster.interval)
    }
    await cluster.disable()

    logger.info('unregister success, waiting for background task, ctrl+c again to force kill')
    server.close()
    cluster.nginxProcess?.kill()
  }
  process.on('SIGTERM', (signal) => {
    void onStop(signal)
  })
  process.on('SIGINT', (signal) => {
    void onStop(signal)
  })

  if (nodeCluster.isWorker) {
    process.on('disconnect', () => {
      void onStop('disconnect')
    })
  }
}
