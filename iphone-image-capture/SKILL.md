---
name: iphone-image-capture
description: Use when browsing, searching, curating, exporting, backing up, or deleting photos and videos on a USB-connected iPhone, iPad, or camera on macOS, or when the user mentions "图像捕捉", "Image Capture", "手机照片", "iPhone 相册导出/选图/清理", HEIC/Live Photo USB transfer, or camera roll management without importing into macOS Photos.app.
---

# Managing iPhone Photos on macOS (`iphone-image-capture`)

## Overview

macOS exposes USB-connected iPhones and cameras over PTP via **`ImageCaptureCore.framework`** (`ptpcamerad`), not `/Volumes` mounts and not AppleScript (`Image Capture.app` has no media-item AppleScript dictionary).

Use the bundled zero-dependency Swift CLI **`scripts/icphoto`** (relative to this skill directory) instead of writing ad-hoc `ICDeviceBrowser` boilerplate or importing gigabytes into `Photos.app`. It works concurrently while `Image Capture.app` is open or closed, compiles once to `/tmp/icphoto-bin-<hash>` via `xcrun swiftc -O`, and handles 10,000+ item libraries cleanly.

## When to Use

- User plugs an iPhone/iPad/camera into Mac via USB (with or without `图像捕捉` / `Image Capture.app` open) and wants to inspect, find, curate, export, organize, or delete photos/videos.
- Selecting meaningful real-life photos across months/years while filtering out tall phone screenshots (`ratio > 1.95` / PNG) and duplicate `IMG_E*` edits.
- Converting iPhone `.HEIC` / `.JPG` photos to web-friendly `.jpg` / `.png` with accurate EXIF portrait orientation, or backing up raw `.HEIC` + Live Photo `.MOV` sidecars.

**When NOT to use:** Managing local macOS `Photos.photolibrary` assets when no iPhone is plugged in over USB (query SQLite/PhotoKit instead).

## Quick Reference (`scripts/icphoto`)

Set `ICPHOTO="<this-skill-dir>/scripts/icphoto"` and run:

| Task | Command |
|---|---|
| Check connection, lock state, iCloud & monthly counts | `"$ICPHOTO" status` |
| Dump full metadata TSV (**0ms USB pixel transfer**) | `"$ICPHOTO" catalog --out "$SCRATCH/catalog.tsv"` |
| Fetch clustered real-camera thumbnails (~35–45 imgs/s) | `"$ICPHOTO" thumbs --out "$SCRATCH/thumbs" --kind camera --cluster-minutes 45 --max-edge 360` |
| Fetch targeted thumbnails (by key or `YYYY-MM/NAME`) | `"$ICPHOTO" thumbs --out "$SCRATCH/sub" --match "2025-04/IMG_2787.JPG,2023-09/IMG_3683.HEIC"` |
| Build `7×6` contact sheets for fast AI vision scanning | `"$ICPHOTO" sheets --thumbs "$SCRATCH/thumbs" --out "$SCRATCH/sheets"` |
| Build interactive HTML gallery for human browsing/picking | `"$ICPHOTO" gallery --dir "$SCRATCH/thumbs" --out "$SCRATCH/preview.html" --title "候选照片"` |
| Export auto-rotated Web JPGs (`max-edge 2200`) | `"$ICPHOTO" export --out ./picks --match-file picks.txt --format jpg --max-edge 2200 --quality 0.88` |
| Export lossless raw `.HEIC`/`.MOV` + Live Photo sidecars | `"$ICPHOTO" export --out ./raw --from 2026-11-01 --to 2026-11-30 --raw --sidecars` |
| Preview deletion safely (mandatory first step) | `"$ICPHOTO" delete --match "2026-11/IMG_6601.PNG" --dry-run` |
| Execute deletion **after explicit user approval** | `"$ICPHOTO" delete --match "2026-11/IMG_6601.PNG" --confirm-delete` |

Run `"$ICPHOTO" --help` for full usage. Most-used flags across commands:
- **Filtering:** `--from YYYY-MM-DD`, `--to YYYY-MM-DD`, `--kind all|camera|screenshot|edited|image|video`, `--cluster-minutes N`
- **Matching:** `--match "spec1,spec2"` or `--match-file list.txt` (accepts full `key`, `YYYY-MM/IMG_XXXX.EXT`, `104APPLE/IMG_XXXX.EXT`, or `<key>.jpg` thumbnail names)
- **Exporting:** `--format jpg|png`, `--max-edge 2200`, `--quality 0.88`, `--prefix-date` (auto-prefixes `YYYY-MM-DD_` on stem collisions), `--rename-map map.tsv` (`spec<TAB>output_stem`), or `--raw --sidecars`
- **Connection:** `--device <name-substr>`, `--timeout <sec>` (default `25`), `--tz <TimeZone>` (default system local)

## Core Playbooks

### 1. Curating from a Large Library (3,000–20,000+ Photos)

Never pull full originals or feed thousands of individual thumbnails into vision tools. Use the **Two-Pass Funnel**:

