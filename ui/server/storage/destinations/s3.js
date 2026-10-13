const fs = require('fs')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { S3Client, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { httpError } = require('../../validation')

// S3 and S3-compatible object storage (AWS, MinIO, Backblaze B2, Cloudflare
// R2, Wasabi…). Uploads stream from disk with multipart (lib-storage).

const PART_SIZE = 16 * 1024 * 1024
const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/
const REGION_RE = /^[A-Za-z0-9-]{1,50}$/
const PREFIX_RE = /^[A-Za-z0-9!_.*'()/ -]{0,512}$/

function str(value, field, { required = false, max = 512 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw httpError(400, `${field} is required`)
    return ''
  }
  if (typeof value !== 'string' || value.length > max) throw httpError(400, `${field} must be a string (max ${max} chars)`)
  return value.trim()
}

function validateEndpoint(value) {
  const endpoint = str(value, 'endpoint')
  if (!endpoint) return ''
  let url
  try { url = new URL(endpoint) } catch { throw httpError(400, 'endpoint must be a valid URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'endpoint must be http(s)')
  return endpoint.replace(/\/+$/, '')
}

function validatePrefix(value) {
  const prefix = str(value, 'prefix').replace(/^\/+/, '')
  if (!PREFIX_RE.test(prefix) || prefix.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw httpError(400, 'prefix contains unsupported characters')
  }
  return prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix
}

/**
 * Validate S3 settings. Secrets left empty keep their current value.
 * @param {object} input     values from the API
 * @param {object} [current] stored config (with decrypted secrets) when updating
 */
function validateConfig(input = {}, current = {}) {
  const bucket = str(input.bucket, 'bucket', { required: true, max: 255 })
  if (!BUCKET_RE.test(bucket)) throw httpError(400, 'bucket name is invalid')
  const region = str(input.region, 'region', { max: 50 }) || 'us-east-1'
  if (!REGION_RE.test(region)) throw httpError(400, 'region is invalid')
  const secretAccessKey = str(input.secretAccessKey, 'secretAccessKey', { max: 1024 }) || current.secretAccessKey
  if (!secretAccessKey) throw httpError(400, 'secretAccessKey is required')
  if (input.forcePathStyle !== undefined && typeof input.forcePathStyle !== 'boolean') {
    throw httpError(400, 'forcePathStyle must be a boolean')
  }
  return {
    endpoint: validateEndpoint(input.endpoint),
    region,
    bucket,
    prefix: validatePrefix(input.prefix),
    accessKeyId: str(input.accessKeyId, 'accessKeyId', { required: true, max: 256 }),
    secretAccessKey,
    forcePathStyle: !!input.forcePathStyle,
  }
}

/** S3 client for a destination's config. */
function createClient(config) {
  return new S3Client({
    region: config.region || 'us-east-1',
    endpoint: config.endpoint || undefined,
    forcePathStyle: !!config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Many S3-compatible services reject the newer default CRC checksums
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 5,
  })
}

const objectKey = (config, name) => `${config.prefix || ''}${name}`

/** Upload a local file; returns the location details ({ key, bucket }). */
async function upload(dest, file, name) {
  const { config } = dest
  const client = createClient(config)
  try {
    const key = objectKey(config, name)
    const task = new Upload({
      client,
      params: { Bucket: config.bucket, Key: key, Body: fs.createReadStream(file), ContentType: 'application/octet-stream' },
      partSize: PART_SIZE,
      queueSize: 4,
      leavePartsOnError: false,
    })
    await task.done()
    return { key, bucket: config.bucket }
  } finally {
    client.destroy()
  }
}

/** Download a stored object into `outFile`. */
async function download(dest, location, outFile) {
  const client = createClient(dest.config)
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: location.bucket || dest.config.bucket, Key: location.key }))
    await pipeline(res.Body, fs.createWriteStream(outFile))
  } catch (err) {
    fs.rmSync(outFile, { force: true })
    throw err
  } finally {
    client.destroy()
  }
}

/** Delete a stored object (missing objects are not an error on S3). */
async function remove(dest, location) {
  const client = createClient(dest.config)
  try {
    await client.send(new DeleteObjectCommand({ Bucket: location.bucket || dest.config.bucket, Key: location.key }))
  } finally {
    client.destroy()
  }
}

/** Write and delete a small probe object to check credentials and permissions. */
async function test(dest) {
  const client = createClient(dest.config)
  const key = objectKey(dest.config, `.pgbackup-probe-${crypto.randomUUID()}`)
  try {
    await client.send(new PutObjectCommand({ Bucket: dest.config.bucket, Key: key, Body: 'pg-backup probe' }))
    await client.send(new DeleteObjectCommand({ Bucket: dest.config.bucket, Key: key }))
    return { ok: true, message: `Wrote and deleted s3://${dest.config.bucket}/${key}` }
  } finally {
    client.destroy()
  }
}

module.exports = { type: 's3', validateConfig, upload, download, remove, test, createClient }
