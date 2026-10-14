// Copy text to the clipboard. navigator.clipboard only exists on secure
// origins (HTTPS or localhost), so plain-HTTP installs fall back to the
// legacy execCommand('copy') on a temporary textarea.

function legacyCopy(text) {
  const previous = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  if (previous instanceof HTMLElement) previous.focus()
  return copied
}

/**
 * @param {string} text
 * @returns {Promise<boolean>} true when the text reached the clipboard
 */
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or document not focused: try the legacy path
    }
  }
  return legacyCopy(text)
}
