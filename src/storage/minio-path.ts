import {posix} from 'node:path'

export function minioObjectPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, '')
  return normalized ? `${normalized}/` : ''
}

export function minioObjectKey(prefix: string, path: string): string {
  return minioObjectPrefix(prefix) + path.replaceAll('\\', '/').replace(/^\/+/, '')
}

export function minioRelativePath(prefix: string, objectName: string): string | undefined {
  const objectPrefix = minioObjectPrefix(prefix)
  if (!objectName.startsWith(objectPrefix)) return undefined
  return objectName.slice(objectPrefix.length)
}

export function minioObjectHash(path: string): string {
  return posix.basename(path)
}
