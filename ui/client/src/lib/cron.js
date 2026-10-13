// Cron presets for the schedule form: build an expression from a preset and
// recognise expressions that match one (for editing and human-friendly text).

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const PRESETS = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'custom', label: 'Custom' },
]

export const DEFAULT_PRESET = { preset: 'daily', minute: 0, hour: 2, weekday: 1, monthDay: 1, custom: '0 2 * * *' }

const pad = (n) => String(n).padStart(2, '0')
const NUM = '(\\d{1,2})'

/**
 * Cron expression for a preset state.
 * @param {{ preset: string, minute: number, hour: number, weekday: number, monthDay: number, custom: string }} p
 * @returns {string}
 */
export function buildCron(p) {
  switch (p.preset) {
    case 'hourly': return `${p.minute} * * * *`
    case 'daily': return `${p.minute} ${p.hour} * * *`
    case 'weekly': return `${p.minute} ${p.hour} * * ${p.weekday}`
    case 'monthly': return `${p.minute} ${p.hour} ${p.monthDay} * *`
    default: return p.custom.trim()
  }
}

/**
 * Preset state matching an expression (falls back to 'custom').
 * @param {string} cron
 */
export function parseCron(cron) {
  const expr = (cron || '').trim().replace(/\s+/g, ' ')
  const base = { ...DEFAULT_PRESET, custom: expr }
  let m = expr.match(new RegExp(`^${NUM} \\* \\* \\* \\*$`))
  if (m) return { ...base, preset: 'hourly', minute: +m[1] }
  m = expr.match(new RegExp(`^${NUM} ${NUM} \\* \\* \\*$`))
  if (m) return { ...base, preset: 'daily', minute: +m[1], hour: +m[2] }
  m = expr.match(new RegExp(`^${NUM} ${NUM} \\* \\* ([0-6])$`))
  if (m) return { ...base, preset: 'weekly', minute: +m[1], hour: +m[2], weekday: +m[3] }
  m = expr.match(new RegExp(`^${NUM} ${NUM} ${NUM} \\* \\*$`))
  if (m) return { ...base, preset: 'monthly', minute: +m[1], hour: +m[2], monthDay: +m[3] }
  return { ...base, preset: 'custom' }
}

/** Human-friendly description of a cron expression. */
export function describeCron(cron) {
  const p = parseCron(cron)
  const time = `${pad(p.hour)}:${pad(p.minute)}`
  switch (p.preset) {
    case 'hourly': return `Every hour at :${pad(p.minute)}`
    case 'daily': return `Daily at ${time}`
    case 'weekly': return `Weekly on ${WEEKDAYS[p.weekday]} at ${time}`
    case 'monthly': return `Monthly on day ${p.monthDay} at ${time}`
    default: return cron
  }
}
