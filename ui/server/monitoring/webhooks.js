const { randomUUID } = require('crypto')
const settings = require('../settings')
const { httpError } = require('../validation')

// Notification webhooks. Non-secret config lives in the setting
// 'monitoring.webhooks'; each URL is a secret ('monitoring.webhook.<id>.url')
// and is never returned to the browser or written to logs.

const LIST_KEY = 'monitoring.webhooks'
const FORMATS = ['generic', 'slack', 'discord', 'teams']
const EVENTS = ['job.failed', 'job.succeeded', 'schedule.overdue']
const MAX_WEBHOOKS = 20
const MAX_NAME_LENGTH = 100
const MAX_URL_LENGTH = 2048

const urlKey = (id) => `monitoring.webhook.${id}.url`

function readAll() {
  const list = settings.getSetting(LIST_KEY, [])
  return Array.isArray(list) ? list : []
}

/** Webhook config as sent to the browser (no URL). */
function publicWebhook(w) {
  return { ...w, configured: settings.hasSecret(urlKey(w.id)) }
}

/** @returns {object[]} webhooks without secrets */
function listWebhooks() {
  return readAll().map(publicWebhook)
}

function findWebhook(id) {
  const w = readAll().find((x) => x.id === id)
  if (!w) throw httpError(404, 'Webhook not found')
  return w
}

/**
 * Validate a webhook URL (http/https only).
 * @param {unknown} url
 * @returns {string}
 */
function checkUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw httpError(400, 'url is required')
  if (url.length > MAX_URL_LENGTH) throw httpError(400, 'url is too long')
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    throw httpError(400, 'url must be a valid URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw httpError(400, 'url must use http or https')
  return parsed.toString()
}

function normalize(body, existing) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Request body must be a JSON object')
  const merged = { ...(existing || { format: 'generic', events: ['job.failed', 'schedule.overdue'], enabled: true }), ...body }
  const name = typeof merged.name === 'string' ? merged.name.trim() : ''
  if (!name) throw httpError(400, 'name is required')
  if (name.length > MAX_NAME_LENGTH) throw httpError(400, `name must be at most ${MAX_NAME_LENGTH} characters`)
  if (!FORMATS.includes(merged.format)) throw httpError(400, `format must be one of: ${FORMATS.join(', ')}`)
  if (!Array.isArray(merged.events) || merged.events.some((e) => !EVENTS.includes(e))) {
    throw httpError(400, `events must be a list of: ${EVENTS.join(', ')}`)
  }
  if (typeof merged.enabled !== 'boolean') throw httpError(400, 'enabled must be a boolean')
  return { name, format: merged.format, events: [...new Set(merged.events)], enabled: merged.enabled }
}

/** Create a webhook. Body: { name, url, format, events, enabled }. */
function createWebhook(body, now = Date.now()) {
  const list = readAll()
  if (list.length >= MAX_WEBHOOKS) throw httpError(400, `At most ${MAX_WEBHOOKS} webhooks are supported`)
  const fields = normalize(body)
  const url = checkUrl(body.url)
  const webhook = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now }
  settings.setSecret(urlKey(webhook.id), url)
  settings.setSetting(LIST_KEY, [...list, webhook])
  return publicWebhook(webhook)
}

/** Update a webhook; omit `url` (or send '') to keep the stored one. */
function updateWebhook(id, body, now = Date.now()) {
  const existing = findWebhook(id)
  const fields = normalize(body, existing)
  const url = body.url ? checkUrl(body.url) : null
  const updated = { ...existing, ...fields, updatedAt: now }
  if (url) settings.setSecret(urlKey(id), url)
  settings.setSetting(LIST_KEY, readAll().map((w) => (w.id === id ? updated : w)))
  return publicWebhook(updated)
}

function deleteWebhook(id) {
  findWebhook(id)
  settings.setSetting(LIST_KEY, readAll().filter((w) => w.id !== id))
  settings.deleteSetting(urlKey(id))
}

/** Webhook config plus its secret URL, for delivery only (never send to clients). */
function webhookWithUrl(w) {
  return { ...w, url: settings.getSecret(urlKey(w.id)) }
}

module.exports = {
  FORMATS, EVENTS, listWebhooks, findWebhook, createWebhook, updateWebhook, deleteWebhook,
  webhookWithUrl, readAll, checkUrl,
}
