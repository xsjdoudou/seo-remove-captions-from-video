import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ApiError,
  deleteJob,
  fetchServiceConfig,
  pollJob,
  uploadVideo,
  type Area,
  type EraseMode,
  type Job,
  type ServiceConfig,
} from '../lib/api'
import { formatBytes, formatDuration, progressFor, statusLabel } from '../lib/format'
import { upsertEntry, removeEntry as removeHistoryEntry } from '../lib/history'
import { AlertIcon, CheckIcon, DownloadIcon, UploadIcon } from './icons'

type Phase = 'idle' | 'selecting' | 'uploading' | 'processing' | 'done' | 'error'

/** 画面里一块被框住的区域，四个数都是 0~1 的比例。 */
type Draft = { x0: number; y0: number; x1: number; y1: number }

/** 框小于这个边长就不算数：多半是点了一下而不是拖了一下。 */
const MIN_SIDE = 0.02
/** 和后端的 MAX_AREAS 对齐。前端先挡一次，省得画了七个才被拒。 */
const MAX_AREAS = 6

/**
 * 工具本体：一块 16:9 的画布 + 画布下面一条操作栏。
 *
 * 画布形状跟着视频走,而不是跟着文案走——用户要处理的东西是横的,
 * 一个竖着的高框在整个流程里只有"空着等人拖文件"那一刻说得通,
 * 之后每一帧都在浪费宽度。固定 16:9 还有个好处:上传→处理→结果
 * 三个状态切换时画布尺寸纹丝不动,版面不会跳。
 *
 * 处理中和出结果时画布里放的是真的视频,不是一个转圈的图标:
 * 等待那几分钟里,看着自己的片子总比看着一个进度条有意义;
 * 出了结果可以直接和原片左右对照——"到底去干净没有"是用户唯一真正关心的问题。
 *
 * 框选模式会在中间多一步：选完文件先停在 selecting,让用户在画面上画框,
 * 按下按钮才真的开始上传。
 */
