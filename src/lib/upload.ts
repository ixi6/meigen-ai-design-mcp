/**
 * Image compression and R2 upload utility
 * Replicates the frontend's ReferenceImageUpload.tsx logic for Node.js:
 *   compress (max 2MB, max 2048px) → presign → PUT to R2 → public URL
 */

import { readFileSync } from 'fs'
import { basename, extname } from 'path'
import sharp from 'sharp'
import type { MeiGenConfig } from '../config.js'

const MAX_SIZE_BYTES = 2 * 1024 * 1024  // 2MB compression target (matches frontend)
const MAX_DIMENSION = 2048               // Max width or height (matches frontend)

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Magic bytes signatures for supported image formats */
const MAGIC_BYTES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP: starts with RIFF....WEBP
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
]

/** Validate that file content matches its declared MIME type via magic bytes */
function validateMagicBytes(buffer: Buffer, declaredMime: string): void {
  if (buffer.length < 12) {
    throw new Error('File too small to be a valid image')
  }

  const matched = MAGIC_BYTES.find(sig => {
    const offset = sig.offset || 0
    return sig.bytes.every((b, i) => buffer[offset + i] === b)
  })

  if (!matched) {
    throw new Error('File content does not match any supported image format. The file may be corrupted or not a real image.')
  }

  // WebP needs additional check: bytes 8-11 should be "WEBP"
  if (matched.mime === 'image/webp') {
    const webpTag = buffer.slice(8, 12).toString('ascii')
    if (webpTag !== 'WEBP') {
      // It's a RIFF file but not WebP — could be AVI, WAV, etc.
      if (declaredMime === 'image/webp') {
        throw new Error('File has RIFF header but is not a WebP image')
      }
      // Not WebP, check if it matches declared type via other signatures
      const actualMatch = MAGIC_BYTES.find(sig =>
        sig.mime !== 'image/webp' && sig.bytes.every((b, i) => buffer[i] === b)
      )
      if (!actualMatch || actualMatch.mime !== declaredMime) {
        throw new Error(`File content does not match declared type ${declaredMime}`)
      }
      return
    }
  }

  // For non-WebP RIFF matches, verify declared type matches detected type
  if (matched.mime !== declaredMime && !(matched.mime === 'image/webp' && declaredMime === 'image/webp')) {
    throw new Error(`File extension suggests ${declaredMime} but content is ${matched.mime}`)
  }
}

interface PresignResponse {
  success: boolean
  error?: string
  presignedUrl: string
  publicUrl: string
}

export interface UploadResult {
  publicUrl: string
  originalSize: number
  compressedSize: number
}

/**
 * Compress an image buffer to fit within MAX_SIZE_BYTES and MAX_DIMENSION.
 * Strategy: resize to fit max dimension, then reduce JPEG quality if still too large.
 */
async function compressImage(
  inputBuffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const metadata = await sharp(inputBuffer).metadata()
  const { width, height } = metadata

  // Already small enough — no compression needed
  const needsResize = (width && width > MAX_DIMENSION) || (height && height > MAX_DIMENSION)
  if (!needsResize && inputBuffer.byteLength <= MAX_SIZE_BYTES) {
    return { buffer: inputBuffer, mimeType }
  }

  // Resize to fit within MAX_DIMENSION, preserving aspect ratio
  let pipeline = sharp(inputBuffer)
  if (needsResize) {
    pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
  }

  // Output as JPEG for best compression (unless already WebP)
  if (mimeType === 'image/webp') {
    let result = await pipeline.webp({ quality: 85 }).toBuffer()
    if (result.byteLength <= MAX_SIZE_BYTES) {
      return { buffer: result, mimeType: 'image/webp' }
    }
    // Reduce quality iteratively
    for (const q of [80, 70, 60]) {
      result = await sharp(inputBuffer)
        .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: q })
        .toBuffer()
      if (result.byteLength <= MAX_SIZE_BYTES) {
        return { buffer: result, mimeType: 'image/webp' }
      }
    }
    return { buffer: result, mimeType: 'image/webp' }
  }

  // Default: output as JPEG
  let result = await pipeline.jpeg({ quality: 85 }).toBuffer()
  if (result.byteLength <= MAX_SIZE_BYTES) {
    return { buffer: result, mimeType: 'image/jpeg' }
  }
  // Reduce quality iteratively
  for (const q of [80, 70, 60]) {
    result = await sharp(inputBuffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: q })
      .toBuffer()
    if (result.byteLength <= MAX_SIZE_BYTES) {
      return { buffer: result, mimeType: 'image/jpeg' }
    }
  }
  return { buffer: result, mimeType: 'image/jpeg' }
}

/**
 * Upload a buffer to R2 via the presign flow.
 * No authentication required — the presign endpoint validates content-type and size only.
 */
async function uploadToR2(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  config: MeiGenConfig,
): Promise<string> {
  // 1. Get presigned URL
  const presignRes = await fetch(`${config.uploadGatewayUrl}/upload/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      contentType: mimeType,
      size: buffer.byteLength,
    }),
  })

  if (!presignRes.ok) {
    const errorData = await presignRes.json().catch(() => ({})) as { error?: string }
    throw new Error(errorData.error || `Presign failed: ${presignRes.status}`)
  }

  const presignData = await presignRes.json() as PresignResponse
  if (!presignData.success) {
    throw new Error(presignData.error || 'Presign failed')
  }

  // 2. Upload to R2
  const uploadRes = await fetch(presignData.presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: buffer,
  })

  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${uploadRes.status}`)
  }

  return presignData.publicUrl
}

/**
 * Read a local image, compress it, and upload to R2.
 * Returns the public URL for use as referenceImages in generate_image.
 */
export async function processAndUploadImage(
  filePath: string,
  config: MeiGenConfig,
): Promise<UploadResult> {
  // Read file
  const originalBuffer = readFileSync(filePath)
  const originalSize = originalBuffer.byteLength

  // Detect MIME type from extension
  const ext = extname(filePath).toLowerCase()
  const mimeType = MIME_MAP[ext]
  if (!mimeType) {
    throw new Error(`Unsupported image format: ${ext}. Supported: JPEG, PNG, WebP, GIF`)
  }

  // Validate file content matches declared type
  validateMagicBytes(originalBuffer, mimeType)

  // Compress
  const compressed = await compressImage(originalBuffer, mimeType)

  // Upload
  const filename = basename(filePath)
  const publicUrl = await uploadToR2(compressed.buffer, filename, compressed.mimeType, config)

  return {
    publicUrl,
    originalSize,
    compressedSize: compressed.buffer.byteLength,
  }
}
