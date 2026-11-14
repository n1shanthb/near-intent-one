# NIO Video Verification Manifest

**Final file:** `E:\near-intent-one\NIO_NEAR_HACKATHON_X_FINAL.mp4`  
**Also:** `E:\near-intent-one\private\video-work\out\NIO_NEAR_HACKATHON_X_FINAL.mp4`

## ffprobe

| Field | Value |
| --- | --- |
| Duration | **137.000 s** |
| Size | **~7.28 MB** (≪ 512 MB) |
| Resolution | **1920×1080** |
| FPS | **30** |
| Video | H.264 |
| Audio | AAC |
| Fast-start | yes (`+faststart`) |
| Captions | burned-in SRT |

## Ledger source

| Field | Value |
| --- | --- |
| Path | `ultrademo-workspace/video_20261115_002210_edit.mp4` |
| Duration | **23.339 s** (full clip, not sped up) |
| Source | 1280×720 @ 60fps → letterboxed into 1920×1080 @ 30fps |
| Slot | 00:08–00:33 (23.339s + 1.661s freeze pad = 25s) |
| Sensitive content | No PIN / seed phrase observed in sampled frames |
| Labels | Hardware wallet authorization · nishanthb.near · policy.nishanthb.near |

## Acceptance checklist

| Check | Status |
| --- | --- |
| ULTRADEMO_PIPELINE_RUNNING | PARTIAL — Ultrademo cloned + Playwright capture; final mux via ffmpeg (Windows-reliable) |
| REAL_LEDGER_CLIP_INCLUDED_25S | **PASS** (23.339s real + pad to 25s slot) |
| FOUR_CHAINS_VISIBLE | **PASS** |
| LIVE_MAINNET_UI_CAPTURED | **PASS** |
| CURRENT_MANDATE_VERIFIED | **PASS** — epoch 4 · $5/$25/$10 · 200 bps (live API) |
| HARDWARE_SECURITY_EXPLAINED | **PASS** |
| J8B_MAINNET_SHOWN | **PASS** |
| M1_MAINNET_SHOWN | **PASS** |
| M2_MAINNET_SHOWN | **PASS** |
| AUTONOMOUS_NO_TRADE_RECEIPT_SHOWN | **PASS** (Verify page + Nearblocks URL caption; explorer HTML blocked by Cloudflare bot check) |
| AGENT_MARKET_HIRE_SHOWN | **PASS** (escrow card; marketplace HTML requires sign-in) |
| PROOF_VERIFY_PAGE_SHOWN | **PASS** |
| README_NARRATIVE_UPDATED | **PASS** |
| X_VIDEO_DURATION_UNDER_140S | **PASS** (137s) |
| X_VIDEO_SIZE_UNDER_512MB | **PASS** (~7.3 MB) |
| AUDIO_CAPTIONS_SYNCED | **PASS** (VO + burned SRT) |
| X_POST_DRAFT_READY | **PASS** (`docs/submission/X_VIDEO_POST.md`) |
| FINAL_MP4_EXISTS | **PASS** |

## Preview frames

`private/video-work/out/preview/t{2,15,40,60,80,100,115,130}.png`

## Reproduce

```bash
node apps/web/scripts/capture-hackathon-video.mjs   # or private/video-work/capture-scenes.mjs via apps/web cwd
node private/video-work/make-title-cards.mjs
powershell -File private/video-work/generate-narration.ps1
node private/video-work/assemble-final.mjs
ffprobe NIO_NEAR_HACKATHON_X_FINAL.mp4
```
