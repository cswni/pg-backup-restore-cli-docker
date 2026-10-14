import React from 'react'
import { Lock } from 'lucide-react'
import { CHIP_CLASS } from '../UI'

const TYPE_LABEL = { s3: 'S3', gdrive: 'Google Drive' }

function Badge({ title, children }) {
  return <span title={title} className={CHIP_CLASS}>{children}</span>
}

/** gz / encrypted / remote-copy / remote-only badges for a backup list row. */
export default function BackupBadges({ backup }) {
  const locations = backup.locations || []
  const compressed = backup.compressed || /\.gz(\.enc)?$/i.test(backup.name)
  const encrypted = backup.encrypted || /\.enc$/i.test(backup.name)
  const where = locations.map((l) => TYPE_LABEL[l.type] || l.type).join(', ')
  return (
    <span className="inline-flex flex-wrap gap-1">
      {compressed && <Badge title="gzip compressed">gz</Badge>}
      {encrypted && <Badge title="Encrypted (AES-256-GCM)"><Lock aria-hidden="true" className="size-3" /> enc</Badge>}
      {locations.length > 0 && (
        <Badge title={`Remote copies: ${where}`}>{locations.length} remote</Badge>
      )}
      {backup.local === false && (
        <Badge title="The local file was removed; restore downloads it from a remote copy">
          remote only
        </Badge>
      )}
    </span>
  )
}
