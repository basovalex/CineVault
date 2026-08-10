# CineVault server deployment

This is the portable server package for the first-party media library. It accepts only video files that the administrator supplies, stores the original, prepares HLS with FFmpeg, and serves the same catalog to all users of the server.

## Local smoke test with Docker

```bash
cd "/Users/aleksandrbasov/Documents/сериал для нас с любимой"
cp .env.example .env
openssl rand -hex 32
# Put the generated value into CINEVAULT_ADMIN_TOKEN in .env.
mkdir -p inbox data/media-library
docker compose up -d --build
curl -fsS http://127.0.0.1:8081/api/health
docker compose logs -f cinevault
```

The data directory is a bind mount, so SQLite, originals, HLS playlists and segments survive container recreation. `restart: unless-stopped` brings the service back after a reboot. The container includes FFmpeg and runs as a non-root user.

Progress and history are stored in the same SQLite database on the persistent volume. `/api/history` is shared by all users of this backend, so a viewed episode and its last position remain available after changing browser, device or container.

## Importing a new episode on the server

Copy a legal file into `inbox/`, then run the import inside the container:

```bash
cp "/path/to/Show.S01E19.mp4" inbox/
docker compose exec cinevault python tools/import_media.py \
  /inbox/Show.S01E19.mp4 \
  --title "Отчаянные домохозяйки" \
  --season 1 \
  --episode 19 \
  --episode-title "Серия 19" \
  --tmdb-id 693 \
  --data-dir /data/media-library
```

The command waits for FFmpeg to finish and then the episode appears in the shared catalog. The browser upload is administrator-only and uses `X-CineVault-Admin-Token`; the backend CLI is preferable for large files.

## Storage sizing

The minimum practical server disk for this MVP is 10–20 GB, even if the target library starts at 5 GB: each episode keeps the original and HLS renditions while transcoding. Use a persistent VPS disk or block volume, not container-local storage. Keep at least 20% free space for the next upload and temporary FFmpeg output.

Example layout on a VPS:

```text
/srv/cinevault/
  project/                 # this repository
  data/media-library/      # persistent SQLite, originals and HLS
  inbox/                   # temporary administrator imports
```

`CINEVAULT_DATA_DIR` and `CINEVAULT_INBOX_DIR` can point to another mounted disk without changing the image.

## Moving the current library

Stop local writes first, then copy the persistent data and project:

```bash
rsync -a --info=progress2 data/media-library/ user@server:/srv/cinevault/project/data/media-library/
rsync -a --exclude data --exclude .env ./ user@server:/srv/cinevault/project/
ssh user@server 'cd /srv/cinevault/project && docker compose up -d --build'
```

Verify:

```bash
curl -fsS https://your-domain.example/api/health
```

## Internet access boundary

For a private couple/family service, put the container behind Tailscale or another private network. For a public hostname, add a reverse proxy with HTTPS and user authentication before exposing port 8081. The current token protects administrator imports; it is not a complete viewer login/ACL system. Before a public launch, add per-user authentication, title/episode ACLs, rate limits, backups and monitoring.
