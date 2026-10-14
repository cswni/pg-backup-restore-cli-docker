// Cell values sent to the browser. Long text and binary data are never sent
// in full: a page of rows must stay small whatever the table holds.

const MAX_TEXT = 2000
const BINARY_PREVIEW_BYTES = 32

/** A string, or `{ truncated, value, length }` when it is longer than MAX_TEXT. */
function textCell(value, length = value.length) {
  if (length <= MAX_TEXT && value.length <= MAX_TEXT) return value
  return { truncated: true, value: value.slice(0, MAX_TEXT), length }
}

/** `{ binary, length, preview }` with the first bytes as lowercase hex. */
function binaryCell(length, previewHex) {
  return { binary: true, length: Number(length), preview: String(previewHex || '').toLowerCase() }
}

/** Same, from the raw bytes. */
function bytesCell(bytes) {
  return binaryCell(bytes.length, Buffer.from(bytes.subarray(0, BINARY_PREVIEW_BYTES)).toString('hex'))
}

/**
 * Cell for a JSON value of unknown type (SQL console results): strings and
 * nested JSON whose text is too long come back as truncated text.
 */
function jsonCell(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return textCell(value)
  if (typeof value === 'object') {
    const text = JSON.stringify(value)
    return text.length > MAX_TEXT ? textCell(text) : value
  }
  return value
}

/**
 * Cell for a value fetched as two slots `[length, value]` by the SQL
 * browsers (see postgres-sql.js / mysql-sql.js).
 * @param {'binary'|'text'|'datetime'|'plain'} kind
 */
function slotCell(kind, length, value) {
  if (value === null || value === undefined) return null
  if (kind === 'binary') return binaryCell(length, value)
  if (kind === 'datetime' && typeof value === 'string') return value.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
  if (typeof value === 'string') return textCell(value, length ?? value.length)
  if (length !== null && length !== undefined && length > MAX_TEXT) return textCell(JSON.stringify(value), length)
  return value
}

module.exports = { MAX_TEXT, BINARY_PREVIEW_BYTES, textCell, binaryCell, bytesCell, jsonCell, slotCell }
