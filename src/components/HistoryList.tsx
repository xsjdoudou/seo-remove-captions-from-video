import { useCallback, useEffect, useState } from 'react'
import { ApiError, fetchJob, pollJob } from '../lib/api'
import {
  clearHistory,
  loadHistory,
  markExpired,
  removeEntry,
  subscribe,
  upsertEntry,
  type HistoryEntry,
} from '../lib/history'
import { formatBytes, formatDuration, shortStatusLabel } from '../lib/format'
import { ChevronIcon, DownloadIcon, ClockIcon } from './icons'

const TERMINAL: HistoryEntry['status'][] = ['completed', 'failed', 'expired']

/**
 * 最近任务列表。
 *
 * 放在工具正下方:它是工具的延伸,不是一个独立的功能页。没有登录体系,
 * 做成 /history 这样的路由反而会让人以为有账号体系在背后。
 *
 * 顺带解决了一个真实的使用问题:处理一段片子要几分钟,很多人会先去干别的,
 * 甚至关掉标签页。回来之后这里还在,没跑完的会继续轮询到完成。
 *
 * 收起/展开的状态由父组件持有:收起要同时改 .studio 的列宽,否则画布
 * 会在剩下的空间里偏心。这里只负责那块把手长什么样。
 */
export default function HistoryList({ open, onToggle }: { open: boolean; onToggle: () => void }) {

  // 初始必须是空数组:预渲染时没有 localStorage,服务端和客户端首次渲染
  // 必须一致,否则 hydrate 会报 mismatch 并把这块重建一遍。
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setEntries(loadHistory())
    setReady(true)
    return subscribe(setEntries)
  }, [])

  // 上一轮没跑完的任务:先问一次服务端,还在跑就继续轮询到结束。
  useEffect(() => {
    if (!ready) return
    const controller = new AbortController()
    const pending = loadHistory().filter((entry) => !TERMINAL.includes(entry.status))

    for (const entry of pending) {
      void (async () => {
        try {
          const job = await fetchJob(entry.id)
          upsertEntry(job)
          if (job.status !== 'completed' && job.status !== 'failed') {
            const finished = await pollJob(entry.id, { onUpdate: upsertEntry, signal: controller.signal })
            upsertEntry(finished)
          }
        } catch (err) {
          // 404 说明服务端已经清理掉了,标成过期而不是静默删掉——
          // 用户得知道那条记录为什么不见了。
          if (err instanceof ApiError && err.status === 404) markExpired(entry.id)
        }
      })()
    }

    return () => controller.abort()
  }, [ready])

  const onClear = useCallback(() => {
    clearHistory()
  }, [])

  return (
    <aside className={`side${open ? '' : ' side--collapsed'}`} aria-label="Your recent videos">
      {/*
        把手一直在,收起时它就是整块侧栏。
        收起走 CSS 隐藏而不是卸载组件:上面那个续轮询的 effect 得继续跑,
        不然用户把面板收起来,正在处理的任务就没人盯着了。
      */}
      <button
        type="button"
        className="side__toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="history-panel"
        title={open ? 'Hide your videos' : 'Show your videos'}
      >
        <ChevronIcon className="side__toggleIcon" />
        {/* 展开时卡片顶上就写着标题,把手再写一遍是重复;收起时它是唯一的线索,
            所以得带上条数——不然用户想不起来里面还存着东西。 */}
        {!open && (
          <span className="side__toggleLabel">
            Your videos{entries.length > 0 ? ` · ${entries.length}` : ''}
          </span>
        )}
        <span className="visually-hidden">{open ? 'Hide your videos' : 'Show your videos'}</span>
      </button>

      <div className="side__card" id="history-panel">
        <div className="side__head">
          <h2 className="side__title">
            <ClockIcon className="icon" /> Your videos
          </h2>
          {entries.length > 0 && (
            <button type="button" className="side__clear" onClick={onClear}>
              Clear
            </button>
          )}
        </div>

        {entries.length === 0 ? (
          <p className="side__empty">No videos yet</p>
        ) : (
          <>
            <ul className="side__list">
              {entries.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </ul>
            <p className="side__note">Kept in this browser only. Download what you want to keep.</p>
          </>
        )}
      </div>
    </aside>
  )
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  // 先把三个终态分出去，剩下的 status 在类型上就确定是"还在跑"的那几种，
  // 不用往 statusLabel 里塞一个 as never。
  switch (entry.status) {
    case 'completed':
      return (
        <Row entry={entry} badge={<span className="badge badge--ok">Ready</span>}>
          {entry.downloadUrl && (
            <a className="btn btn--ghost btn--sm" href={entry.downloadUrl} download>
              <DownloadIcon className="icon" /> Download
            </a>
          )}
        </Row>
      )
    case 'failed':
      return (
        <Row
          entry={entry}
          badge={
            <span className="badge badge--error" title={entry.errorMessage ?? undefined}>
              Failed
            </span>
          }
        />
      )
    case 'expired':
      return <Row entry={entry} muted badge={<span className="badge">Expired</span>} />
    default:
      return <Row entry={entry} badge={<span className="badge badge--busy">{shortStatusLabel(entry.status)}</span>} />
  }
}

function Row({
  entry,
  badge,
  muted = false,
  children,
}: {
  entry: HistoryEntry
  badge: React.ReactNode
  muted?: boolean
  children?: React.ReactNode
}) {
  return (
    <li className={`side__item${muted ? ' side__item--muted' : ''}`}>
      <div className="side__itemMain">
        <p className="side__name" title={entry.filename}>
          {entry.filename}
        </p>
        <p className="side__meta">
          {relativeTime(entry.createdAt)}
          {entry.durationSeconds ? ` · ${formatDuration(entry.durationSeconds)}` : ''}
          {entry.bytes ? ` · ${formatBytes(entry.bytes)}` : ''}
        </p>
      </div>

      <div className="side__itemSide">
        {badge}
        <div className="side__itemActions">
          {children}
          <button
            type="button"
            className="side__remove"
            onClick={() => removeEntry(entry.id)}
            aria-label={`Remove ${entry.filename} from this list`}
            title="Remove from this list"
          >
            ×
          </button>
        </div>
      </div>
    </li>
  )
}

/** "3 minutes ago" 这类相对时间。比绝对时间戳更贴近"刚刚那个片子"的心智。 */
function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`
}
