// 上传文件的识别与校验。
//
// 两件事：别让用户传了 20 分钟的片子排了半小时队才被腾讯云拒掉，
// 以及别把用户给的文件名直接当路径用。

import { execFile } from 'node:child_process'
import path from 'node:path'

// 腾讯云 MPS 接受的容器格式里，挑了浏览器也能直接 <video> 播放/常见的那些。
// 键是扩展名，值是回给浏览器的 Content-Type。
export const ALLOWED_EXTENSIONS = Object.freeze({
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
})

export const ACCEPT_ATTRIBUTE = Object.keys(ALLOWED_EXTENSIONS).join(',')

/**
 * 把用户给的文件名收敛成一个安全的展示名。
 *
 * 这个返回值只用来展示和拼下载时的 Content-Disposition，**不参与磁盘路径**
 * ——磁盘上的名字一律是随机 token。即便如此也要清洗：带换行的文件名能往
 * HTTP 响应头里注入内容。
 */
export function sanitizeFilename(raw) {
  const fallback = 'video.mp4'
  if (typeof raw !== 'string') return fallback
  // basename 去掉任何目录部分，连同 ../ 这类把戏。
  let name = path.basename(raw.replace(/\\/g, '/')).trim()
  // 控制字符、引号、路径分隔符全部换成下划线。
  name = name.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, '_')
  if (!name || name === '.' || name === '..') return fallback
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 10)
    name = name.slice(0, 120 - ext.length) + ext
  }
  return name
}

/** 取扩展名并校验。不认识的格式返回 null。 */
export function videoExtension(filename) {
  const ext = path.extname(filename).toLowerCase()
  return Object.hasOwn(ALLOWED_EXTENSIONS, ext) ? ext : null
}

export function contentTypeFor(ext) {
  return ALLOWED_EXTENSIONS[ext] ?? 'application/octet-stream'
}

/**
 * 用 ffprobe 读时长。
 *
 * 读不到就返回 null，由调用方决定要不要放行——服务器上没装 ffmpeg 的时候，
 * 不该因为量不出时长就拒绝所有上传。
 */
export function probeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        // 显式指明这是本地文件，顺手把 ffprobe 的协议白名单收窄，
        // 免得精心构造的文件把它引去访问网络地址。
        '-protocol_whitelist',
        'file',
        '-i',
        filePath,
      ],
      { timeout: 20_000, maxBuffer: 1024 * 64 },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const seconds = Number(String(stdout).trim())
        resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null)
      },
    )
  })
}
