declare module '@xmcl/nat-api/dist/index.js' {
  export interface UpnpClient {
    externalIp(): Promise<string>
    map(options: {
      public: number
      private: number
      ttl: number
      protocol: 'tcp' | 'udp'
      description?: string
    }): Promise<void>
  }

  export function createUpnpClient(): Promise<UpnpClient>
}
