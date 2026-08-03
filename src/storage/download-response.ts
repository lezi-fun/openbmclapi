import type {Response} from 'express'
import rangeParser from 'range-parser'

export interface StorageDownloadRequest {
  hash: string
  hashPath: string
  method: string
  range?: string
  attachmentName?: string
}

export interface StorageDownloadResult {
  bytes: number
  hits: number
}

export function normalizeAttachmentName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.toWellFormed()
}

export function requestedDownloadBytes(fileSize: number, request: StorageDownloadRequest): number {
  if (request.method === 'HEAD') return 0
  if (!request.range) return fileSize

  const ranges = rangeParser(fileSize, request.range, {combine: true})
  if (ranges === -1) return 0
  if (ranges === -2) return fileSize
  return ranges.reduce((total, range) => total + range.end - range.start + 1, 0)
}

export function successfulDownload(fileSize: number, request: StorageDownloadRequest): StorageDownloadResult {
  return {bytes: requestedDownloadBytes(fileSize, request), hits: 1}
}

export function attachmentHeader(name: string): string {
  const normalized = name.toWellFormed()
  const fallback = normalized.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download'
  const encoded = encodeURIComponent(normalized).replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export function applyAttachmentHeader(res: Response, request: StorageDownloadRequest): void {
  if (request.attachmentName) {
    res.set('content-disposition', attachmentHeader(request.attachmentName))
  }
}

export function copyDownloadHeaders(headers: Record<string, string | string[] | undefined>, res: Response): void {
  const forwardedHeaders = [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified',
  ]
  for (const header of forwardedHeaders) {
    const value = headers[header]
    if (value !== undefined) {
      res.set(header, value)
    }
  }
}
