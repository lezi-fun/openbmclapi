import {access, mkdir, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function writeFileWithParents(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, data)
}
