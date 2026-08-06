import {max} from 'lodash-es'
import type {OpenbmclapiAgentConfiguration} from './config.js'
import type {IFileList} from './types.js'

export interface FileListClient {
  getConfiguration(): Promise<OpenbmclapiAgentConfiguration>
  getFileList(lastModified?: number): Promise<IFileList>
  syncFiles(fileList: IFileList, syncConfig: OpenbmclapiAgentConfiguration['sync']): Promise<void>
}

export async function refreshFileList(client: FileListClient, previous: IFileList): Promise<IFileList> {
  const lastModified = max(previous.files.map((file) => file.mtime))
  const incremental = await client.getFileList(lastModified)
  if (incremental.files.length === 0) {
    return previous
  }

  const configuration = await client.getConfiguration()
  await client.syncFiles(incremental, configuration.sync)
  return incremental
}
