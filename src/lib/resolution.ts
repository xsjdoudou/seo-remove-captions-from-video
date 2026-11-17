import type { EraseMode, OutputResolution } from './api'

export type VideoInfo = { width: number; height: number; duration: number }

export function resolutionOptions(video: VideoInfo): OutputResolution[] {
  const shortEdge = Math.min(video.width, video.height)
  return (['1440', '1080', '720'] as const).filter((value) => Number(value) < shortEdge)
}

export function resolutionRate(video: VideoInfo, output: OutputResolution): number {
  const shortEdge = Math.min(video.width, video.height, output === 'original' ? Infinity : Number(output))
  return shortEdge <= 720 ? 1 : shortEdge <= 1080 ? 2 : 3
}

export function estimateCredits(video: VideoInfo, mode: EraseMode, output: OutputResolution): number {
  return Math.ceil(video.duration) * (mode === 'box' ? 3 : 1) * resolutionRate(video, output)
}
