FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin cinevault \
    && pip install --no-cache-dir requests

WORKDIR /opt/cinevault
COPY --chown=cinevault:cinevault app ./app
COPY --chown=cinevault:cinevault tools ./tools
COPY --chown=cinevault:cinevault kinopoisk_media_system_fixed ./kinopoisk_media_system_fixed

RUN mkdir -p /data/media-library /inbox \
    && chown -R cinevault:cinevault /data/media-library /inbox

USER cinevault
VOLUME ["/data/media-library"]
EXPOSE 8081

ENTRYPOINT ["python", "tools/media_library_server.py"]
CMD ["--host", "0.0.0.0", "--port", "8081", "--data-dir", "/data/media-library"]
