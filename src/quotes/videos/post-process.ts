import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getObjectBytes, putObjectBytes } from '../../shared/r2'

const ready = bootstrap()

// Async invoked by POST /quotes/{id}/videos (fire-and-forget from create).
// Also usable as a retry target if we add /retry-post-process later.
//
// Job:
//   1. Fetch the video bytes from R2
//   2. Write to /tmp so ffmpeg can read it
//   3. Run ffprobe → duration_seconds, width, height, verify codec
//   4. Run ffmpeg → JPEG frame at t=1s (or midpoint if shorter)
//   5. Upload thumbnail to R2 at video-thumbnails/{videoId}.jpg
//   6. Update video_assets row: process_status='ready' + populated fields
//
// Skips the +faststart repackage for quote clips — they're short-form
// (≤30s, ≤25 MB), so the moov-atom-at-end delay is negligible. Long-form
// surfaces (vehicle-videos, mod-showcase) get faststart in later sprints.
//
// ffmpeg + ffprobe are provided via a Lambda layer (see CDK). Binaries
// live at /opt/bin/ffmpeg and /opt/bin/ffprobe per the layer convention.

const FFMPEG  = process.env.FFMPEG_PATH  ?? '/opt/bin/ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH ?? '/opt/bin/ffprobe'

export interface PostProcessEvent {
  videoId: number
}

interface ProbeResult {
  durationSec: number | null
  width:       number | null
  height:      number | null
  codec:       string | null
}

async function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} exited ${code}: ${stderr}`))
    })
  })
}

async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await runCommand(FFPROBE, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    filePath,
  ])
  const parsed = JSON.parse(stdout)
  const videoStream = (parsed.streams ?? []).find((s: any) => s.codec_type === 'video')
  return {
    durationSec: parsed.format?.duration ? Number(parsed.format.duration) : null,
    width:       videoStream?.width  ?? null,
    height:      videoStream?.height ?? null,
    codec:       videoStream?.codec_name ?? null,
  }
}

async function extractThumbnail(inputPath: string, outputPath: string, atSeconds: number): Promise<void> {
  // -ss BEFORE -i is fast seek (input-level), acceptable for our short
  // clips. -vframes 1 grabs one frame. -q:v 3 is JPEG quality (2 = best,
  // 31 = worst) — 3 gives a small file with decent quality.
  await runCommand(FFMPEG, [
    '-y',
    '-ss', String(atSeconds),
    '-i', inputPath,
    '-vframes', '1',
    '-q:v', '3',
    '-vf', 'scale=640:-2',   // Cap thumbnail width at 640, preserve aspect
    outputPath,
  ])
}

export const handler = async (event: PostProcessEvent): Promise<{ ok: boolean; reason?: string }> => {
  await ready
  const db = getPool()
  const { videoId } = event
  if (!videoId) throw new Error('videoId is required')

  const [[row]] = await db.query<any[]>(
    'SELECT id, r2_key, content_type, process_status FROM video_assets WHERE id = ? LIMIT 1',
    [videoId],
  )
  if (!row) {
    console.warn(`[post-process] video ${videoId} not found`)
    return { ok: false, reason: 'not_found' }
  }
  if (row.process_status === 'ready') {
    return { ok: true, reason: 'already_ready' }
  }

  const workDir      = `/tmp/video-${videoId}`
  const inputPath    = path.join(workDir, 'input')
  const thumbnailPath = path.join(workDir, 'thumb.jpg')

  try {
    // 1. Fetch video bytes and write to /tmp
    await fs.mkdir(workDir, { recursive: true })
    const videoBytes = await getObjectBytes(String(row.r2_key))
    await fs.writeFile(inputPath, videoBytes)

    // 2. Probe
    const probe = await probeVideo(inputPath)

    // 3. Thumbnail — grab frame at t=1s, or midpoint for very short clips
    const grabAt = probe.durationSec != null && probe.durationSec < 2
      ? Math.max(0, probe.durationSec / 2)
      : 1
    await extractThumbnail(inputPath, thumbnailPath, grabAt)

    // 4. Upload thumbnail to R2. Convention: video-thumbnails/{videoId}.jpg
    const thumbnailKey = `video-thumbnails/${videoId}.jpg`
    const thumbnailBytes = await fs.readFile(thumbnailPath)
    await putObjectBytes(thumbnailKey, thumbnailBytes, 'image/jpeg')

    // 5. Update row
    await db.query(
      `UPDATE video_assets SET
         duration_seconds = COALESCE(?, duration_seconds),
         width            = COALESCE(?, width),
         height           = COALESCE(?, height),
         thumbnail_r2_key = ?,
         process_status   = 'ready',
         process_error    = NULL
       WHERE id = ?`,
      [probe.durationSec, probe.width, probe.height, thumbnailKey, videoId],
    )

    return { ok: true }
  } catch (err: any) {
    const msg = err?.message ? String(err.message).slice(0, 500) : 'unknown post-process failure'
    console.error(`[post-process] video ${videoId} failed:`, err)
    await db.query(
      "UPDATE video_assets SET process_status = 'failed', process_error = ? WHERE id = ?",
      [msg, videoId],
    ).catch(() => {})
    return { ok: false, reason: 'post_process_failed' }
  } finally {
    // Clean up /tmp — Lambda's /tmp persists across warm invocations, so
    // leftover files can leak state or fill up (512 MB default cap).
    try {
      if (fsSync.existsSync(workDir)) {
        await fs.rm(workDir, { recursive: true, force: true })
      }
    } catch { /* ignore */ }
  }
}
