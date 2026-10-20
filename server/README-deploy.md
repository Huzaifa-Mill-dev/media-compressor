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

# pdf-to-docx: pdf2docx (+ PyMuPDF, OpenCV headless; ~150 MB disk) in a venv that still sees the apt fontTools.
# ecosystem.config.cjs points PYTHON at it automatically when it exists.
sudo apt-get install -y python3-venv
sudo python3 -m venv --system-site-packages /opt/mt-python
sudo /opt/mt-python/bin/pip install pdf2docx==0.5.13 pymupdf==1.26.7   # same pins as server/scripts/requirements-pdf2docx.txt

# Node 24 LTS + pm2
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm i -g pm2
```

### LibreOffice network isolation (required)

Documents are attacker-controlled and can fetch URLs (e.g. Calc `WEBSERVICE()`, linked images), which would expose the
instance metadata service and internal ports. The server therefore runs LibreOffice under `unshare -rn` (no network) and
**withholds the document/spreadsheet tools if that does not work** (a warning is logged at startup). On Ubuntu 24.04:

```bash
echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee /etc/sysctl.d/60-userns.conf && sudo sysctl --system
unshare -rn true && echo isolation-ok
```

Also set the instance to IMDSv2-required with hop limit 1. Plain `docker run` usually cannot `unshare` (default seccomp);
run the container with a profile that allows user namespaces, or set `ALLOW_UNISOLATED_OFFICE=1` to accept the SSRF risk.

Then clone to `/home/ubuntu/media-compressor`, run `sudo npm i -g pm2 && pm2 startup` once, and let the first deploy do the rest.

The GitHub Action (`.github/workflows/deploy.yml`) runs the tests on every PR and push, and deploys on push to `main`
(needs secrets `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`). The site and server are **built in CI**: the box only receives
`web/dist` + `server/dist`, checks out the same commit, runs `npm ci --omit=dev` (the server's few runtime packages) and
restarts pm2 from `ecosystem.config.cjs`. The engine/web `node_modules` are not needed on the box.

## nginx in front of the app

The app listens on :3000 and expects a reverse proxy that terminates TLS. Required settings (defaults will break uploads):

```nginx
client_max_body_size 520m;            # default is 1 MB: every real upload would get HTTP 413
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;      # stream big uploads to the app instead of spooling them to disk
    proxy_buffering off;              # progress events (SSE) must not be held back
    proxy_read_timeout 3600s;         # long video jobs
}
```

The app already sends COOP/COEP/CSP headers; do not strip them. `TRUST_PROXY=1` (set in `ecosystem.config.cjs`) makes the
per-IP rate limit use the real client address; without it every visitor would share one limit.

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
`ALLOW_UNISOLATED_OFFICE` (1 = serve LibreOffice tools without network isolation; not recommended), `JOBS_DIR`, `DATA_DIR`, `WEB_DIST`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `S3_BUCKET_NAME` (optional, off by default).
