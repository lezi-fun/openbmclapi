import {readFileSync} from 'node:fs'
import {createServer, type Server} from 'node:http'
import {createSecureServer, type Http2SecureServer} from 'node:http2'
import {join} from 'node:path'
import express, {type NextFunction, type Request, type Response} from 'express'
import {HTTPError} from 'got'
import http2Express from 'http2-express'
import morgan from 'morgan'
import type {Config} from './config.js'
import {AuthRouteFactory} from './routes/auth.route.js'
import MeasureRouteFactory from './routes/measure.route.js'
import type {RuntimeLifecycle} from './runtime-lifecycle.js'
import type {IStorage} from './storage/base.storage.js'
import {normalizeAttachmentName, type StorageDownloadRequest} from './storage/download-response.js'
import {checkSign, hashToFilename} from './util.js'
import type {TrafficRecorder} from './traffic-meter.js'

export type DataPlaneServerInstance = Server | Http2SecureServer

export interface DataPlaneServerOptions {
  certDirectory: string
  config: Pick<Config, 'clusterSecret' | 'disableAccessLog'>
  downloadFile: (hash: string) => Promise<void>
  runtime: Pick<RuntimeLifecycle, 'signal' | 'track'>
  storage: IStorage
  traffic: TrafficRecorder
}

export class DataPlaneServer {
  private readonly downloadPromise = new Map<string, Promise<void>>()
  private server?: DataPlaneServerInstance

  public constructor(private readonly options: DataPlaneServerOptions) {}

  public setup(https: boolean): DataPlaneServerInstance {
    const app = http2Express(express)
    app.enable('trust proxy')
    app.get('/auth', AuthRouteFactory(this.options.config))

    if (!this.options.config.disableAccessLog) {
      app.use(morgan('combined'))
    }
    app.get('/download/:hash', async (req, res: Response, next: NextFunction) => {
      await this.handleDownload(req, res, next)
    })
    app.use('/measure', MeasureRouteFactory(this.options.config))

    this.server = https
      ? createSecureServer(
          {
            key: readFileSync(join(this.options.certDirectory, 'key.pem'), 'utf8'),
            cert: readFileSync(join(this.options.certDirectory, 'cert.pem'), 'utf8'),
            allowHTTP1: true,
          },
          app,
        )
      : createServer(app)
    return this.server
  }

  public async listen(port: number | string, host?: string): Promise<void> {
    const server = this.getServer()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      if (typeof port === 'number' && host) {
        server.listen(port, host)
      } else {
        server.listen(port)
      }
    })
  }

  public async close(): Promise<void> {
    if (!this.server?.listening) return
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
  }

  private async handleDownload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hashParam = req.params.hash
      if (typeof hashParam !== 'string' || !/^\w+$/.test(hashParam)) {
        next()
        return
      }
      const hash = hashParam.toLowerCase()
      const signValid = checkSign(hash, this.options.config.clusterSecret, req.query as NodeJS.Dict<string>)
      if (!signValid) {
        res.status(403).send('invalid sign')
        return
      }

      const hashPath = hashToFilename(hash)
      if (!(await this.options.storage.exists(hashPath))) {
        await this.downloadMissingFile(hash)
      }
      res.set('x-bmclapi-hash', hash)
      const downloadRequest: StorageDownloadRequest = {
        hash,
        hashPath,
        method: req.method,
        range: req.headers.range,
        attachmentName: normalizeAttachmentName(req.query.name),
        signal: this.options.runtime.signal,
      }
      const {bytes, hits} = await this.options.storage.serve(downloadRequest, res)
      this.options.traffic.record({bytes, hits})
    } catch (error) {
      if (error instanceof HTTPError && error.response.statusCode === 404) {
        next()
        return
      }
      next(error)
    }
  }

  private async downloadMissingFile(hash: string): Promise<void> {
    const existing = this.downloadPromise.get(hash)
    if (existing) {
      await existing
      return
    }

    const download = this.options.runtime.track(this.options.downloadFile(hash))
    this.downloadPromise.set(hash, download)
    try {
      await download
    } finally {
      if (this.downloadPromise.get(hash) === download) {
        this.downloadPromise.delete(hash)
      }
    }
  }

  private getServer(): DataPlaneServerInstance {
    if (!this.server) throw new Error('server not setup')
    return this.server
  }
}
