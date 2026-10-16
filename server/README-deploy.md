# Deploying on a 1 GB EC2 instance

The server is a **fallback**: most jobs run in the visitor's browser. It only handles what browsers can't
(Office documents, PDF compression, large or exotic media).

## One-time box setup (Ubuntu 22.04/24.04)

```bash
# 2 GB swapfile: LibreOffice/FFmpeg spikes will OOM a 1 GB box without it
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo apt-get update && sudo apt-get install -y --no-install-recommends \
  ffmpeg ghostscript qpdf util-linux libheif-examples \
  libreoffice-writer libreoffice-calc libreoffice-impress \
  python3 python3-fonttools python3-brotli fonts-dejavu fonts-liberation

# Node 22 + pm2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm i -g pm2
```

Then clone to `/home/ubuntu/media-compressor`, run `npm ci && npm --prefix engine ci && npm --prefix web ci && npm run build`
and `pm2 start "npm start" --name media-compressor && pm2 save && pm2 startup`.

The GitHub Action (`.github/workflows/deploy.yml`) runs the tests on every PR and push, and deploys on push to `main`
(needs secrets `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`). Building the Astro site on the box needs the swapfile; if it
still runs out of memory, build in CI and copy `web/dist` and `server/dist` instead.

## Memory budget

| Setting | Default | Why |
|---|---|---|
| `node --max-old-space-size=384` | in `npm start` | leave RAM for child processes |
| `HEAVY_CONCURRENCY` | 1 | video / LibreOffice / Ghostscript one at a time |
| `LIGHT_CONCURRENCY` | 2 | images, audio, qpdf |
| `MAX_QUEUE` | 20 | beyond this, uploads get HTTP 429 |
| `MAX_FILE_MB` | 500 | per file |
| `OUTPUT_TTL_MS` | 1800000 | outputs are deleted 30 min after completion |

AV1 on the server is capped at 720p and watched by an RSS limit (SVT-AV1 needs ~800 MB at 1080p).

## Environment

`PORT`, `HOST`, `TRUST_PROXY` (set to `1` behind nginx/ALB so the per-IP rate limit sees real addresses),
`JOBS_DIR`, `DATA_DIR`, `WEB_DIST`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `S3_BUCKET_NAME` (optional, off by default).
