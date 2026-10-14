import { useEffect, useRef, useState } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Focusable elements inside `node` that are actually rendered. */
function focusablesIn(node) {
  return [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
}

/** First control to focus when the dialog opens: skips the header close button when possible. */
function initialTarget(node) {
  const items = focusablesIn(node)
  return items.find((el) => !el.hasAttribute('data-dialog-close')) || items[0] || node
}

/**
 * Keyboard behaviour of a modal dialog or drawer rooted at `ref`:
 * moves focus inside on open (unless a child already took it via autoFocus),
 * keeps Tab / Shift+Tab inside, closes on Escape and returns focus to the
 * element that opened it.
 * @param {{ current: HTMLElement|null }} ref
 * @param {() => void} onClose
 */
export function useDialogFocus(ref, onClose) {
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  // Read on the first render, before an autoFocus child inside the dialog can take focus
  const [opener] = useState(() => document.activeElement)

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    if (!node.contains(document.activeElement)) initialTarget(node).focus()

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusablesIn(node)
      if (items.length === 0) {
        e.preventDefault()
        node.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const outside = !node.contains(document.activeElement)
      if (e.shiftKey && (outside || document.activeElement === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (outside || document.activeElement === last)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
    }
  }, [ref, opener])
}
