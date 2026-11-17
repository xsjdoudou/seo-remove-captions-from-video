import { useState } from 'react'
import type { ReactNode } from 'react'
import type { EraseMode } from '../lib/api'
import HistoryList from './HistoryList'
import ModePicker from './ModePicker'
import Workspace from './Workspace'

export default function VideoStudio({ children }: { children: ReactNode }) {
  const [historyOpen, setHistoryOpen] = useState(true)
  const [mode, setMode] = useState<EraseMode>('auto')
  const [busy, setBusy] = useState(false)

  return (
    <div className="studio">
      {children}
      <ModePicker mode={mode} onChange={setMode} disabled={busy} />
      <Workspace mode={mode} onBusyChange={setBusy} />
      <HistoryList open={historyOpen} onToggle={() => setHistoryOpen((value) => !value)} />
    </div>
  )
}
