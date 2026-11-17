import type { EraseMode, OutputResolution } from './api'

export type VideoInfo = { width: number; height: number; duration: number }

export function resolutionRate(video: VideoInfo, output: OutputResolution): number {
  const shortEdge = Math.min(video.width, video.height)
  return output === '720' || shortEdge <= 720 ? 1 : shortEdge <= 1080 ? 2 : 3
}

export function estimateCredits(video: VideoInfo, mode: EraseMode, output: OutputResolution): number {
  return Math.ceil(video.duration) * (mode === 'box' ? 3 : 1) * resolutionRate(video, output)
}
