import {randomUUID} from 'node:crypto'
import {access, mkdir, rename, rm, writeFile} from 'node:fs/promises'
import {basename, dirname, join} from 'node:path'

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

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, {recursive: true})

  const temporaryPath = join(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, data)
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, {force: true})
  }
}
