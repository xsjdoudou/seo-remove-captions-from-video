/** 展示用的格式化函数。集中放一处，免得 "1.2 MB" 和 "1.2MB" 在不同组件里各写一遍。 */

import type { Job, JobStatus } from './api'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

export function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes === 0) return `${rest}s`
  if (rest === 0) return `${minutes} min`
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

const LABELS: Record<JobStatus, string> = {
  uploading: 'Uploading…',
  queued: 'Queued…',
  submitting: 'Sending your video for processing…',
  processing: 'Erasing subtitles, frame by frame…',
  downloading: 'Almost there — fetching your clean video…',
  completed: 'Done',
  failed: 'Failed',
}

export function statusLabel(status: JobStatus): string {
  return LABELS[status] ?? 'Working…'
}

/**
 * 侧栏徽章用的短标签。
 *
 * statusLabel 那套文案是写给画布上那行大字的，塞进一个几十像素宽的徽章里
 * 会把整行撑满（"Erasing subtitles, frame by frame…" 直接顶到边）。
 * 徽章只需要回答"它现在在哪一步"，一个词就够。
 */
const SHORT_LABELS: Record<JobStatus, string> = {
  uploading: 'Uploading',
  queued: 'Queued',
  submitting: 'Queued',
  processing: 'Processing',
  downloading: 'Finishing',
  completed: 'Ready',
  failed: 'Failed',
}

export function shortStatusLabel(status: JobStatus): string {
  return SHORT_LABELS[status] ?? 'Working'
}

/**
 * 进度条的填充比例。
 *
 * 这是**估算**，不是真实进度：MPS 的查询接口只告诉我们"还在跑"或者"跑完了",
 * 没有百分比。所以按已用时间对一个基于视频时长的预估值取比例,并且卡在 92%
 * ——进度条走到 100% 然后停在那里不动,比走得慢还让人焦虑。
 */
export function progressFor(job: Job): number {
  if (job.status === 'completed') return 1
  if (job.status === 'queued' || job.status === 'submitting') return 0.05
  if (job.status === 'downloading') return 0.95

  const startedAt = job.submittedAt ?? job.createdAt
  const elapsed = (Date.now() - startedAt) / 1000
  // 粗略经验值：处理耗时和片长同一量级,再给固定开销留 20 秒。
  const estimate = Math.max(45, (job.durationSeconds ?? 60) * 1.4 + 20)
  return Math.min(0.92, 0.05 + (elapsed / estimate) * 0.87)
}
