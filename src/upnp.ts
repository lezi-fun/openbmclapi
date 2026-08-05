import {second} from '@bangbang93/utils'
import {createUpnpClient, type UpnpClient} from '@xmcl/nat-api/dist/index.js'
import ms from 'ms'
import {logger} from './logger.js'
import {abortable} from './runtime-lifecycle.js'

export async function setupUpnp(port: number, publicPort = port, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const clientRequest = createUpnpClient()
  const client = signal ? await abortable(clientRequest, signal) : await clientRequest
  const portMap = doPortMap(client, port, publicPort)
  if (signal) {
    await abortable(portMap, signal)
  } else {
    await portMap
  }

  const renewal = setInterval(() => {
    doPortMap(client, port, publicPort).catch((e) => {
      logger.error(e, 'upnp续期失败')
    })
  }, ms('30m'))
  renewal.unref()
  signal?.addEventListener('abort', () => clearInterval(renewal), {once: true})

  const externalIp = client.externalIp()
  return signal ? await abortable(externalIp, signal) : await externalIp
}

async function doPortMap(client: UpnpClient, port: number, publicPort: number): Promise<void> {
  await client.map({
    public: publicPort,
    private: port,
    ttl: second('1h'),
    protocol: 'tcp',
    description: 'openbmclapi',
  })
}
