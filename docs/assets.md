# Illustrations and provenance

The repository includes:

- `assets/loop-engineering.png`: the response-boundary vs task-boundary design, plus the three recovery triggers.
- `assets/demo.gif`: a nine-frame mechanism storyboard for output caps, native-first stream recovery, and tool-call endings.
- `assets/demo.mp4`: the same storyboard encoded as H.264 for gallery/video playback.

**These are illustrations, not recordings or execution results.** The storyboard is hand-authored from the documented extension policy and the [research motivation](evidence.md). It does not claim that a depicted model completed a real task. The paper's 100 resumptions / 48 nonzero rewards / 2 decisive matched pairs are cited in the README as paper observations, not plotted as extension results.

`render-assets.py` does not load the extension, start Pi, run tests, access a provider, or collect session content. It only draws the design paths and encodes images. All captions are synthetic explanatory text. The rendering tools are optional development dependencies; users installing the extension do not need Python or FFmpeg.

## Regenerate

Use Python 3.10+ and the pinned, development-only dependencies:

```bash
python -m venv .venv-assets
```

Activate the environment:

```bash
# Linux / macOS
source .venv-assets/bin/activate

# Windows PowerShell
.venv-assets\Scripts\Activate.ps1
```

Then:

```bash
python -m pip install --only-binary=:all: -r scripts/requirements-assets.txt
npm run assets
```

Pillow draws the PNG/GIF. `imageio-ffmpeg` includes a local FFmpeg executable for MP4 encoding; rendering does not download a binary. An existing FFmpeg can instead be selected through `FFMPEG` or the executable search path. Font discovery supports Windows, Linux, and macOS. Override `ASSET_SANS_FONT`, `ASSET_BOLD_FONT`, and `ASSET_MONO_FONT` with local font paths if needed. Output pixels can differ by platform fonts; this is not a measurement fixture.

The PNG is 1280 × 840. The animation advances through two, four, and six policy stages in each of three scenarios. Frames pause deliberately; they are not latency measurements. The MP4 has no audio.

README links and `pi.image` / `pi.video` refer to GitHub-hosted assets. They are not needed by the runtime extension. Keep the explicit illustration label when reusing these media, and do not describe them as live Pi recordings or benchmarks.
