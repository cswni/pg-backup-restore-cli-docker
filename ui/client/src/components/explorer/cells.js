// How a value from /api/explorer/rows or /query is shown in a grid cell.
// Cells are JSON values; long strings arrive as { truncated, value, length }
// and binary values as { binary, length, preview }.

const INLINE_LIMIT = 120

/**
 * @param {unknown} cell
 * @returns {{ kind: 'null'|'binary'|'truncated'|'json'|'text', text: string, needsDetail: boolean }}
 */
export function describeCell(cell) {
  if (cell === null || cell === undefined) return { kind: 'null', text: 'NULL', needsDetail: false }
  if (typeof cell === 'object' && !Array.isArray(cell)) {
    if (cell.binary === true) {
      return { kind: 'binary', text: `binary, ${cell.length} bytes`, needsDetail: true }
    }
    if (cell.truncated === true) {
      return { kind: 'truncated', text: String(cell.value).slice(0, INLINE_LIMIT), needsDetail: true }
    }
  }
  if (typeof cell === 'object') {
    const text = JSON.stringify(cell)
    return { kind: 'json', text: text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) : text, needsDetail: true }
  }
  const text = String(cell)
  return { kind: 'text', text: text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) : text, needsDetail: text.length > INLINE_LIMIT }
}

/** Full value for the detail dialog and the clipboard. */
export function fullCellText(cell) {
  if (cell === null || cell === undefined) return 'NULL'
  if (typeof cell === 'object' && !Array.isArray(cell)) {
    if (cell.binary === true) return cell.preview || ''
    if (cell.truncated === true) return String(cell.value)
  }
  if (typeof cell === 'object') return JSON.stringify(cell, null, 2)
  return String(cell)
}

/** One-line note shown above the full value in the detail dialog. */
export function cellNote(cell) {
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
    if (cell.binary === true) {
      return `Binary value, ${cell.length} bytes. Showing the first ${Math.min(32, cell.length)} bytes as hex.`
    }
    if (cell.truncated === true) {
      return `Long text, ${Number(cell.length).toLocaleString()} characters. The server sends the first ${String(cell.value).length.toLocaleString()}.`
    }
  }
  if (cell && typeof cell === 'object') return 'JSON value'
  return null
}
