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
const LOGO    = process.env.WATERMARK_LOGO_PATH ?? '/opt/assets/rodz-logo.png'

// Bottom-right position with a comfortable margin so the logo doesn't
// touch the frame edge (some players / social re-hosts crop the outer
// pixels). Overlay is scaled to WATERMARK_WIDTH_RATIO of the video width,
// preserving aspect ratio.
const WATERMARK_WIDTH_RATIO = 0.10   // 10% of frame width
const WATERMARK_OPACITY     = 0.35   // 35% — visible on re-shares, not obnoxious
const WATERMARK_MARGIN_PX   = 48

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

// Re-encode the input with the Rodz logo overlaid bottom-right, scaled
// to WATERMARK_WIDTH_RATIO of the video width and blended at
// WATERMARK_OPACITY. Audio track is stream-copied (no re-encode).
async function applyWatermark(
  inputPath: string,
  outputPath: string,
  videoWidth: number,
): Promise<void> {
  // Compute overlay width in pixels from the video's width. -1 in the
  // second slot keeps aspect ratio. Falls back to 200px if we don't
  // have a probed width (portrait/rotated videos sometimes report 0).
  const overlayWidth = Math.max(48, Math.floor(videoWidth * WATERMARK_WIDTH_RATIO)) || 200

  // Filter graph:
  //   [1:v] logo → scale to target width → set alpha to WATERMARK_OPACITY
  //   [0:v][wm] main video ← overlay at bottom-right with margin
  const filter =
    `[1:v]scale=${overlayWidth}:-1,` +
    `format=rgba,colorchannelmixer=aa=${WATERMARK_OPACITY}[wm];` +
    `[0:v][wm]overlay=W-w-${WATERMARK_MARGIN_PX}:H-h-${WATERMARK_MARGIN_PX}`

  await runCommand(FFMPEG, [
    '-y',
    '-i', inputPath,
    '-i', LOGO,
    '-filter_complex', filter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',    // Lambda CPU is limited; veryfast is a good size/speed tradeoff
    '-crf', '23',             // Visually indistinguishable from original at typical viewing distances
    '-pix_fmt', 'yuv420p',    // Broadest player compatibility
    '-movflags', '+faststart',// moov atom at the start so browser seek works while streaming
    '-c:a', 'copy',           // Keep the audio track byte-identical
    outputPath,
  ])
}

export const handler = async (event: PostProcessEvent): Promise<{ ok: boolean; reason?: string }> => {
  await ready
  const db = getPool()
  const { videoId } = event
  if (!videoId) throw new Error('videoId is required')

  const [[row]] = await db.query<any[]>(
    `SELECT id, r2_key, content_type, process_status
     FROM video_assets WHERE id = ? LIMIT 1`,
    [videoId],
  )
  if (!row) {
    console.warn(`[post-process] video ${videoId} not found`)
    return { ok: false, reason: 'not_found' }
  }
  if (row.process_status === 'ready') {
    return { ok: true, reason: 'already_ready' }
  }

  const workDir       = `/tmp/video-${videoId}`
  const inputPath     = path.join(workDir, 'input')
  const thumbnailPath = path.join(workDir, 'thumb.jpg')
  const watermarkedPath = path.join(workDir, 'watermarked.mp4')

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

    // 5. Watermark — bake the Rodz logo into the video and replace the
    // original R2 object. This is the slowest step (full re-encode) but
    // means the branding survives when the file is downloaded or
    // re-shared on Facebook / forums / etc.
    await applyWatermark(inputPath, watermarkedPath, Number(probe.width ?? 0))
    const watermarkedBytes = await fs.readFile(watermarkedPath)
    await putObjectBytes(String(row.r2_key), watermarkedBytes, String(row.content_type))

    // 6. Re-probe the watermarked output — dimensions may shift slightly
    // due to yuv420p even-dim requirements, and size_bytes definitely
    // changed. Keep the DB in sync so playback URLs report the truth.
    const outProbe = await probeVideo(watermarkedPath)

    // 7. Update row
    await db.query(
      `UPDATE video_assets SET
         duration_seconds = COALESCE(?, duration_seconds),
         width            = COALESCE(?, width),
         height           = COALESCE(?, height),
         size_bytes       = ?,
         thumbnail_r2_key = ?,
         process_status   = 'ready',
         process_error    = NULL
       WHERE id = ?`,
      [
        outProbe.durationSec ?? probe.durationSec,
        outProbe.width       ?? probe.width,
        outProbe.height      ?? probe.height,
        watermarkedBytes.length,
        thumbnailKey,
        videoId,
      ],
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