export default function Workspace({ mode, onBusyChange }: { mode: EraseMode; onBusyChange?: (busy: boolean) => void }) {
  const [service, setService] = useState<ServiceConfig | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [uploadFraction, setUploadFraction] = useState(0)
  const [job, setJob] = useState<Job | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  /** 本地源视频的 object URL。成片出来之后用它做"处理前"的对照。 */
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [showBefore, setShowBefore] = useState(false)

  /** 框选模式下，选好但还没上传的那个文件。 */
  const [pending, setPending] = useState<File | null>(null)
  const [areas, setAreas] = useState<Area[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  /** 画面在画布里实际占的那块矩形（contain 之后两边会留黑边）。 */
  const [frame, setFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)
  const beforeRef = useRef<HTMLVideoElement>(null)
  const afterRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    let cancelled = false
    fetchServiceConfig()
      .then((value) => {
        if (!cancelled) setService(value)
      })
      .catch(() => {
        // 配置拿不到不该让界面瘫掉：用保守的默认值继续，真超限了后端会拒。
        if (!cancelled) {
          setService({
            ready: true,
            maxUploadBytes: 600 * 1024 * 1024,
            maxDurationSeconds: 900,
            accept: 'video/*',
            retentionHours: 24,
            historyDays: 30,
            googleClientId: '',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 组件卸载时掐断在途的上传和轮询，否则用户切到别的页面之后
  // 后台还在以 1.5 秒一次的频率请求。
  useEffect(() => {
    return () => {
      abortRef.current?.()
      pollAbortRef.current?.abort()
    }
  }, [])

  // object URL 是进程级的资源，不撤销就一直占着那份文件，直到标签页关掉。
  useEffect(() => {
    if (!sourceUrl) return
    return () => URL.revokeObjectURL(sourceUrl)
  }, [sourceUrl])

  const reset = useCallback(() => {
    abortRef.current?.()
    pollAbortRef.current?.abort()
    abortRef.current = null
    pollAbortRef.current = null
    setPhase('idle')
    setJob(null)
    setMessage(null)
    setUploadFraction(0)
    setSourceUrl(null)
    setShowBefore(false)
    setPending(null)
    setAreas([])
    setDraft(null)
    setFrame(null)
    setDuration(0)
    setTime(0)
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  /**
   * 真正开始传。
   *
   * 和选文件分开：框选模式下这两件事中间隔着用户画框的那一段，
   * 而自动模式是选完直接走这里。
   */
  const startUpload = useCallback(
    async (file: File, boxes: Area[]) => {
      setPhase('uploading')
      setMessage(null)
      setUploadFraction(0)

      const { promise, abort } = uploadVideo(file, { onProgress: setUploadFraction, areas: boxes })
      abortRef.current = abort

      let created: Job
      try {
        created = await promise
      } catch (err) {
        abortRef.current = null
        if (err instanceof ApiError && err.code === 'aborted') {
          reset()
          return
        }
        setPhase('error')
        setMessage(err instanceof Error ? err.message : 'The upload failed.')
        return
      }

      abortRef.current = null
      setJob(created)
      setPhase('processing')
      // 任务一建好就记进历史:这之后用户随时可能关掉标签页,
      // 等到完成再记就把中途离开的那些人丢了。
      upsertEntry(created)

      const controller = new AbortController()
      pollAbortRef.current = controller
      try {
        const finished = await pollJob(created.id, {
          onUpdate: (next) => {
            setJob(next)
            upsertEntry(next)
          },
          signal: controller.signal,
        })
        upsertEntry(finished)
        if (finished.status === 'completed') {
          setPhase('done')
        } else {
          setPhase('error')
          setMessage(finished.error?.message ?? 'Processing failed.')
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'aborted') return
        setPhase('error')
        setMessage(err instanceof Error ? err.message : 'Lost contact with the server.')
      } finally {
        pollAbortRef.current = null
      }
    },
    [reset],
  )

  /**
   * 选中了一个文件。
   *
   * 自动模式直接传；框选模式停在 selecting，等用户把框画完。
   * 两种模式都先在本地挡一次体积——没必要让用户把超限的文件整个传上去再被拒。
   */
  const handleFile = useCallback(
    (file: File) => {
      if (!file) return
      if (service && file.size > service.maxUploadBytes) {
        setPhase('error')
        setMessage(`This file is ${formatBytes(file.size)}. The limit is ${formatBytes(service.maxUploadBytes)}.`)
        return
      }

      const url = URL.createObjectURL(file)
      setSourceUrl(url)
      setMessage(null)
      setAreas([])
      setDraft(null)
      setFrame(null)

      if (mode === 'box') {
        setPending(file)
        setPhase('selecting')
        return
      }
      setPending(null)
      void startUpload(file, [])
    },
    [mode, service, startUpload],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files?.[0]
      if (file) handleFile(file)
    },
    [handleFile],
  )

  /**
   * 处理中点"取消":把服务端任务和历史条目一起删掉。
   * 用户主动放弃的任务没有留下来的理由,留着只会占着他的并发额度。
   */
  const cancelJob = useCallback(() => {
    if (job) {
      void deleteJob(job.id)
      removeHistoryEntry(job.id)
    }
    reset()
  }, [job, reset])

  /**
   * 完成后点"再做一个":只重置界面,**不删**服务端任务。
   * 成片还要留在历史记录里供下载——这里顺手删掉的话,用户点"再做一个"
   * 就等于把刚做好的东西丢了,而他完全想不到会这样。
   */
  const startOver = useCallback(() => {
    reset()
  }, [reset])

  /**
   * 切换处理前/后。
   *
   * 两个 <video> 一直都在,只是叠着切透明度——换 src 会触发重新加载,
   * 对照时闪一下黑屏,那正好毁掉"对照"这件事本身。切过去之前把播放进度
   * 同步过来,看到的才是同一帧。
   *
   * 切完是暂停的,这是故意的:比对字幕去得干不干净要盯着同一个静帧看,
   * 画面继续动反而看不清。
   */
  const toggleCompare = useCallback(() => {
    const from = showBefore ? beforeRef.current : afterRef.current
    const to = showBefore ? afterRef.current : beforeRef.current
    if (from && to && Number.isFinite(from.currentTime)) {
      to.currentTime = from.currentTime
    }
    from?.pause()
    setShowBefore((value) => !value)
  }, [showBefore])

  const limits = service
    ? `${formatBytes(service.maxUploadBytes)} max · up to ${formatDuration(service.maxDurationSeconds)}`
    : ''

  // ── 框选 ────────────────────────────────────────────────────────────

  /**
   * 量出画面在画布里实际占的那块矩形。
   *
   * 视频是 object-fit: contain 放进 16:9 画布的，竖片两边、方片四周都会留黑边。
   * 框必须画在**画面**上而不是画布上——黑边里的坐标换算成比例会超过 1，
   * 腾讯那边直接拒收；更要命的是不超过 1 的那些也是错的，整组框会整体偏移。
   */
  const measure = useCallback(() => {
    const stage = stageRef.current
    const video = pickRef.current
    if (!stage || !video || !video.videoWidth || !video.videoHeight) return
    const box = stage.getBoundingClientRect()
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight)
    const width = video.videoWidth * scale
    const height = video.videoHeight * scale
    setFrame({ left: (box.width - width) / 2, top: (box.height - height) / 2, width, height })
  }, [])

  // 画布宽度跟着视口和侧栏开合变，量过一次就不管的话，框会和画面错位。
  // 用 layout effect：量完立刻画，别让用户看见一帧错位的框。
  useLayoutEffect(() => {
    if (phase !== 'selecting') return
    measure()
    const stage = stageRef.current
    if (!stage || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [phase, measure])

  /** 处理中不让切模式：切了也改不了已经提交出去的任务，只会让界面对不上。 */
  useEffect(() => {
    onBusyChange?.(phase === 'uploading' || phase === 'processing')
  }, [phase, onBusyChange])

  /*
   * 画框画到一半改了主意，切回自动模式。
   *
   * 退回选文件那一步，而不是拿着已经选好的文件直接开跑：点一下模式按钮
   * 就把一段视频提交出去（还要计一次费）不是任何人点它时的预期。
   * 画好的框也跟着作废——它们在自动模式下没有意义，留着只会让人
   * 以为还在生效。
   */
  useEffect(() => {
    if (mode === 'auto' && phase === 'selecting') reset()
  }, [mode, phase, reset])

  const pointFrom = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return {
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height),
    }
  }, [])

  const onDrawStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (areas.length >= MAX_AREAS) return
      // 只认主键（鼠标左键 / 手指 / 笔尖）。右键拖出来一个框之后菜单还会弹出来。
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const { x, y } = pointFrom(event)
      setDraft({ x0: x, y0: y, x1: x, y1: y })
    },
    [areas.length, pointFrom],
  )

  const onDrawMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draft) return
      const { x, y } = pointFrom(event)
      setDraft((current) => (current ? { ...current, x1: x, y1: y } : current))
    },
    [draft, pointFrom],
  )

  const onDrawEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draft) return
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      const area = toArea(draft)
      setDraft(null)
      // 点一下而不是拖一下也会走到这里，那不是一个框。
      if (!area) return
      setAreas((current) => (current.length >= MAX_AREAS ? current : [...current, area]))
    },
    [draft],
  )

  const removeArea = useCallback((index: number) => {
    setAreas((current) => current.filter((_, i) => i !== index))
  }, [])

  const scrubTo = useCallback((seconds: number) => {
    const video = pickRef.current
    if (!video) return
    video.currentTime = seconds
    setTime(seconds)
  }, [])

  const submitBoxes = useCallback(() => {
    if (!pending || areas.length === 0) return
    void startUpload(pending, areas)
  }, [pending, areas, startUpload])

  return (
    <section className="workspace" id="tool" aria-label="Remove subtitles from a video">
      {service && !service.ready && (
        <p className="workspace__banner">
          <AlertIcon className="icon" />
          The processing service is temporarily unavailable. Please check back shortly.
        </p>
      )}

      {phase === 'idle' && (
        <div
          className={`stage stage--drop${dragging ? ' stage--dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <UploadIcon className="stage__icon" />
          <p className="stage__title">Drop your video here</p>
          <p className="stage__sub">{mode === 'box' ? 'you will draw the boxes next' : 'or'}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => inputRef.current?.click()}
            disabled={service ? !service.ready : false}
          >
            Choose a video
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={service?.accept ?? 'video/*'}
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) handleFile(file)
            }}
          />
        </div>
      )}

      {/*
        框选：画面定格在某一帧，用户在上面拖出要擦的矩形。
        不自动播放——要对着字幕画框，画面还在动的话根本画不准。
      */}
      {phase === 'selecting' && sourceUrl && (
        <div className="stage stage--select" ref={stageRef}>
          <video
            ref={pickRef}
            className="stage__video"
            src={sourceUrl}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              setDuration(event.currentTarget.duration || 0)
              measure()
            }}
            onSeeked={(event) => setTime(event.currentTarget.currentTime)}
          />

          {frame && (
            <div
              className="boxes"
              style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
              onPointerDown={onDrawStart}
              onPointerMove={onDrawMove}
              onPointerUp={onDrawEnd}
              onPointerCancel={onDrawEnd}
              role="application"
              aria-label="Drag to draw a box over the text you want erased"
            >
              {areas.map((area, index) => (
                <div key={index} className="box" style={boxStyle(area)}>
                  <button
                    type="button"
                    className="box__remove"
                    aria-label={`Remove box ${index + 1}`}
                    // 不拦住的话，点"删掉"会同时在底下的层上开始画一个新框。
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => removeArea(index)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {draft && <div className="box box--draft" style={boxStyle(rectOf(draft))} />}
            </div>
          )}

          {areas.length === 0 && !draft && (
            <p className="stage__hint stage__hint--float">Drag a box over the text you want gone</p>
          )}
        </div>
      )}

      {phase === 'uploading' && (
        <div className="stage stage--busy">
          {/* 上传时就把片子放出来:用户立刻能确认自己选对了文件,
              而不是盯着一个只有百分比的进度条猜。 */}
          {sourceUrl && <video className="stage__video" src={sourceUrl} muted autoPlay loop playsInline />}
          <div className="stage__overlay">
            <p className="stage__status">Uploading… {Math.round(uploadFraction * 100)}%</p>
            <Progress fraction={uploadFraction} />
          </div>
        </div>
      )}

      {phase === 'processing' && job && (
        <div className="stage stage--busy">
          {sourceUrl && <video className="stage__video" src={sourceUrl} muted autoPlay loop playsInline />}
          <div className="stage__overlay">
            <p className="stage__status">{statusLabel(job.status)}</p>
            <Progress fraction={progressFor(job)} />
            <p className="stage__hint">You can close this tab — it will still be here when you come back.</p>
          </div>
        </div>
      )}

      {phase === 'done' && job?.resultUrl && (
        <div className="stage stage--result">
          {/* 两个视频叠着,切换只改透明度,不重新加载。 */}
          {sourceUrl && (
            <video
              ref={beforeRef}
              className={`stage__video${showBefore ? '' : ' is-hidden'}`}
              src={sourceUrl}
              controls={showBefore}
              playsInline
              preload="metadata"
            />
          )}
          <video
            ref={afterRef}
            className={`stage__video${showBefore ? ' is-hidden' : ''}`}
            src={job.resultUrl}
            controls={!showBefore}
            playsInline
            preload="metadata"
          />
          {sourceUrl && (
            <button
              type="button"
              className="compare"
              onClick={toggleCompare}
              aria-pressed={showBefore}
              // 读屏软件读到的只会是两个孤零零的词 "Before After",
              // 不说明这是个开关、也不说明现在停在哪一边。
              aria-label={showBefore ? 'Showing the original. Switch to the processed video.' : 'Showing the processed video. Switch to the original.'}
            >
              <span className={showBefore ? 'is-active' : ''} aria-hidden="true">
                Before
              </span>
              <span className={showBefore ? '' : 'is-active'} aria-hidden="true">
                After
              </span>
            </button>
          )}
        </div>
      )}

      {phase === 'error' && (
        <div className="stage stage--error">
          <AlertIcon className="stage__icon" />
          <p className="stage__title">That did not work</p>
          <p className="stage__sub">{message ?? 'Something went wrong.'}</p>
          <button type="button" className="btn btn--primary" onClick={startOver}>
            Try again
          </button>
        </div>
      )}

      {/*
        时间轴。字幕不一定出现在第一帧，没有这条的话用户只能对着一个
        恰好没有字的画面瞎画。拖动它只是换一帧看，不影响画好的框——
        框擦的是整段片子，不是某一帧。
      */}
      {phase === 'selecting' && duration > 0 && (
        <div className="scrub">
          <input
            type="range"
            className="scrub__range"
            min={0}
            max={duration}
            step={0.05}
            value={Math.min(time, duration)}
            onChange={(event) => scrubTo(Number(event.target.value))}
            aria-label="Move through the video to find the text"
          />
          <span className="scrub__time">
            {formatClock(time)} / {formatClock(duration)}
          </span>
        </div>
      )}

      {/* 画布下面这条操作栏：画布里只放视频，按钮和说明一律在外面，
          这样它们不会压在画面上，也不会随状态在画布里跳来跳去。 */}
      <div className="toolbar">
        <p className="toolbar__meta">
          {phase === 'idle' && limits}
          {phase === 'selecting' &&
            (areas.length === 0
              ? 'Drag a box over the text you want gone.'
              : `${areas.length} box${areas.length > 1 ? 'es' : ''}${areas.length >= MAX_AREAS ? ' (the maximum)' : ''} · erased for the whole clip`)}
          {phase === 'uploading' && 'Uploading — you can cancel any time.'}
          {phase === 'processing' && job && `${job.filename}${job.durationSeconds ? ` · ${formatDuration(job.durationSeconds)}` : ''}`}
          {phase === 'done' && job && (
            <>
              <CheckIcon className="icon icon--success" /> Subtitles removed
              {job.resultBytes ? ` · ${formatBytes(job.resultBytes)}` : ''}
            </>
          )}
        </p>

        <div className="toolbar__actions">
          {phase === 'selecting' && (
            <>
              <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>
                Cancel
              </button>
              {areas.length > 0 && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAreas([])}>
                  Clear boxes
                </button>
              )}
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={submitBoxes}
                disabled={areas.length === 0}
              >
                Erase {areas.length > 0 ? `${areas.length} area${areas.length > 1 ? 's' : ''}` : 'selection'}
              </button>
            </>
          )}
          {(phase === 'uploading' || phase === 'processing') && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={cancelJob}>
              Cancel
            </button>
          )}
          {phase === 'done' && job && (
            <>
              <button type="button" className="btn btn--ghost btn--sm" onClick={startOver}>
                Do another
              </button>
              <a className="btn btn--primary btn--sm" href={job.downloadUrl ?? job.resultUrl ?? '#'} download>
                <DownloadIcon className="icon" /> Download MP4
              </a>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function Progress({ fraction }: { fraction: number }) {
  const percent = Math.max(2, Math.min(100, Math.round(fraction * 100)))
  return (
    <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__bar" style={{ width: `${percent}%` }} />
    </div>
  )
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 把一次拖拽整理成一个矩形（左上/右下归位）。
 *
 * 右下角收到 0.999：腾讯那边要求 percent 坐标落在 [0,1) 的开区间里，
 * 贴着右边缘或底边画的框——而字幕恰恰最常贴着底边——会正好踩在 1 上。
 */
function rectOf(draft: Draft): Area {
  return [
    clamp01(Math.min(draft.x0, draft.x1)),
    clamp01(Math.min(draft.y0, draft.y1)),
    Math.min(0.999, Math.max(draft.x0, draft.x1)),
    Math.min(0.999, Math.max(draft.y0, draft.y1)),
  ]
}

/** 松手时才判大小：点一下而不是拖一下不该留下一个擦不出东西的框。 */
function toArea(draft: Draft): Area | null {
  const area = rectOf(draft)
  if (area[2] - area[0] < MIN_SIDE || area[3] - area[1] < MIN_SIDE) return null
  return area
}

function boxStyle([left, top, right, bottom]: Area): React.CSSProperties {
  return {
    left: `${left * 100}%`,
    top: `${top * 100}%`,
    width: `${(right - left) * 100}%`,
    height: `${(bottom - top) * 100}%`,
  }
}

/** 时间轴上的 0:04.2。秒以下留一位：找某一帧字幕时差半秒就差很远。 */
function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}
