// Полноэкранный плеер для прямых потоков из Lampac: качество, озвучки и субтитры
// потока, скорость, размер кадра, картинка в картинке, статистика канала,
// «конец в…», список серий и следующая серия. Сам ничего не хранит: позицию
// отдаёт через onProgress, следующую ссылку получает через resolve().
(() => {
  const PREFS_KEY = "cinevault.playerPrefs";
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const FITS = [["contain", "По умолчанию"], ["cover", "Заполнить"], ["fill", "Растянуть"]];
  const IDLE_MS = 3000;
  const NEXT_COUNTDOWN = 10;

  const icons = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/>',
    rewind: '<path d="M11 7L5 12l6 5V7zM19 7l-6 5 6 5V7z" fill="currentColor" stroke="none"/>',
    forward: '<path d="M13 7l6 5-6 5V7zM5 7l6 5-6 5V7z" fill="currentColor" stroke="none"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
    pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none"/>',
    volume: '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11"/>',
    muted: '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M17 9l5 6M22 9l-5 6"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    audio: '<path d="M12 3v18M8 7v10M4 10v4M16 7v10M20 10v4"/>',
    subs: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 13h4M13 13h4M7 16h10"/>',
    next: '<path d="M6 6l9 6-9 6V6z" fill="currentColor" stroke="none"/><path d="M18 6v12"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
    together: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 016.5 4.8"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ""}</svg>`;
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

  function prefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { return {}; }
  }
  function savePrefs(patch) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), ...patch })); } catch {}
  }
  function clock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  function left(seconds) {
    const total = Math.max(0, Math.round((Number(seconds) || 0) / 60));
    const h = Math.floor(total / 60);
    return h ? `${h} ч. ${total % 60} м.` : `${total} м.`;
  }
  function hhmm(date) {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  function qualityName(height, width = 0) {
    if (width >= 3800 || height >= 2000) return "4K";
    if (height >= 1400) return "2K"; // a wide 2592×1080 film is still 1080p
    if (width >= 1900 || height >= 1000) return "FHD";
    if (width >= 1260 || height >= 700) return "HD";
    return height ? "SD" : "";
  }
  function qualityLines(label) {
    const text = String(label || "");
    if (/4k|uhd/i.test(text)) return 2160;
    if (/2k/i.test(text)) return 1440;
    return Number(text.match(/(\d{3,4})/)?.[1] || 0);
  }
  // The quality to start with. A choice the viewer once made is kept for good; until then
  // a phone gets Full HD and a computer what its screen can show (2K or 4K), never more.
  function deviceLines() {
    const phone = window.matchMedia?.("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 900;
    if (phone) return 1080;
    const lines = Math.min(screen.width, screen.height) * (window.devicePixelRatio || 1);
    return lines >= 2000 ? 2160 : lines >= 1400 ? 1440 : 1080;
  }
  function wantedLines() {
    const lines = Number(prefs().lines);
    return lines > 0 ? lines : deviceLines();
  }
  // Best available that does not exceed the wish; the lowest one if all are higher.
  function pickLines(available, wish = wantedLines()) {
    const sorted = [...new Set(available.filter((lines) => lines > 0))].sort((a, b) => b - a);
    return sorted.find((lines) => lines <= wish) || sorted[sorted.length - 1] || 0;
  }
  function mbit(bits) {
    return bits ? `${(bits / 1e6).toFixed(2)} Мбит/с` : "—";
  }

  // options: { title, subtitle, voice, stream, qualities: {label: url}, subtitles: [{label, url}],
  //   startAt, episodes: [{label, current, s, e}], resolve(index) -> Promise<{stream, qualities, subtitles}>,
  //   onProgress({position, duration, completed, s, e}), onClose() }
  function open(options) {
    document.querySelector(".cv-player")?._close?.();
    const root = document.createElement("div");
    root.className = "cv-player is-ui";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", options.title || "Плеер");
    root.innerHTML = `
      <video class="cv-player-video" playsinline preload="auto"></video>
      <div class="cv-player-loading" role="status" aria-live="polite"><div class="cv-player-spinner" aria-hidden="true"></div><strong></strong><small></small><button class="cv-player-loading-other" data-act="choose-source" type="button" hidden>Выбрать другой источник</button></div>
      <div class="cv-player-error" role="alert" hidden></div>
      <div class="cv-player-top">
        <button class="cv-player-icon" data-act="close" type="button" aria-label="Закрыть">${icon("back")}</button>
        <div class="cv-player-heading">
          <div class="cv-player-title"></div>
          <div class="cv-player-stats"><span class="cv-player-res" hidden></span><span class="cv-player-voice"></span><span class="cv-player-net"></span></div>
        </div>
        <div class="cv-player-clock"><strong></strong><small></small></div>
      </div>
      <button class="cv-player-segment" data-act="segment" type="button" hidden></button>
      <div class="cv-player-next" hidden><button class="cv-player-skip" data-act="next" type="button"></button><button class="cv-player-skip-close" data-act="next-hide" type="button" aria-label="Скрыть следующую серию">${icon("close")}</button></div>
      <div class="cv-player-bottom">
        <div class="cv-player-times"><span class="cv-player-pos">00:00:00</span><span class="cv-player-rest"></span></div>
        <div class="cv-player-bar" role="slider" tabindex="0" aria-label="Позиция">
          <div class="cv-player-buffered"></div><div class="cv-player-played"></div><div class="cv-player-thumb"></div><div class="cv-player-hover" hidden><div class="cv-player-hover-frame" hidden></div><span class="cv-player-hover-time"></span></div>
        </div>
        <div class="cv-player-controls">
          <div class="cv-player-group">
            <button class="cv-player-icon" data-act="list" type="button" aria-label="Серии" title="Серии" hidden>${icon("list")}</button>
            <button class="cv-player-icon cv-player-voice-button" data-act="voices" type="button" aria-label="Озвучка" title="Озвучка" hidden>${icon("voice")}</button>
            <button class="cv-player-icon" data-act="next" type="button" aria-label="Следующая серия" title="Следующая серия" hidden>${icon("next")}</button>
            <div class="cv-player-volume"><button class="cv-player-icon" data-act="mute" type="button" aria-label="Звук">${icon("volume")}</button><input type="range" min="0" max="1" step="0.05" aria-label="Громкость"></div>
          </div>
          <div class="cv-player-group cv-player-center">
            <button class="cv-player-icon cv-player-main" data-act="toggle" type="button" aria-label="Пауза">${icon("pause")}</button>
          </div>
          <div class="cv-player-group">
            <button class="cv-player-pill" data-act="quality" type="button" aria-label="Качество" hidden></button>
            <button class="cv-player-icon" data-act="audio" type="button" aria-label="Звуковая дорожка" hidden>${icon("audio")}</button>
            <button class="cv-player-icon" data-act="subs" type="button" aria-label="Субтитры" hidden>${icon("subs")}</button>
            <button class="cv-player-icon" data-act="room" type="button" aria-label="Смотреть вместе" title="Смотреть вместе"${options.onRoom ? "" : " hidden"}>${icon("together")}</button>
            <button class="cv-player-icon" data-act="settings" type="button" aria-label="Настройки">${icon("settings")}</button>
            <button class="cv-player-icon" data-act="pip" type="button" aria-label="Картинка в картинке">${icon("pip")}</button>
            <button class="cv-player-icon" data-act="fullscreen" type="button" aria-label="Во весь экран">${icon("full")}</button>
          </div>
        </div>
      </div>
      <aside class="cv-player-panel" hidden><h3></h3><div class="cv-player-seasons" hidden></div><div class="cv-player-options"></div></aside>
      <div class="cv-player-room" hidden></div>
      <div class="cv-player-toast" role="status" aria-live="polite" hidden></div>`;
    document.body.append(root);
    document.documentElement.classList.add("cv-player-open");

    const $ = (selector) => root.querySelector(selector);
    const video = $(".cv-player-video");
    const bar = $(".cv-player-bar");
    const panel = $(".cv-player-panel");
    const volume = $(".cv-player-volume input");
    const pref = prefs();
    let hls = null;
    let current = { stream: options.stream, qualities: options.qualities || {}, subtitles: options.subtitles || [] };
    let episodes = options.episodes || [];
    let index = Math.max(0, episodes.findIndex((entry) => entry.current));
    let qualityLabel = "";
    let idleTimer = 0;
    let saveTimer = 0;
    let lastSave = 0;
    let nextTimer = 0;
    let nextLeft = 0;
    let closed = false;
    let panelKind = "";
    // The episode list can show another season: loaded on demand, played only when an
    // episode of it is chosen (then that season becomes the player's list).
    let panelSeason = null;
    const seasonCache = new Map();
    // Intro, recap and credits marks (IntroDB through our server), per episode.
    let segments = [];
    let activeSegment = null;
    const autoSkipped = new Set();
    const SEGMENT_LABELS = { intro: "Пропустить интро", recap: "Пропустить пересказ", outro: "Пропустить титры" };
    const loadSegments = () => {
      const want = index;
      segments = [];
      activeSegment = null;
      autoSkipped.clear();
      if (!options.segments) return;
      Promise.resolve(options.segments(episodes[index] || {})).then((list) => {
        if (closed || want !== index) return;
        segments = (Array.isArray(list) ? list : []).filter((one) => one && one.end > one.start);
      }).catch(() => {});
    };

    // What the spinner says: connecting to a new video, or waiting for data mid-play; after a
    // while it says the source is slow and offers another one instead of spinning silently.
    let connecting = true;
    let loadingTarget = -1;
    let slowTimer = 0;
    const paintLoading = () => {
      const box = $(".cv-player-loading");
      const entry = episodes[loadingTarget >= 0 ? loadingTarget : index] || {};
      const what = [entry.e ? `${entry.s ? `${entry.s} сезон, ` : ""}${entry.label || `${entry.e} серия`}` : "", options.voice || ""].filter(Boolean).join(" · ");
      box.querySelector("strong").textContent = connecting ? "Подключаю видео…" : "Загружаю…";
      box.querySelector("small").textContent = connecting ? what : "";
      box.querySelector("button").hidden = true;
      window.clearTimeout(slowTimer);
      // Some sources take 10–20 s to start: first a calm word, the offer of another source only much later,
      // so a slow-but-working source is not abandoned.
      slowTimer = window.setTimeout(() => {
        if (!root.classList.contains("is-loading")) return;
        box.querySelector("small").textContent = connecting ? "Ещё немного — видео загружается." : "Догружаю видео…";
        slowTimer = window.setTimeout(() => {
          if (!root.classList.contains("is-loading")) return;
          box.querySelector("small").textContent = "Этот источник сегодня долго отвечает. Можно подождать или выбрать другой.";
          box.querySelector("button").hidden = !options.onChooseSource;
        }, 15000);
      }, connecting ? 10000 : 12000);
    };
    new MutationObserver(() => {
      const loading = root.classList.contains("is-loading");
      if (loading && !root.dataset.loadingShown) { root.dataset.loadingShown = "1"; paintLoading(); }
      if (!loading && root.dataset.loadingShown) { delete root.dataset.loadingShown; window.clearTimeout(slowTimer); }
    }).observe(root, { attributes: true, attributeFilter: ["class"] });

    video.volume = Number.isFinite(pref.volume) ? pref.volume : 1;
    video.muted = Boolean(pref.muted);
    video.playbackRate = SPEEDS.includes(pref.speed) ? pref.speed : 1;
    video.style.objectFit = pref.fit || "contain";
    volume.value = video.muted ? 0 : video.volume;

    const episode = () => episodes[index] || {};
    const header = () => {
      const entry = episode();
      // The lock screen and the iPhone's Dynamic Island show the poster and the episode, not a blank tile.
      if ("mediaSession" in navigator && window.MediaMetadata) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: options.title || "CineVault",
            artist: options.isMovie ? (options.voice || "") : [entry.label, entry.name].filter(Boolean).join(" · "),
            album: "CineVault",
            artwork: options.artwork ? [{ src: options.artwork, sizes: "500x750", type: "image/jpeg" }] : [],
          });
        } catch {}
      }
      const nextButton = root.querySelector('.cv-player-icon[data-act="next"]');
      if (nextButton) nextButton.hidden = !(options.autoNext !== false && episodes[index + 1]);
      // Episodes and voices are two different buttons: a film has only voices.
      const listButton = root.querySelector('[data-act="list"]');
      if (listButton) listButton.hidden = Boolean(options.isMovie) || episodes.length < 2;
      const voiceButton = root.querySelector('[data-act="voices"]');
      if (voiceButton) voiceButton.hidden = !(options.isMovie ? episodes.length > 1 || options.onChooseSource : (options.voices || []).length > 1 || options.onChooseSource);
      $(".cv-player-title").textContent = entry.label && entry.e ? `${options.title} · ${entry.s ? `${entry.s} сезон, ` : ""}${entry.label}` : (options.subtitle ? `${options.title} · ${options.subtitle}` : options.title);
      $(".cv-player-voice").textContent = options.voice || "";
    };
    const toast = (text) => {
      const box = $(".cv-player-toast");
      box.textContent = text;
      box.hidden = false;
      window.clearTimeout(box._timer);
      box._timer = window.setTimeout(() => { box.hidden = true; }, 1600);
    };
    const showUi = () => {
      root.classList.add("is-ui");
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => { if (!video.paused && !panelKind) root.classList.remove("is-ui"); }, IDLE_MS);
    };
    const saveProgress = (completed = false) => {
      const entry = episode();
      options.onProgress?.({ position: video.currentTime || 0, duration: video.duration || 0, completed, s: entry.s, e: entry.e });
      lastSave = Date.now();
    };

    const qualityList = () => {
      if (hls?.levels?.length > 1) {
        return [{ id: -1, label: "Авто", active: hls.autoLevelEnabled }, ...hls.levels.map((level, levelIndex) => ({ id: levelIndex, label: `${level.height || qualityLines(level.name)}p`, lines: level.height || 0, active: !hls.autoLevelEnabled && hls.currentLevel === levelIndex })).sort((a, b) => b.lines - a.lines)];
      }
      const labels = Object.keys(current.qualities || {});
      return labels.length > 1 ? labels.sort((a, b) => qualityLines(b) - qualityLines(a)).map((label) => ({ id: label, label, active: label === qualityLabel })) : [];
    };
    const updateQualityButton = () => {
      const button = $('[data-act="quality"]');
      const list = qualityList();
      const name = qualityName(video.videoHeight, video.videoWidth);
      button.hidden = !name && !list.length;
      button.textContent = name || "Качество";
      button.disabled = !list.length;
    };
    const updateTrackButtons = () => {
      $('[data-act="audio"]').hidden = !(hls?.audioTracks?.length > 1);
      $('[data-act="subs"]').hidden = !(hls?.subtitleTracks?.length || current.subtitles.length);
    };

    // Lampac's /proxy/ links hide the format, so ask the server what it serves.
    const isHls = async (stream) => {
      if (/\.m3u8(?:$|[?#])/i.test(stream)) return true;
      if (/\.(mp4|m4v|webm|mkv|mov)(?:$|[?#])/i.test(stream)) return false;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(stream, { signal: controller.signal, cache: "no-store" });
        const type = response.headers.get("content-type") || "";
        controller.abort();
        return /mpegurl/i.test(type);
      } catch {
        return false;
      } finally {
        window.clearTimeout(timer);
      }
    };
    // A frame over the seek bar, as in Lampa and YouTube: a second, muted copy of the video
    // in its lowest quality seeks to the hovered second. Made on the first hover only.
    // A frame over the seek bar, as in Lampa and YouTube: a second, muted copy of the video
    // (its lowest quality) seeks to the hovered second, the frame is drawn into a small picture
    // and kept, so coming back to that spot is instant. Seeks go one after another, never
    // waiting for the mouse to stop; until the exact frame is ready the nearest kept one shows
    // dimmed with a spinner, never a stale frame from somewhere else.
    let previewSource = { stream: "", hls: false };
    let preview = null;
    const PREVIEW_W = 320;
    const PREVIEW_H = 180;
    const dropPreview = () => {
      if (!preview) return;
      preview.dead = true;
      preview.hls?.destroy();
      preview.video.removeAttribute("src");
      preview.video.load();
      preview.video.remove();
      preview = null;
      const frame = $(".cv-player-hover-frame");
      if (frame) { frame.hidden = true; frame.classList.remove("is-waiting"); }
    };
    const previewStep = () => {
      const duration = video.duration || 0;
      return Math.max(4, Math.min(30, duration / 240));
    };
    const showPreviewFrame = (bucket) => {
      const copy = preview;
      const frame = $(".cv-player-hover-frame");
      const canvas = frame?.querySelector("canvas");
      if (!copy || !canvas) return;
      const exact = copy.frames.get(bucket);
      let shown = exact;
      if (!shown) {
        let best = -1;
        copy.frames.forEach((unused, key) => { if (best < 0 || Math.abs(key - bucket) < Math.abs(best - bucket)) best = key; });
        shown = best >= 0 && Math.abs(best - bucket) * previewStep() <= 90 ? copy.frames.get(best) : null;
      }
      const context = canvas.getContext("2d");
      if (shown) context.drawImage(shown, 0, 0, PREVIEW_W, PREVIEW_H);
      else { context.fillStyle = "#000"; context.fillRect(0, 0, PREVIEW_W, PREVIEW_H); }
      frame.hidden = false;
      frame.classList.toggle("is-waiting", !exact);
    };
    const capturePreview = (copy, bucket) => {
      const shot = document.createElement("canvas");
      shot.width = PREVIEW_W;
      shot.height = PREVIEW_H;
      const context = shot.getContext("2d");
      const width = copy.video.videoWidth || 16;
      const height = copy.video.videoHeight || 9;
      const scale = Math.max(PREVIEW_W / width, PREVIEW_H / height);
      context.drawImage(copy.video, (PREVIEW_W - width * scale) / 2, (PREVIEW_H - height * scale) / 2, width * scale, height * scale);
      copy.frames.set(bucket, shot);
      if (copy.frames.size > 400) copy.frames.delete(copy.frames.keys().next().value);
    };
    const runPreviewSeek = () => {
      const copy = preview;
      if (!copy || copy.dead || copy.busy || !copy.ready || copy.queued === null) return;
      const bucket = copy.queued;
      copy.queued = null;
      if (copy.frames.has(bucket)) { if (copy.hovered === bucket) showPreviewFrame(bucket); runPreviewSeek(); return; }
      copy.busy = true;
      copy.seeking = bucket;
      const target = Math.min(bucket * previewStep(), Math.max(0, (copy.video.duration || video.duration || 0) - 1));
      // A slow source may take long to seek: after 20 s the bucket is asked again, but a
      // late «seeked» still delivers its frame (the listener lives as long as the copy).
      window.clearTimeout(copy.guard);
      copy.guard = window.setTimeout(() => {
        if (copy.dead || copy.seeking !== bucket) return;
        copy.busy = false;
        copy.seeking = null;
        if (copy.hovered === bucket) copy.queued = bucket;
        runPreviewSeek();
      }, 8000);
      copy.video.currentTime = target;
    };
    const finishPreviewSeek = (copy) => {
      if (copy.dead || copy.seeking === null) return;
      const bucket = copy.seeking;
      const done = () => {
        if (copy.dead || copy.seeking !== bucket) return;
        window.clearTimeout(copy.guard);
        try { capturePreview(copy, bucket); } catch {}
        copy.busy = false;
        copy.seeking = null;
        if (copy.hovered === bucket) showPreviewFrame(bucket);
        runPreviewSeek();
      };
      if (typeof copy.video.requestVideoFrameCallback === "function") {
        let fired = false;
        copy.video.requestVideoFrameCallback(() => { if (!fired) { fired = true; done(); } });
        window.setTimeout(() => { if (!fired) { fired = true; done(); } }, 250);
      } else {
        window.setTimeout(done, 60);
      }
    };
    const ensurePreview = () => {
      if (preview || !previewSource.stream || !window.matchMedia("(hover: hover)").matches) return preview;
      const frame = $(".cv-player-hover-frame");
      if (!frame) return null;
      if (!frame.querySelector("canvas")) frame.insertAdjacentHTML("afterbegin", `<canvas width="${PREVIEW_W}" height="${PREVIEW_H}"></canvas><span class="cv-player-hover-wait" aria-hidden="true"></span>`);
      const frameVideo = document.createElement("video");
      frameVideo.muted = true;
      frameVideo.playsInline = true;
      frameVideo.preload = "auto";
      frameVideo.className = "cv-player-hover-video";
      preview = { video: frameVideo, hls: null, ready: false, busy: false, queued: null, hovered: null, frames: new Map(), dead: false, guard: 0 };
      const copy = preview;
      // Seek only once the copy has its first data: a seek before that never completes.
      const markReady = () => { if (!copy.dead && !copy.ready && frameVideo.readyState >= 1) { copy.ready = true; runPreviewSeek(); } };
      frameVideo.addEventListener("loadedmetadata", markReady);
      frameVideo.addEventListener("seeked", () => finishPreviewSeek(copy));
      frameVideo.addEventListener("loadeddata", markReady);
      if (previewSource.hls && window.Hls?.isSupported()) {
        const hlsCopy = new window.Hls({ maxBufferLength: 2, maxMaxBufferLength: 4, startLevel: 0, capLevelToPlayerSize: false, autoStartLoad: true, enableWorker: true });
        hlsCopy.on(window.Hls.Events.MANIFEST_PARSED, () => { hlsCopy.currentLevel = 0; hlsCopy.autoLevelEnabled = false; });
        hlsCopy.loadSource(previewSource.stream);
        hlsCopy.attachMedia(frameVideo);
        copy.hls = hlsCopy;
      } else {
        frameVideo.src = previewSource.stream;
      }
      frame.append(frameVideo);
      return copy;
    };
    const previewAt = (seconds) => {
      const copy = ensurePreview();
      if (!copy) return;
      const bucket = Math.round(seconds / previewStep());
      copy.hovered = bucket;
      showPreviewFrame(bucket);
      if (!copy.frames.has(bucket) && copy.seeking !== bucket) copy.queued = bucket;
      runPreviewSeek();
    };
    let loadToken = 0;
    const load = async (stream, startAt = 0, autoplay = true) => {
      const mine = ++loadToken;
      dropPreview();
      connecting = true;
      root.classList.add("is-loading");
      const hlsStream = await isHls(stream);
      if (closed || mine !== loadToken) return;
      previewSource = { stream, hls: hlsStream };
      hls?.destroy();
      hls = null;
      $(".cv-player-error").hidden = true;
      root.classList.add("is-loading");
      [...video.querySelectorAll("track")].forEach((track) => track.remove());
      (current.subtitles || []).forEach((sub, subIndex) => {
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = sub.label || `Субтитры ${subIndex + 1}`;
        track.src = sub.url;
        video.append(track);
      });
      const start = () => {
        if (startAt > 5 && Number.isFinite(video.duration) && startAt < video.duration - 10) video.currentTime = startAt;
        if (autoplay) video.play().catch(() => { root.classList.add("is-paused"); });
      };
      video.addEventListener("loadedmetadata", start, { once: true });
      if (hlsStream && window.Hls?.isSupported()) {
        hls = new window.Hls({ maxBufferLength: 60, maxMaxBufferLength: 120, startLevel: -1, capLevelToPlayerSize: false });
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          if (hls.levels.length > 1) {
            const target = pickLines(hls.levels.map((level) => level.height || 0));
            const match = hls.levels.findIndex((level) => level.height === target);
            if (match >= 0 && Number(prefs().lines) > 0) hls.currentLevel = match;
            else if (match >= 0) hls.autoLevelCapping = match;
          }
          updateQualityButton();
          updateTrackButtons();
        });
        hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, updateTrackButtons);
        hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, updateTrackButtons);
        hls.on(window.Hls.Events.LEVEL_SWITCHED, updateQualityButton);
        let mediaRecoveries = 0;
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal || mine !== loadToken) return;
          if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
            if (mediaRecoveries++ === 1) hls.swapAudioCodec();
            hls.recoverMediaError();
            return;
          }
          // The network dropped or the link went stale: reconnect from the same second instead of giving up.
          reconnect();
        });
        hls.loadSource(stream);
        hls.attachMedia(video);
      } else {
        video.src = stream;
        video.load();
      }
      updateTrackButtons();
    };
    // Unsteady internet or a link that expired mid-film: wait for the network, reconnect from the same second,
    // every other try with a fresh link from the source. Only after many tries in a row does the error show.
    let reconnects = 0;
    let reconnecting = false;
    let lastTime = 0;
    let lastProgressAt = Date.now();
    let steadySince = 0;
    const online = () => navigator.onLine !== false ? Promise.resolve() : new Promise((done) => {
      const go = () => { window.removeEventListener("online", go); done(); };
      window.addEventListener("online", go);
      window.setTimeout(go, 60000);
    });
    const reconnect = async () => {
      if (closed || reconnecting) return;
      const at = video.currentTime > 1 ? video.currentTime : lastTime || Number(options.startAt || 0);
      reconnects += 1;
      if (reconnects > 8) {
        fail("Связь с источником пропала. Проверьте интернет и откройте серию заново или выберите другой источник.");
        reconnects = 0;
        return;
      }
      reconnecting = true;
      const mine = loadToken;
      root.classList.add("is-loading");
      // Before the first frame it is just a slow start: a quiet line under the spinner, no alarm.
      if (lastTime >= 1 || navigator.onLine === false) toast(navigator.onLine === false ? "Нет интернета, жду связь…" : "Связь прервалась, переподключаюсь…");
      else { const small = $(".cv-player-loading small"); if (small) small.textContent = "Пробую ещё раз…"; }
      await online();
      await new Promise((done) => window.setTimeout(done, Math.min(1000 * 2 ** (reconnects - 1), 15000)));
      if (closed || mine !== loadToken) { reconnecting = false; return; }
      if (reconnects % 2 === 0 && options.resolve && episodes[index]) {
        try {
          const fresh = await options.resolve(index);
          if (!closed && mine === loadToken && fresh?.stream) current = { stream: fresh.stream, qualities: fresh.qualities || {}, subtitles: fresh.subtitles || current.subtitles };
        } catch {}
      }
      reconnecting = false;
      if (closed || mine !== loadToken) return;
      lastProgressAt = Date.now();
      load(current.qualities[qualityLabel] || current.stream, at);
    };
    const fail = (text) => {
      root.classList.remove("is-loading");
      const box = $(".cv-player-error");
      box.textContent = text;
      box.hidden = false;
      showUi();
    };
    const pickInitialQuality = () => {
      const labels = Object.keys(current.qualities || {});
      if (!labels.length) return current.stream;
      tried.clear();
      const target = pickLines(labels.map(qualityLines));
      qualityLabel = labels.find((label) => qualityLines(label) === target) || labels.sort((a, b) => qualityLines(b) - qualityLines(a))[0];
      return current.qualities[qualityLabel] || current.stream;
    };

    // In a shared room only the host steers; the room itself drives a guest's video.
    const locked = () => {
      if (video.dataset.roomLocked !== "true") return false;
      toast("Управляет ведущий комнаты");
      return true;
    };
    const togglePlay = () => { if (locked()) return; if (video.paused || video.ended) video.play().catch(() => {}); else video.pause(); };
    const seek = (delta) => { if (locked()) return; if (Number.isFinite(video.duration)) { video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + delta)); toast(`${delta > 0 ? "+" : "−"}${Math.abs(delta)} с`); } };
    const setVolume = (value) => {
      video.volume = Math.max(0, Math.min(1, value));
      video.muted = video.volume === 0;
      volume.value = video.volume;
      savePrefs({ volume: video.volume, muted: video.muted });
      toast(`Громкость ${Math.round(video.volume * 100)}%`);
    };
    // The player already fills the page; this hides the browser's own bars too. iPhone
    // Safari cannot do that for a page element, only its native video player can.
    const toggleFullscreen = () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else if (root.requestFullscreen) root.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
      else video.webkitEnterFullscreen?.();
    };

    const goTo = async (target, startAt = 0, { fromRoom = false } = {}) => {
      if (!options.resolve || !episodes[target]) return;
      if (!fromRoom && locked()) return;
      cancelNext();
      saveProgress(false);
      video.pause();
      connecting = true;
      loadingTarget = target;
      delete root.dataset.loadingShown;
      root.classList.add("is-loading");
      paintLoading();
      try {
        const next = await options.resolve(target);
        if (closed) return;
        if (!next?.stream) throw new Error("нет ссылки");
        episodes.forEach((entry, entryIndex) => { entry.current = entryIndex === target; });
        index = target;
        current = { stream: next.stream, qualities: next.qualities || {}, subtitles: next.subtitles || [] };
        if (next.voice !== undefined) options.voice = next.voice;
        header();
        loadSegments();
        load(pickInitialQuality(), startAt);
        if (!fromRoom) options.onEpisodeChange?.(episode().s, episode().e);
      } catch {
        fail("Не удалось открыть эту серию. Попробуйте ещё раз или выберите другую озвучку.");
      }
    };
    // Like Lampa: the next-episode card with its still comes up on the end credits and stays;
    // it counts down only over the last seconds, and the episode's end plays the next one.
    let nextHiddenFor = -1;
    const nextBox = () => $(".cv-player-next");
    // Another voice of the same source, same episode, same second.
    const switchVoice = async (voice) => {
      if (!options.onVoice) return;
      const at = video.currentTime || 0;
      cancelNext();
      saveProgress(false);
      video.pause();
      connecting = true;
      loadingTarget = index;
      options.voice = voice.name;
      delete root.dataset.loadingShown;
      root.classList.add("is-loading");
      paintLoading();
      try {
        const next = await options.onVoice(voice, episode());
        if (closed) return;
        if (!next?.stream) throw new Error("нет ссылки");
        index = Math.max(0, next.index);
        episodes.forEach((entry, entryIndex) => { entry.current = entryIndex === index; });
        if (Array.isArray(next.voices)) options.voices = next.voices;
        current = { stream: next.stream, qualities: next.qualities || {}, subtitles: next.subtitles || [] };
        header();
        loadSegments();
        load(pickInitialQuality(), at);
        toast(`Озвучка: ${voice.name}`);
      } catch (error) {
        fail(error?.message === "нет серии" ? `В озвучке «${voice.name}» нет этой серии. Выберите другую.` : "Не удалось переключить озвучку. Попробуйте другую.");
      }
    };
    const cancelNext = () => {
      window.clearInterval(nextTimer);
      nextTimer = 0;
      nextBox().hidden = true;
    };
    const offerNext = (rest) => {
      const target = index + 1;
      const next = episodes[target];
      if (!next || nextHiddenFor === index) return;
      const left = Math.max(0, Math.ceil(rest));
      const lead = left <= NEXT_COUNTDOWN ? `Следующая серия · через ${left} с` : "Следующая серия";
      const button = $(".cv-player-skip");
      const key = `${target}|${next.still || ""}|${next.name || ""}|${lead}`;
      if (button.dataset.key !== key) {
        button.dataset.key = key;
        button.innerHTML = `${next.still ? `<span class="cv-player-skip-thumb"><img class="cv-player-skip-still" src="${esc(next.still)}" alt="" loading="lazy"><span class="cv-player-skip-play">${icon("play")}</span></span>` : `<span class="cv-player-skip-icon">${icon("next")}</span>`}<span class="cv-player-skip-copy"><small>${lead}</small><strong>${esc(next.name || next.label)}</strong>${next.name ? `<em>${esc(next.label)}</em>` : ""}</span>`;
      }
      nextBox().hidden = false;
    };
    const nextLead = (duration) => Math.min(90, Math.max(30, duration * 0.04));
    // Like Lampa: «Пропустить интро» while the intro runs; with auto-skip on it jumps by itself
    // once per episode. Credits of a series are covered by the next-episode card instead.
    const syncSegment = (position, duration) => {
      const hasNext = options.autoNext !== false && episodes[index + 1];
      const found = segments.find((one) => position >= one.start && position < Math.min(one.end, duration || one.end) - 1 && !(one.type === "outro" && hasNext)) || null;
      const button = $(".cv-player-segment");
      if (found && options.autoSkip && found.type !== "outro" && !autoSkipped.has(found.id || found.start)) {
        autoSkipped.add(found.id || found.start);
        video.currentTime = Math.min(found.end, (duration || found.end) - 1);
        toast(found.type === "recap" ? "Пересказ пропущен" : "Интро пропущено");
        activeSegment = null;
        button.hidden = true;
        return;
      }
      if (found === activeSegment) return;
      activeSegment = found;
      if (!found) { button.hidden = true; return; }
      button.innerHTML = `<span>${SEGMENT_LABELS[found.type] || "Пропустить"}</span>${icon("next")}`;
      button.hidden = false;
    };
    const skipSegment = () => {
      if (!activeSegment) return;
      const duration = video.duration || activeSegment.end;
      video.currentTime = Math.min(activeSegment.end, duration - 0.5);
      activeSegment = null;
      $(".cv-player-segment").hidden = true;
    };

    const openPanel = (kind) => {
      if (panelKind === kind) { closePanel(); return; }
      panelKind = kind;
      let title = "";
      let items = [];
      let emptyText = "Пока нечего выбрать.";
      if (kind === "quality") {
        title = "Качество";
        items = qualityList().map((entry) => ({ label: entry.label, active: entry.active, run: () => {
          if (hls?.levels?.length > 1) {
            if (entry.id === -1) {
              const cap = hls.levels.findIndex((level) => level.height === pickLines(hls.levels.map((one) => one.height || 0), deviceLines()));
              hls.autoLevelCapping = cap;
            } else {
              hls.autoLevelCapping = -1;
            }
            hls.currentLevel = entry.id;
            savePrefs({ lines: entry.id === -1 ? null : hls.levels[entry.id].height });
          } else {
            qualityLabel = entry.id;
            savePrefs({ lines: qualityLines(entry.id) });
            const at = video.currentTime;
            load(current.qualities[entry.id], at, !video.paused);
          }
          toast(`Качество: ${entry.label}`);
        } }));
      } else if (kind === "audio") {
        title = "Звуковая дорожка";
        items = (hls?.audioTracks || []).map((track, trackIndex) => ({ label: track.name || track.lang || `Дорожка ${trackIndex + 1}`, active: hls.audioTrack === trackIndex, run: () => { hls.audioTrack = trackIndex; } }));
      } else if (kind === "subs") {
        title = "Субтитры";
        const native = [...video.textTracks];
        const fromHls = hls?.subtitleTracks || [];
        const off = () => { native.forEach((track) => { track.mode = "disabled"; }); if (hls) hls.subtitleTrack = -1; };
        items = [{ label: "Выключены", active: !native.some((track) => track.mode === "showing") && !(hls && hls.subtitleTrack >= 0), run: off }];
        fromHls.forEach((track, trackIndex) => items.push({ label: track.name || track.lang || `Субтитры ${trackIndex + 1}`, active: hls.subtitleTrack === trackIndex, run: () => { off(); hls.subtitleTrack = trackIndex; hls.subtitleDisplay = true; } }));
        if (!fromHls.length) native.forEach((track) => items.push({ label: track.label, active: track.mode === "showing", run: () => { off(); track.mode = "showing"; } }));
      } else if (kind === "settings") {
        title = "Настройки";
        const fit = FITS.find(([value]) => value === (video.style.objectFit || "contain"))?.[1];
        const speed = video.playbackRate === 1 ? "Обычная" : `${video.playbackRate}×`;
        items = [
          { label: "Размер видео", note: fit, run: () => openPanel("fit"), keep: true },
          { label: "Скорость воспроизведения", note: speed, run: () => openPanel("speed"), keep: true },
          { label: "На другом устройстве", note: "Ссылка откроется с этой же секунды, серии, озвучки и источника", run: shareHere },
        ];
      } else if (kind === "fit") {
        title = "Размер видео";
        items = FITS.map(([value, label]) => ({ label, active: (video.style.objectFit || "contain") === value, run: () => { video.style.objectFit = value; savePrefs({ fit: value }); } }));
      } else if (kind === "speed") {
        title = "Скорость воспроизведения";
        items = SPEEDS.map((speed) => ({ label: speed === 1 ? "Обычная" : `${speed}×`, active: video.playbackRate === speed, run: () => { video.playbackRate = speed; savePrefs({ speed }); } }));
      } else if (kind === "voices") {
        title = "Озвучка";
        if (options.isMovie) {
          items = episodes.map((entry, entryIndex) => ({ label: entry.label, note: entry.note || "", active: entryIndex === index, run: () => { if (entryIndex !== index) goTo(entryIndex, video.currentTime); } }));
        } else {
          items = (options.voices || []).map((voice) => ({ label: voice.name, note: voice.active ? "Сейчас" : "", active: Boolean(voice.active), run: () => { if (!voice.active) switchVoice(voice); } }));
        }
        if (options.onChooseSource) items.push({ label: "Другой источник", note: "Вернуться к выбору источника и озвучки", run: () => { const pick = options.onChooseSource; close(); pick(); } });
      } else if (kind === "list" && options.seasons?.length > 1 && panelSeason !== null && panelSeason !== Number(episode().s)) {
        title = options.listTitle || "Серии";
        const viewing = panelSeason;
        const cached = seasonCache.get(viewing);
        if (!cached) {
          emptyText = "Загружаю сезон…";
          if (options.loadSeason) {
            seasonCache.set(viewing, { loading: true });
            Promise.resolve(options.loadSeason(viewing)).then((data) => {
              seasonCache.set(viewing, data?.episodes?.length ? data : { error: true });
            }).catch(() => seasonCache.set(viewing, { error: true })).then(() => {
              if (panelKind === "list" && panelSeason === viewing) { panelKind = ""; openPanel("list"); }
            });
          }
        } else if (cached.loading) {
          emptyText = "Загружаю сезон…";
        } else if (cached.error) {
          emptyText = `В этой озвучке нет ${viewing} сезона. Выберите другой сезон или озвучку.`;
        } else {
          items = cached.episodes.map((entry, entryIndex) => ({ label: entry.name ? `${entry.e}. ${entry.name}` : entry.label, note: entry.name ? entry.label : "", still: entry.still || "", active: false, run: () => {
            cached.apply();
            panelSeason = null;
            seasonCache.clear();
            goTo(entryIndex, entry.startAt || 0);
          } }));
        }
      } else if (kind === "list") {
        title = options.listTitle || "Серии";
        items = episodes.map((entry, entryIndex) => ({ label: entry.name ? `${entry.e ? `${entry.e}. ` : ""}${entry.name}` : entry.label, note: entry.name ? entry.label : entry.note || "", still: options.autoNext !== false ? entry.still || "" : undefined, active: entryIndex === index, run: () => { if (entryIndex !== index) goTo(entryIndex, options.keepPosition ? video.currentTime : entry.startAt || 0); } }));
      }
      panelKind = kind;
      const parent = kind === "fit" || kind === "speed" ? "settings" : "";
      panel.querySelector("h3").innerHTML = `<button class="cv-player-back" type="button" aria-label="${parent ? "Назад к настройкам" : "Закрыть меню"}">${icon("back")}</button>${esc(title)}`;
      panel.querySelector(".cv-player-back").addEventListener("click", () => { if (parent) { panelKind = ""; openPanel(parent); } else closePanel(); });
      panel.querySelector(".cv-player-options").innerHTML = items.length
        ? items.map((entry, itemIndex) => `<button type="button" class="cv-player-option${entry.active ? " is-active" : ""}${entry.still !== undefined ? " has-thumb" : ""}" data-option="${itemIndex}">${entry.still !== undefined ? (entry.still ? `<img class="cv-player-option-thumb" src="${esc(entry.still)}" alt="" loading="lazy">` : `<span class="cv-player-option-thumb" aria-hidden="true"></span>`) : ""}<span><strong>${esc(entry.label)}</strong>${entry.note ? `<small>${esc(entry.note)}</small>` : ""}</span>${entry.active ? icon("check") : ""}</button>`).join("")
        : `<p class="cv-player-empty">${esc(emptyText)}</p>`;
      const seasonRow = panel.querySelector(".cv-player-seasons");
      const showSeasons = kind === "list" && options.seasons?.length > 1;
      seasonRow.hidden = !showSeasons;
      if (showSeasons) {
        const viewing = panelSeason ?? Number(episode().s);
        seasonRow.innerHTML = options.seasons.map((one) => `<button type="button" class="cv-player-season${one.number === viewing ? " is-active" : ""}" data-season="${one.number}">${esc(one.label || `${one.number} сезон`)}</button>`).join("");
        seasonRow.querySelectorAll("[data-season]").forEach((button) => button.addEventListener("click", () => {
          panelSeason = Number(button.dataset.season);
          panelKind = "";
          openPanel("list");
        }));
        seasonRow.querySelector(".is-active")?.scrollIntoView({ block: "nearest", inline: "center" });
      }
      panel.querySelectorAll("[data-option]").forEach((button) => button.addEventListener("click", () => {
        const entry = items[Number(button.dataset.option)];
        entry.run();
        if (entry.keep || panelKind !== kind) return;
        if (kind === "fit" || kind === "speed") { panelKind = ""; openPanel("settings"); } else closePanel();
      }));
      panel.hidden = false;
      root.classList.add("is-ui", "has-panel");
      (panel.querySelector(".is-active") || panel.querySelector("[data-option]"))?.focus();
    };
    const closePanel = () => {
      panelKind = "";
      panelSeason = null;
      panel.hidden = true;
      root.classList.remove("has-panel");
      showUi();
    };
    const shareHere = async () => {
      const url = new URL(location.href);
      url.searchParams.set("t", String(Math.floor(video.currentTime || 0)));
      const entry = episode();
      if (entry.s) url.searchParams.set("s", String(entry.s));
      if (entry.e) url.searchParams.set("e", String(entry.e));
      if (options.handoff?.source) url.searchParams.set("src", options.handoff.source);
      if (options.handoff?.voice) url.searchParams.set("voice", options.handoff.voice);
      try {
        if (navigator.share) await navigator.share({ title: options.title, url: url.href });
        else { await navigator.clipboard.writeText(url.href); toast("Ссылка скопирована"); }
      } catch {}
    };

    // While the slider is held, the bar shows where it will land; the video moves on release.
    let scrubTo = null;
    const paintPosition = (position, duration) => {
      const share = (position / duration) * 100;
      $(".cv-player-played").style.width = `${share}%`;
      $(".cv-player-thumb").style.left = `${share}%`;
      $(".cv-player-pos").textContent = clock(position);
    };
    const updateTime = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const position = scrubTo ?? (video.currentTime || 0);
      $(".cv-player-pos").textContent = clock(position);
      const rest = (duration - position) / (video.playbackRate || 1);
      $(".cv-player-rest").textContent = `${clock(duration)} · Осталось ${left(rest)}`;
      $(".cv-player-clock small").textContent = `Конец в ${hhmm(new Date(Date.now() + rest * 1000))}`;
      paintPosition(position, duration);
      bar.setAttribute("aria-valuenow", String(Math.round(position)));
      bar.setAttribute("aria-valuetext", clock(position));
      if (Date.now() - lastSave > 5000) saveProgress(false);
      const outro = segments.find((one) => one.type === "outro" && one.start > duration * 0.5);
      if (options.autoNext !== false && episodes[index + 1] && duration > 300) {
        const creditsAt = outro ? outro.start : duration - nextLead(duration);
        if (position >= creditsAt) offerNext(duration - position);
        else if (!nextBox().hidden) cancelNext();
      }
      syncSegment(position, duration);
    };
    const updateStats = () => {
      $(".cv-player-clock strong").textContent = hhmm(new Date());
      const res = $(".cv-player-res");
      res.hidden = !video.videoWidth;
      res.textContent = video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : "";
      const buffered = video.buffered;
      let ahead = 0;
      for (let rangeIndex = 0; rangeIndex < buffered.length; rangeIndex += 1) {
        if (buffered.start(rangeIndex) <= video.currentTime && buffered.end(rangeIndex) >= video.currentTime) ahead = buffered.end(rangeIndex) - video.currentTime;
      }
      if (Number.isFinite(video.duration) && buffered.length) $(".cv-player-buffered").style.width = `${(buffered.end(buffered.length - 1) / video.duration) * 100}%`;
      const level = hls?.levels?.[hls.currentLevel];
      const parts = [];
      if (hls?.bandwidthEstimate) parts.push(`Канал ${mbit(hls.bandwidthEstimate)}`);
      if (level?.bitrate) parts.push(`Битрейт ~${mbit(level.bitrate)}`);
      parts.push(`Буфер ${Math.round(ahead)} с.`);
      $(".cv-player-net").textContent = parts.join(" • ");
      updateQualityButton();
    };
    const statsTimer = window.setInterval(updateStats, 1000);

    const barSeek = (event) => {
      const rect = bar.getBoundingClientRect();
      const share = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      return share * (video.duration || 0);
    };
    bar.addEventListener("pointerdown", (event) => {
      if (!Number.isFinite(video.duration) || locked()) return;
      event.preventDefault();
      bar.setPointerCapture(event.pointerId);
      root.classList.add("is-scrubbing");
      const show = (moveEvent) => { scrubTo = barSeek(moveEvent); paintPosition(scrubTo, video.duration); showUi(); };
      show(event);
      bar.addEventListener("pointermove", show);
      const finish = () => {
        bar.removeEventListener("pointermove", show);
        root.classList.remove("is-scrubbing");
        if (scrubTo !== null) video.currentTime = scrubTo;
        scrubTo = null;
      };
      bar.addEventListener("pointerup", finish, { once: true });
      bar.addEventListener("pointercancel", finish, { once: true });
    });
    bar.addEventListener("mousemove", (event) => {
      if (!Number.isFinite(video.duration)) return;
      const hover = $(".cv-player-hover");
      const rect = bar.getBoundingClientRect();
      hover.hidden = false;
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      hover.style.left = `${Math.max(90, Math.min(rect.width - 90, x))}px`;
      const seconds = barSeek(event);
      hover.querySelector(".cv-player-hover-time").textContent = clock(seconds);
      previewAt(seconds);
    });
    bar.addEventListener("mouseleave", () => { $(".cv-player-hover").hidden = true; if (preview) preview.hovered = null; });
    volume.addEventListener("input", () => setVolume(Number(volume.value)));

    const actions = {
      close: () => close(),
      toggle: togglePlay,
      rewind: () => seek(-10),
      forward: () => seek(10),
      mute: () => { video.muted = !video.muted; volume.value = video.muted ? 0 : video.volume; savePrefs({ muted: video.muted }); },
      fullscreen: toggleFullscreen,
      pip: () => { if (document.pictureInPictureElement) document.exitPictureInPicture(); else video.requestPictureInPicture?.().catch(() => toast("Браузер не поддерживает")); },
      next: () => goTo(index + 1),
      "next-hide": () => { nextHiddenFor = index; cancelNext(); },
      segment: () => skipSegment(),
      "choose-source": () => { if (!options.onChooseSource) return; const pick = options.onChooseSource; close(); pick(); },
      room: () => options.onRoom?.(),
      quality: () => openPanel("quality"),
      audio: () => openPanel("audio"),
      subs: () => openPanel("subs"),
      settings: () => openPanel("settings"),
      list: () => openPanel("list"),
      voices: () => openPanel("voices"),
    };
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-act]");
      if (button) { event.stopPropagation(); actions[button.dataset.act]?.(); showUi(); return; }
      if (event.target === video || event.target === root) {
        if (panelKind) closePanel();
        // A finger tap opens the controls (and a second tap hides them), as in phone players;
        // pausing is the button's job. A mouse click still pauses.
        else if (touchTap) {
          if (uiWasHidden) showUi();
          else if (!video.paused) { window.clearTimeout(idleTimer); root.classList.remove("is-ui"); }
        } else togglePlay();
      }
    });
    let touchTap = false;
    let uiWasHidden = false;
    root.addEventListener("pointerdown", (event) => {
      touchTap = event.pointerType === "touch" || event.pointerType === "pen";
      uiWasHidden = !root.classList.contains("is-ui");
    }, true);
    video.addEventListener("dblclick", toggleFullscreen);
    root.addEventListener("pointermove", showUi);

    const onKey = (event) => {
      if (event.target.closest?.("input, textarea") && event.key !== "Escape") return;
      const keys = {
        " ": togglePlay, k: togglePlay, ArrowLeft: () => seek(-10), ArrowRight: () => seek(10), j: () => seek(-30), l: () => seek(30),
        ArrowUp: () => setVolume(video.volume + 0.05), ArrowDown: () => setVolume(video.volume - 0.05),
        f: toggleFullscreen, m: actions.mute, n: () => options.autoNext !== false && goTo(index + 1), p: () => options.autoNext !== false && goTo(index - 1),
        Escape: () => (panelKind ? closePanel() : document.fullscreenElement ? null : close()),
      };
      const run = keys[event.key] || keys[event.key.toLowerCase?.()];
      if (!run) return;
      if (panelKind && event.key !== "Escape" && event.key.startsWith("Arrow") && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      run();
      showUi();
    };
    document.addEventListener("keydown", onKey, true);

    const syncPlayState = () => {
      const paused = video.paused;
      root.classList.toggle("is-paused", paused);
      const main = $('[data-act="toggle"]');
      main.innerHTML = icon(paused ? "play" : "pause");
      main.setAttribute("aria-label", paused ? "Смотреть" : "Пауза");
      showUi();
      if (paused) saveProgress(false);
    };
    video.addEventListener("play", syncPlayState);
    video.addEventListener("pause", syncPlayState);
    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("timeupdate", () => {
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastProgressAt = Date.now(); }
      if (!steadySince) steadySince = Date.now();
      if (reconnects && Date.now() - steadySince > 60000) reconnects = 0;
    });
    video.addEventListener("waiting", () => { steadySince = 0; });
    // Stuck with no new frames for half a minute while it should play: reconnect.
    const stallTimer = window.setInterval(() => {
      if (closed || reconnecting || connecting || video.paused || video.ended || lastTime < 1) return;
      if (Date.now() - lastProgressAt > 30000) reconnect();
    }, 5000);
    // The screen stays on while the film plays (where the browser supports it).
    let wakeLock = null;
    const holdScreen = async () => {
      if (closed || video.paused || document.visibilityState !== "visible" || wakeLock || !navigator.wakeLock) return;
      try { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } catch {}
    };
    const releaseScreen = () => { wakeLock?.release?.().catch(() => {}); wakeLock = null; };
    video.addEventListener("playing", holdScreen);
    video.addEventListener("pause", releaseScreen);
    const onVisible = () => { if (document.visibilityState === "visible") holdScreen(); };
    document.addEventListener("visibilitychange", onVisible);
    video.addEventListener("waiting", () => root.classList.add("is-loading"));
    video.addEventListener("playing", () => { connecting = false; loadingTarget = -1; root.classList.remove("is-loading"); });
    video.addEventListener("canplay", () => root.classList.remove("is-loading"));
    video.addEventListener("volumechange", () => { $('[data-act="mute"]').innerHTML = icon(video.muted || video.volume === 0 ? "muted" : "volume"); });
    video.addEventListener("ended", () => {
      saveProgress(true);
      if (options.autoNext !== false && episodes[index + 1]) goTo(index + 1);
    });
    // A file the browser cannot decode (often 4K HEVC) falls back to the next lower quality.
    const tried = new Set();
    video.addEventListener("error", () => {
      if (hls) return;
      // A dropped connection mid-film (or a link that expired after playing a while) is not a bad quality.
      if (video.error?.code === 2 || (lastTime > 5 && video.error?.code !== 3)) { reconnect(); return; }
      tried.add(qualityLabel);
      const lower = Object.keys(current.qualities || {}).filter((label) => !tried.has(label) && qualityLines(label) < (qualityLines(qualityLabel) || Infinity)).sort((a, b) => qualityLines(b) - qualityLines(a))[0];
      if (lower) {
        toast(`${qualityLabel} не воспроизводится, включаю ${lower}`);
        qualityLabel = lower;
        load(current.qualities[lower], video.currentTime || Number(options.startAt || 0));
        return;
      }
      fail("Видео не открылось. Выберите другую озвучку или источник.");
    });

    const onLeave = () => saveProgress(false);
    window.addEventListener("pagehide", onLeave);

    function close() {
      if (closed) return;
      closed = true;
      dropPreview();
      saveProgress(video.ended);
      cancelNext();
      window.clearInterval(statsTimer);
      window.clearInterval(stallTimer);
      document.removeEventListener("visibilitychange", onVisible);
      releaseScreen();
      window.clearTimeout(idleTimer);
      window.clearTimeout(saveTimer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pagehide", onLeave);
      if (document.fullscreenElement === root) document.exitFullscreen?.().catch(() => {});
      if (document.pictureInPictureElement === video) document.exitPictureInPicture?.().catch(() => {});
      video.pause();
      hls?.destroy();
      root.remove();
      document.documentElement.classList.remove("cv-player-open");
      options.onClose?.();
    }
    root._close = close;
    const playEpisode = (s, e) => {
      const target = episodes.findIndex((entry) => Number(entry.s) === Number(s) && Number(entry.e) === Number(e));
      if (target >= 0 && target !== index) goTo(target, 0, { fromRoom: true });
    };

    header();
    loadSegments();
    load(pickInitialQuality(), Number(options.startAt || 0));
    updateStats();
    showUi();
    root.focus?.();
    return { close, video, toast, playEpisode, roomSlot: $(".cv-player-room"), current: () => ({ s: episode().s || 0, e: episode().e || 0, voice: options.voice || "" }) };
  }

  window.CineVaultPlayer = { open };
})();
