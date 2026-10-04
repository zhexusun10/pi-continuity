"""Render mechanism storyboards. Does not start Pi, run tests, or call a model."""
from functools import lru_cache
from pathlib import Path
import os
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFont
from imageio_ffmpeg import get_ffmpeg_exe

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
W, H = 1280, 780
BG, PANEL, BORDER = "#0b0e12", "#151a21", "#303944"
WHITE, MUTED, ACCENT, WARN = "#edf2f7", "#a2adba", "#85d6be", "#e7aa9e"


def font_path(env, candidates):
    override = os.environ.get(env)
    if override:
        return override
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    raise RuntimeError(f"No font found; set {env} to a TrueType font path.")


FONTS = {
    "sans": font_path("ASSET_SANS_FONT", [
        "C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]),
    "bold": font_path("ASSET_BOLD_FONT", [
        "C:/Windows/Fonts/segoeuib.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ]),
    "mono": font_path("ASSET_MONO_FONT", [
        "C:/Windows/Fonts/consola.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
    ]),
}


@lru_cache(maxsize=32)
def font(size, kind="sans"):
    return ImageFont.truetype(FONTS[kind], size)


def text(draw, position, value, size=22, color=WHITE, kind="sans"):
    draw.text(position, value, font=font(size, kind), fill=color)


def panel(draw, box):
    draw.rounded_rectangle(box, radius=16, fill=PANEL, outline=BORDER, width=1)


def header():
    image = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(image)
    text(draw, (54, 27), "pi-continuity", 58, kind="bold")
    text(draw, (56, 111), "More robust loop engineering.", 32, ACCENT)
    draw.rounded_rectangle((935, 48, 1224, 86), radius=10, fill=PANEL, outline=BORDER)
    text(draw, (952, 56), "PI EXTENSION / SCHEMATIC", 17, MUTED, "mono")
    return image, draw


def node(draw, x, y, number, title, subtitle, color=WHITE):
    draw.ellipse((x, y + 6, x + 24, y + 30), fill=BG, outline=BORDER, width=1)
    draw.text((x + 12, y + 18), str(number), font=font(14, "bold"), fill=color, anchor="mm")
    text(draw, (x + 42, y), title, 24, color, "bold")
    text(draw, (x + 42, y + 37), subtitle, 20, MUTED)


def connector(draw, x, y1, y2, color=BORDER):
    draw.line((x, y1, x, y2 - 6), fill=color, width=2)
    draw.polygon([(x - 4, y2 - 8), (x + 4, y2 - 8), (x, y2)], fill=color)


def hero():
    image, draw = header()
    text(draw, (56, 170), "A response boundary is not always a task boundary.", 24)
    panel(draw, (56, 218, 604, 588))
    panel(draw, (632, 218, 1224, 588))
    text(draw, (82, 242), "PI AT ITS DESIRED OUTPUT CAP", 17, MUTED, "mono")
    text(draw, (658, 242), "WITH PI-CONTINUITY", 17, ACCENT, "mono")
    node(draw, 82, 281, 1, "Output cap ends the turn", "Partial reasoning; no tool call")
    connector(draw, 94, 340, 369)
    node(draw, 82, 375, 2, "No natural next request", "No queued input or continuation")
    connector(draw, 94, 434, 463)
    node(draw, 82, 469, 3, "The task may settle early", "Final stop reason stays length", WARN)
    node(draw, 658, 281, 1, "Keep readable progress", "Omit broken protocol replay")
    connector(draw, 670, 340, 369, ACCENT)
    node(draw, 658, 375, 2, "Resume within policy", "Continue + runnable context", ACCENT)
    connector(draw, 670, 434, 463, ACCENT)
    node(draw, 658, 469, 3, "Re-evaluate completion", "Final text, or an explicit blocker")
    text(draw, (82, 550), "INTERRUPTED TURN != FINISHED TASK", 16, WARN, "mono")
    text(draw, (658, 550), "CANCELLATION + APPROVALS + BUDGETS", 16, ACCENT, "mono")
    cards = [
        (56, 432, "Output truncation", "Keep readable partial context", "Never run partial tool arguments"),
        (456, 828, "Broken stream", "Native recovery gets first refusal", "Bounded fallback with backoff"),
        (852, 1224, "Tool-call ending", "Results come before Continue", "Do not rerun completed tools"),
    ]
    for left, right, title, line1, line2 in cards:
        panel(draw, (left, 618, right, 740))
        text(draw, (left + 23, 634), title, 23, kind="bold")
        text(draw, (left + 23, 677), line1, 18, MUTED)
        text(draw, (left + 23, 707), line2, 18, MUTED)
    return image


# Hand-authored design paths, not captured execution logs or new experiments.
SCENARIOS = [
    {
        "title": "1 / 3  Output truncation",
        "setup": "At the desired output cap, with no pending user input.",
        "baseline": [
            "Model emits partial reasoning",
            "stopReason = length",
            "No tool call or queued input",
            "The task can end here",
        ],
        "recovery": [
            "Detect the interrupted turn",
            "Keep readable partial context",
            "Omit broken replay metadata",
            "Append Continue within budget",
            "Make the next provider request",
            "Settle on final text or a blocker",
        ],
        "guard": "Partial arguments never execute.",
    },
    {
        "title": "2 / 3  Broken stream",
        "setup": "Native retries run first; fallback is a separate policy decision.",
        "baseline": [
            "The provider stream fails",
            "Pi performs native retries",
            "Native recovery is exhausted",
            "The task can end on the error",
        ],
        "recovery": [
            "Save a readable checkpoint",
            "Let native recovery run first",
            "If still failing at settlement:",
            "Bounded backoff + Continue",
            "Request the remaining work",
            "Respect completion / blockers / caps",
        ],
        "guard": "No fallback race with native retries.",
    },
    {
        "title": "3 / 3  Tool-call ending",
        "setup": "An intentionally terminating tool returns without final text.",
        "baseline": [
            "The model emits a tool call",
            "The tool returns its result",
            "The tool terminates the loop",
            "No final text response",
        ],
        "recovery": [
            "Keep the completed tool result",
            "Inspect the pre-settle boundary",
            "Append Continue if needed",
            "Do not rerun the completed tool",
            "Ask for final text / remaining work",
            "Honor terminal-tool opt-out",
        ],
        "guard": "Ordinary tool turns already continue.",
    },
]


def demo_frame(case, visible):
    image, draw = header()
    text(draw, (56, 170), case["title"], 24, kind="bold")
    panel(draw, (56, 218, 604, 674))
    panel(draw, (632, 218, 1224, 674))
    text(draw, (82, 242), "POSSIBLE EARLY-STOP PATH", 17, MUTED, "mono")
    text(draw, (658, 242), "RECOVERY POLICY", 17, ACCENT, "mono")
    for index, line in enumerate(case["baseline"]):
        color = WARN if index == len(case["baseline"]) - 1 else WHITE
        text(draw, (82, 294 + index * 57), f"{index + 1}. {line}", 22, color)
    for index, line in enumerate(case["recovery"][:visible]):
        color = ACCENT if index == visible - 1 else WHITE
        text(draw, (658, 294 + index * 50), f"{index + 1}. {line}", 22, color)
    text(draw, (82, 626), "TURN END IS NOT TASK COMPLETION", 16, WARN, "mono")
    text(draw, (658, 626), f"POLICY STAGES  {visible} / 6", 16, ACCENT, "mono")
    text(draw, (56, 696), case["setup"], 20, MUTED)
    text(draw, (56, 730), case["guard"], 20, ACCENT)
    return image


def main():
    # imageio-ffmpeg supplies a local binary; this call does not download one.
    ffmpeg = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or get_ffmpeg_exe()
    ASSETS.mkdir(exist_ok=True)
    hero().save(ASSETS / "loop-engineering.png", optimize=True)
    frames, durations = [], []
    for case in SCENARIOS:
        for visible, duration in [(2, 1800), (4, 2500), (6, 3200)]:
            frames.append(demo_frame(case, visible))
            durations.append(duration)
    frames[0].save(
        ASSETS / "demo.gif", save_all=True, append_images=frames[1:],
        duration=durations, loop=0, optimize=True, disposal=2,
    )
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ignore_loop", "1",
        "-i", str(ASSETS / "demo.gif"), "-vf", "fps=12", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(ASSETS / "demo.mp4"),
    ], check=True)
    for name in ["loop-engineering.png", "demo.gif", "demo.mp4"]:
        print(f"Rendered assets/{name} ({(ASSETS / name).stat().st_size:,} bytes)")
    print("Mechanism illustrations only; no Pi runs, tests, or model calls.")


if __name__ == "__main__":
    main()
