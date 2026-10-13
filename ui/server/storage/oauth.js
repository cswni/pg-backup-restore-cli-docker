const express = require('express')
const { requireAdmin } = require('../auth')
const { httpError } = require('../validation')
const { handle } = require('../routes/util')
const destinations = require('./destinations')
const gdrive = require('./destinations/gdrive')
const { errorMessage } = require('./util')

// Google Drive OAuth connect flow.
//
//   GET /api/storage/gdrive/:id/connect          (admin) → 302 to Google consent
//   GET /api/storage/gdrive/oauth/callback       (public) ← Google redirects here
//
// The callback is public because the browser may not send credentials on a
// cross-site redirect. It is protected by a random, single-use `state` that
// is bound to the destination and the admin who started the flow and
// expires after 10 minutes. The final redirect always goes to a fixed local
// path, never to a caller-supplied URL.

const CALLBACK_PATH = '/api/storage/gdrive/oauth/callback'
const SETTINGS_PATH = '/settings/storage'

/** Base URL of this app: PUBLIC_URL when set, else derived from the request (trust proxy). */
function publicBaseUrl(req) {
  const env = process.env.PUBLIC_URL
  if (env) {
    let url
    try { url = new URL(env) } catch { throw httpError(500, 'PUBLIC_URL is not a valid URL') }
    if (!['http:', 'https:'].includes(url.protocol)) throw httpError(500, 'PUBLIC_URL must be http(s)')
    return env.replace(/\/+$/, '')
  }
  return `${req.protocol}://${req.get('host')}`
}

/** Redirect URI to register in Google Cloud ("Authorized redirect URIs"). */
function redirectUri(req) {
  return publicBaseUrl(req) + CALLBACK_PATH
}

function settingsRedirect(res, params) {
  res.redirect(`${SETTINGS_PATH}?${new URLSearchParams(params)}`)
}

const router = express.Router()
const publicRouter = express.Router()

router.get('/storage/gdrive/:id/connect', requireAdmin, handle(async (req, res) => {
  const dest = destinations.requireDestination(req.params.id)
  if (dest.type !== 'gdrive') throw httpError(400, 'Not a Google Drive destination')
  if (!dest.config.clientId || !dest.config.clientSecret) throw httpError(400, 'Save the OAuth client ID and secret first')
  const uri = redirectUri(req)
  const state = destinations.createOAuthState({ destinationId: dest.id, username: req.user?.username, redirectUri: uri })
  res.redirect(gdrive.authUrl({ clientId: dest.config.clientId, redirectUri: uri, state }))
}))

publicRouter.get('/storage/gdrive/oauth/callback', handle(async (req, res) => {
  const { code, state, error } = req.query
  const saved = destinations.consumeOAuthState(state)
  if (!saved) return settingsRedirect(res, { gdrive: 'error', reason: 'invalid_state' })
  const dest = destinations.getDestination(saved.destinationId)
  if (!dest || dest.type !== 'gdrive') return settingsRedirect(res, { gdrive: 'error', reason: 'unknown_destination' })
  if (error || typeof code !== 'string' || !code) return settingsRedirect(res, { gdrive: 'error', reason: 'denied', id: dest.id })

  try {
    const { refreshToken } = await gdrive.exchangeCode({
      clientId: dest.config.clientId, clientSecret: dest.config.clientSecret, code, redirectUri: saved.redirectUri,
    })
    const connected = destinations.patchConfig(dest.id, { refreshToken, accountEmail: '' })
    const email = await gdrive.accountEmail(connected).catch(() => '')
    if (email) destinations.patchConfig(dest.id, { accountEmail: email })
    console.log(`[storage] Google Drive destination '${dest.name}' connected by ${saved.username || 'unknown'}`)
    settingsRedirect(res, { gdrive: 'connected', id: dest.id })
  } catch (err) {
    console.error(`[storage] Google Drive connect failed for '${dest.name}': ${errorMessage(err)}`)
    settingsRedirect(res, { gdrive: 'error', reason: 'exchange_failed', id: dest.id })
  }
}))

module.exports = { router, publicRouter, redirectUri, CALLBACK_PATH }