1. **Zero-I/O Catalog First:** Run `status` and `catalog --out "$SCRATCH/catalog.tsv"`. Once `deviceDidBecomeReady(withCompleteContentCatalog:)` fires, `ImageCaptureCore` already holds `name`, `creationDate`, `uti`, `width×height`, `fileSize`, and `sidecarFiles` in RAM at zero USB transfer cost.
2. **Pass 1 — Scene-Clustered Contact Sheets:**
   - Pull 1 representative thumbnail per 30–45 minute window:
     `"$ICPHOTO" thumbs --out "$SCRATCH/thumbs" --kind camera --cluster-minutes 45`
   - Stitch into `7×6` labeled contact sheets (42 scenes per image, zero Python/Pillow needed):
     `"$ICPHOTO" sheets --thumbs "$SCRATCH/thumbs" --out "$SCRATCH/sheets"`
   - Inspect the contact sheets with your vision tool to spot milestone scenes (trips, campus, whiteboards, awards, badges, family).
3. **Pass 2 — Drill into Neighbor Frames:**
   - Grep `catalog.tsv` around interesting timestamps (`YYYY-MM-DD_HH`) to find burst/scene neighbors (including screenshots or `IMG_E*` edits if relevant), fetch higher-res `800px` thumbs via `thumbs --max-edge 800 --match ...`, and verify exact details before exporting.
4. **Human-Friendly Presentation:**
   - Do **not** dump raw Markdown image lists or custom carousels that break in local viewers. Run `"$ICPHOTO" gallery --dir ... --out preview.html` and give the user a clickable link (or `open preview.html`). The HTML gallery has month filter pills, instant search, click-to-zoom lightbox, and checkboxes that copy selected item keys to the clipboard.

### 2. Exporting & Naming Without Collisions or Sideways Photos

- **Always scope `IMG_XXXX` with date or full key:** iPhone filenames (`IMG_0001`–`IMG_9999`) wrap around and collide across years or restored backups. Pass `YYYY-MM/IMG_XXXX.HEIC` or the full catalog `key` (`2025-04-19_09-12-03__104APPLE__IMG_2787.JPG`), never bare `IMG_2787.JPG` unless verified unique.
- **Batch semantic renaming:** Create a 2-column TSV (`spec<TAB>output_stem`) and pass `--rename-map map.tsv` to `export` so exported files land with clean semantic names (`01-2023-09-library-dome.jpg`) in a single USB session.
- **EXIF orientation & GPS stripping are handled automatically:** `icphoto export` (converted JPG/PNG mode) uses `CGImageSourceCreateThumbnailAtIndex` with `kCGImageSourceCreateThumbnailWithTransform: true` and encodes from `CGImage`, baking portrait orientation accurately while automatically stripping GPS/location EXIF for safe public sharing (`--raw` preserves original untouched EXIF/GPS). If writing custom image post-processing, never use raw `NSImage.draw` / `NSBitmapImageRep` without applying EXIF orientation, or portrait iPhone JPEGs will export rotated 90°.

### 3. Safe Deletion on iPhone

1. Resolve exact keys from `catalog.tsv` (bare ambiguous `IMG_XXXX` names are rejected by `icphoto delete`).
2. Run `"$ICPHOTO" delete --match ... --dry-run` AND generate a small thumbnail `gallery` if >3 photos are targeted so the user can visually verify what will be removed.
3. Check `ICLOUD_PHOTOS_ENABLED` in `status`: warn the user when iCloud Photos is active (deletions may propagate to iCloud or fail with `ICDeleteErrorReadOnly` on cloud-offloaded items).
4. Only run `--confirm-delete` after the user explicitly confirms the dry-run list.

### 4. Privacy & Cleanup Checklist

- **Before publishing curated photos** (blog, GitHub, social media), visually inspect exported high-res images for:
  - Confidential clauses on offer PDFs/screenshots;
  - Faint diagonal enterprise anti-leak watermarks (name + last 4 phone digits);
  - Personal WeChat/Feishu QR codes, internal cloud cost numbers, or internal org paths;
  - Unblurred colleague chats on background monitors or bystanders' faces.
- **Clean up scratch caches:** Delete temporary thumbnail/sheet directories (`rm -rf "$SCRATCH/thumbs" "$SCRATCH/sheets"`) once final picks are exported so thousands of cached thumbnails don't linger on disk.

## Common Mistakes & Red Flags

| Mistake / Temptation | Why It Fails | Do This Instead |
|---|---|---|
| Running `osascript` against `Image Capture.app` or checking `/Volumes` | `Image Capture.app` has no media AppleScript dictionary; iPhone uses PTP, not USB mass storage | Run `scripts/icphoto` (`ImageCaptureCore`) |
| Reading `device.mediaFiles` immediately in `didOpenSession` | Catalog streams asynchronously (`contentCatalogPercentCompleted` 0→100%); returns partial/empty list | Wait for `deviceDidBecomeReady(withCompleteContentCatalog:)` (built into `icphoto`) |
| iPhone shows 0 items or times out | Screen is locked or Mac isn't trusted (`isAccessRestrictedAppleDevice == true`) | Ask user to unlock iPhone & tap「信任」, rerun with `--timeout 40` |
| Running Vision OCR or heavy decoding inside PTP download callbacks | Serializes USB pipeline to ~4 imgs/s instead of ~40 imgs/s | Fetch thumbnails concurrently via `icphoto thumbs`, then run local Vision/OCR in parallel across CPU cores |
| Matching bare `IMG_2787.JPG` on multi-year camera rolls | Matches wrong year's photo or overwrites files | Match with `YYYY-MM/IMG_2787.JPG` or full `key` from `catalog.tsv` |
