/**
 * 前端调后端的那一层。
 *
 * 只有这里知道接口形状；组件拿到的是已经收敛过的类型和 Error，
 * 不用各自判断 response.ok 和 JSON 结构。
 */

export type JobStatus = 'uploading' | 'queued' | 'submitting' | 'processing' | 'downloading' | 'completed' | 'failed'

/** 去字幕的两种方式：自动找，或者只擦用户圈出来的那几块。 */
export type EraseMode = 'auto' | 'box'

/**
 * 一个框，四个数都是占画面的比例（0~1，左上角为原点）。
 *
 * 用比例不用像素：画框时量到的本来就是显示尺寸上的比例，而显示尺寸和视频
 * 真实分辨率几乎永远不一样。一路保持比例，到腾讯那边正好是它要的 percent 单位。
 */
export type Area = [left: number, top: number, right: number, bottom: number]

export interface Job {
  id: string
  status: JobStatus
  filename: string
  mode: EraseMode
  bytes: number
  durationSeconds: number | null
  createdAt: number
  updatedAt: number
  submittedAt: number | null
  completedAt: number | null
  expiresAt: number
  resultUrl: string | null
  downloadUrl: string | null
  resultBytes: number | null
  error: { code: string; message: string } | null
}

export interface ServiceConfig {
  ready: boolean
  maxUploadBytes: number
  maxDurationSeconds: number
  accept: string
  retentionHours: number
}

/** 带上后端给的错误码，组件可以据此区分"文件太大"和"今天额度用完了"。 */
export class ApiError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export async function fetchServiceConfig(): Promise<ServiceConfig> {
  const response = await fetch('/api/config', { headers: { accept: 'application/json' } })
  if (!response.ok) throw new ApiError('Could not reach the service.', 'unreachable', response.status)
  return (await response.json()) as ServiceConfig
}

export async function fetchJob(id: string): Promise<Job> {
  const response = await fetch(`/api/jobs/${id}`, { headers: { accept: 'application/json' } })
  const body = await readJson(response)
  if (!response.ok) throw toApiError(body, response.status)
  return (body as { job: Job }).job
}

export async function deleteJob(id: string): Promise<void> {
  await fetch(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => undefined)
}

/**
 * 上传视频并创建任务。
 *
 * 用 XMLHttpRequest 而不是 fetch：只有它能报告**上传**进度。传 500MB 的时候
 * 没有进度条的等待和卡死没有区别，用户会以为页面坏了然后重试，反而更糟。
 * 返回的 abort 让组件能真正取消上传，而不只是不再理会结果。
 *
 * areas 走查询串：请求体从第一个字节起就是视频本身，后端直接写盘，
 * 不解析任何结构——塞一个 multipart 进去就得为这点元数据多一个解析器。
 */
export function uploadVideo(
  file: File,
  handlers: { onProgress?: (fraction: number) => void; areas?: Area[] } = {},
): { promise: Promise<Job>; abort: () => void } {
  const query = new URLSearchParams()
  for (const area of handlers.areas ?? []) query.append('area', area.join(','))
  const url = query.size > 0 ? `/api/jobs?${query}` : '/api/jobs'

  const xhr = new XMLHttpRequest()
  const promise = new Promise<Job>((resolve, reject) => {
    xhr.open('POST', url)
    xhr.responseType = 'text'
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    // 文件名走请求头而不是 multipart：省掉一个 multipart 解析器，
    // 后端只要把请求体直接写进磁盘就行。
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name))

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) handlers.onProgress?.(event.loaded / event.total)
    })
    xhr.addEventListener('load', () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* 下面统一按未知错误处理 */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object' && 'job' in body) {
        resolve((body as { job: Job }).job)
      } else {
        reject(toApiError(body, xhr.status))
      }
    })
    xhr.addEventListener('error', () => reject(new ApiError('The upload failed. Check your connection and try again.', 'network', 0)))
    xhr.addEventListener('abort', () => reject(new ApiError('Upload cancelled.', 'aborted', 0)))
    xhr.send(file)
  })

  return { promise, abort: () => xhr.abort() }
}

/**
 * 轮询任务直到结束。
 *
 * 间隔随等待时间拉长：刚提交时用户盯着屏幕，一秒一次；跑到第五分钟时
 * 再按一秒一次问下去，只是白白给服务器加负载。
 */
export async function pollJob(
  id: string,
  handlers: { onUpdate?: (job: Job) => void; signal?: AbortSignal } = {},
): Promise<Job> {
  const startedAt = Date.now()
  const aborted = () => new ApiError('Cancelled.', 'aborted', 0)

  while (true) {
    if (handlers.signal?.aborted) throw aborted()

    let job: Job
    try {
      job = await fetchJob(id)
    } catch (err) {
      // 取消发生在这次请求在途时:它的结果已经没人要了。这里不把它当真实
      // 错误往上抛,否则用户点了"取消"、界面已经回到初始状态之后,还会再弹
      // 一句 "This job no longer exists."——因为取消顺手把任务删了,
      // 这个 404 正是我们自己造成的。
      if (handlers.signal?.aborted) throw aborted()
      throw err
    }

    // 同理:取消之后不能再回调。再调一次 onUpdate 会把刚从历史里删掉的
    // 那条记录又写回去。
    if (handlers.signal?.aborted) throw aborted()
    handlers.onUpdate?.(job)
    if (job.status === 'completed' || job.status === 'failed') return job

    const elapsed = Date.now() - startedAt
    const interval = elapsed < 30_000 ? 1500 : elapsed < 180_000 ? 3000 : 6000
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function toApiError(body: unknown, status: number): ApiError {
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error
  return new ApiError(
    error?.message ?? 'Something went wrong. Please try again.',
    error?.code ?? 'unknown',
    status,
  )
}
