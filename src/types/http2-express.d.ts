declare module 'http2-express' {
  import type express from 'express'
  import type {Application} from 'express'
  import type {Http2ServerRequest, Http2ServerResponse} from 'node:http2'

  interface Http2Application extends Application {
    (request: Http2ServerRequest, response: Http2ServerResponse): void
  }

  function createHttp2Express(expressModule: typeof express): Http2Application

  export = createHttp2Express
}
