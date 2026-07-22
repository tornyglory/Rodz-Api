# ffmpeg Lambda layer

Static ffmpeg + ffprobe binaries used by `src/quotes/videos/post-process.ts`
(thumbnail extraction + duration/dimension verification).

The binaries themselves are **gitignored** — they're 76 MB each and don't
change often. Run the fetch script once locally before `cdk deploy`:

```bash
./scripts/fetch-ffmpeg-layer.sh
# or via npm
npm run fetch:ffmpeg
```

The script pulls Linux x86_64 static builds from
[John Van Sickle's public releases](https://johnvansickle.com/ffmpeg/) and
places them at:

- `layers/ffmpeg/bin/ffmpeg`
- `layers/ffmpeg/bin/ffprobe`

CDK's `LayerVersion` construct bundles this directory at synth time and
publishes it as a Lambda layer attached to the post-process function. The
binaries end up at `/opt/bin/{ffmpeg,ffprobe}` inside the Lambda runtime,
matching the `FFMPEG_PATH` / `FFPROBE_PATH` defaults in `post-process.ts`.

## Why not commit the binaries?

- GitHub warns at >50 MB per file. 76 MB × 2 files would trigger warnings
  on every push.
- Binaries don't project-belong — they're the community ffmpeg build.
  Regeneratable in ~30 seconds via the fetch script.
- Keeps clone size small (< 1 MB vs > 150 MB).

## Updating ffmpeg

Delete the two binaries and rerun the fetch script — the URL points at the
"latest release" build, so you'll get whatever's current.
