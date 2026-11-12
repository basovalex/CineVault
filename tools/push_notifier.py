"""Уведомления на устройство о новых сериях и премьерах.

Подписки на сериалы и фильмы — это список «Напомнить» в состоянии аккаунта (site-state).
Устройство, разрешившее уведомления, присылает свою push-подписку; раз в 20 минут сервер
спрашивает TMDB, что вышло, и шлёт по одному уведомлению на серию или премьеру.
О серии пишет не в день выхода по TMDB, а когда её можно смотреть: она нашлась хотя бы
в одном источнике Lampac. До того серия перепроверяется каждый круг, до недели.
"""
import hmac
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlencode, urljoin, urlsplit, parse_qsl

import requests

from tools import accounts_http
from tools.accounts import AccountError

CHECK_EVERY = 20 * 60
LOOKBACK_DAYS = 3
EPISODE_LOOKBACK_DAYS = 7
SOURCES_TO_ASK = 12


class LampacProbe:
    """Is an episode playable yet: the same questions the site asks Lampac."""

    def __init__(self, origin, uid=''):
        self.origin = origin.rstrip('/')
        self.uid = uid

    def _json(self, url, timeout=15):
        target = urljoin(self.origin + '/', url)
        parts = urlsplit(target)
        params = dict(parse_qsl(parts.query, keep_blank_values=True))
        params['rjson'] = 'true'
        if self.uid and target.startswith(self.origin) and re.match(r'^/(lite|lifeevents)', parts.path):
            params.setdefault('uid', self.uid)
        response = requests.get(f'{parts.scheme}://{parts.netloc}{parts.path}?{urlencode(params)}', timeout=timeout)
        response.raise_for_status()
        text = response.text.strip()
        return json.loads(text) if text[:1] in ('{', '[') else None

    @staticmethod
    def _number(entry, fallback):
        for value in (entry.get('s'), entry.get('id'), (re.search(r'\d+', str(entry.get('name') or '')) or [None])[0]):
            try:
                number = int(value)
                if number > 0:
                    return number
            except (TypeError, ValueError):
                continue
        return fallback

    def has_episode(self, query, season, episode):
        events = self._json(f'/lite/events?{urlencode(query)}&life=false', timeout=45)
        entries = events if isinstance(events, list) else (events or {}).get('online') or []
        for entry in [one for one in entries if one.get('show') is not False and one.get('url')][:SOURCES_TO_ASK]:
            try:
                url = urljoin(self.origin + '/', entry['url'])
                have = dict(parse_qsl(urlsplit(url).query))
                extra = {key: value for key, value in query.items() if key not in have and value}
                node = self._json(url + ('&' if '?' in url else '?') + urlencode(extra))
                if (node or {}).get('type') == 'similar':
                    continue
                if (node or {}).get('type') == 'season':
                    seasons = node.get('data') or []
                    match = next((one for position, one in enumerate(seasons) if self._number(one, position + 1) == season and one.get('url')), None)
                    node = self._json(match['url']) if match else None
                if (node or {}).get('type') != 'episode':
                    continue
                for position, item in enumerate(node.get('data') or []):
                    if int(item.get('s') or season) == season and int(item.get('e') or position + 1) == episode:
                        return True
            except Exception:
                continue
        return False
TITLE_RE = re.compile(r'^tmdb-(movie|tv)-(\d+)$')


class PushNotifier:
    def __init__(self, data_dir, tmdb_token, public_url=''):
        from tools.web_push import Vapid  # cryptography is only needed when push is used
        self.db = sqlite3.connect(str(data_dir / 'push.sqlite3'), check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS devices (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL, subscription TEXT NOT NULL, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS sent (user_id INTEGER NOT NULL, key TEXT NOT NULL, sent_at REAL NOT NULL, PRIMARY KEY (user_id, key));
            ''')
            self.db.commit()
        self.vapid = Vapid(data_dir / 'vapid_private.pem', public_url or 'mailto:admin@localhost')
        self.tmdb_token = tmdb_token
        self.public_url = public_url.rstrip('/')
        origin = os.environ.get('CINEVAULT_LAMPAC_ORIGIN', '').strip()
        self.lampac = LampacProbe(origin, os.environ.get('CINEVAULT_LAMPAC_UID', '').strip()) if origin else None

    # ---- devices
    def add_device(self, user_id, subscription):
        if not isinstance(subscription, dict) or not str(subscription.get('endpoint', '')).startswith('https://'):
            raise AccountError('Некорректная подписка')
        keys = subscription.get('keys') or {}
        if not keys.get('p256dh') or not keys.get('auth'):
            raise AccountError('Некорректная подписка')
        clean = {'endpoint': subscription['endpoint'], 'keys': {'p256dh': keys['p256dh'], 'auth': keys['auth']}}
        with self.lock:
            self.db.execute('INSERT INTO devices VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, subscription=excluded.subscription',
                            (clean['endpoint'], user_id, json.dumps(clean), time.time()))
            self.db.commit()

    def remove_device(self, user_id, endpoint):
        with self.lock:
            self.db.execute('DELETE FROM devices WHERE endpoint=? AND user_id=?', (endpoint, user_id))
            self.db.commit()

    def devices(self, user_id=None):
        with self.lock:
            rows = self.db.execute('SELECT endpoint, user_id, subscription, created_at FROM devices' + (' WHERE user_id=?' if user_id is not None else ''),
                                   (user_id,) if user_id is not None else ()).fetchall()
        return [{'endpoint': row[0], 'user_id': row[1], 'subscription': json.loads(row[2]), 'created_at': row[3]} for row in rows]

    # ---- what came out
    def _tmdb(self, path):
        response = requests.get(f'https://api.themoviedb.org/3/{path}', timeout=15,
                                headers={'Authorization': f'Bearer {self.tmdb_token}', 'Accept': 'application/json'})
        response.raise_for_status()
        return response.json()

    def notices_for(self, title_id, since, today, cache):
        match = TITLE_RE.match(title_id)
        if not match:
            return []
        kind, tmdb_id = match.group(1), match.group(2)
        if title_id not in cache:
            try:
                if kind == 'tv':
                    show = self._tmdb(f'tv/{tmdb_id}?language=ru-RU&append_to_response=external_ids')
                    last = show.get('last_episode_to_air') or {}
                    episodes = []
                    if last.get('season_number') is not None:
                        season = self._tmdb(f"tv/{tmdb_id}/season/{last['season_number']}?language=ru-RU")
                        episodes = season.get('episodes') or []
                    cache[title_id] = {'title': show.get('name') or '', 'image': show.get('backdrop_path') or show.get('poster_path') or '',
                                       'query': {'title': show.get('name') or '', 'original_title': show.get('original_name') or '',
                                                 'year': str(show.get('first_air_date') or '')[:4], 'serial': '1', 'id': str(tmdb_id),
                                                 'imdb_id': (show.get('external_ids') or {}).get('imdb_id') or '', 'kinopoisk_id': ''},
                                       'items': [{'season': e.get('season_number'), 'episode': e.get('episode_number'), 'name': e.get('name') or '',
                                                  'date': e.get('air_date') or '', 'still': e.get('still_path') or ''} for e in episodes]}
                else:
                    movie = self._tmdb(f'movie/{tmdb_id}?language=ru-RU&append_to_response=release_dates')
                    dates = [str(d.get('release_date', ''))[:10] for c in (movie.get('release_dates') or {}).get('results', []) for d in c.get('release_dates', []) if d.get('type') in (4, 5, 6)]
                    digital = min(dates) if dates else ''
                    cache[title_id] = {'title': movie.get('title') or '', 'image': movie.get('backdrop_path') or movie.get('poster_path') or '',
                                       'items': [{'date': digital, 'what': 'Вышел в цифре'}] if digital else [{'date': str(movie.get('release_date') or ''), 'what': 'Премьера'}]}
            except Exception:
                cache[title_id] = None
        info = cache[title_id]
        if not info:
            return []
        out = []
        for entry in info['items']:
            date = entry.get('date') or ''
            if not date or date < since or date > today:
                continue
            if kind == 'tv':
                name = re.sub(r'^(Эпизод|Серия|Episode)\s*\d+$', '', entry['name'], flags=re.I).strip()
                body = f"{entry['season']} сезон, {entry['episode']} серия" + (f' · {name}' if name else '')
                key = f"{title_id}:s{entry['season']}e{entry['episode']}"
                url = f"/title/{title_id}/?season={entry['season']}"
                image = entry.get('still') or info['image']
                title = f"Новая серия: {info['title']}"
            else:
                body = f"{entry['what']} — уже можно смотреть"
                key = f'{title_id}:release'
                url = f'/title/{title_id}/'
                image = info['image']
                title = info['title']
            if kind == 'tv':
                body += ' · уже можно смотреть'
            out.append({'key': key, 'title': title, 'body': body, 'url': url,
                        'season': entry.get('season'), 'episode': entry.get('episode'), 'query': info.get('query'),
                        'image': f'{self.public_url}/tmdb/t/p/w780{image}' if image and self.public_url else ''})
        return out

    def check(self, store):
        devices = self.devices()
        if not devices:
            return 0
        today = datetime.now(timezone.utc).date().isoformat()
        floor = datetime.fromtimestamp(time.time() - EPISODE_LOOKBACK_DAYS * 86400, timezone.utc).date().isoformat()
        movie_floor = datetime.fromtimestamp(time.time() - LOOKBACK_DAYS * 86400, timezone.utc).date().isoformat()
        playable = {}
        by_user = {}
        for device in devices:
            by_user.setdefault(device['user_id'], []).append(device)
        cache, sent_total = {}, 0
        for user_id, user_devices in by_user.items():
            try:
                marks = (store.site_state(user_id)['state'] or {}).get('subscriptions') or {}
            except Exception:
                continue
            first_device = min(device['created_at'] for device in user_devices)
            for title_id, mark in marks.items():
                if not mark.get('on'):
                    continue
                subscribed = datetime.fromtimestamp(max(float(mark.get('at') or 0) / 1000, first_device), timezone.utc).date().isoformat()
                since = max(subscribed, floor if title_id.startswith('tmdb-tv-') else movie_floor)
                for notice in self.notices_for(title_id, since, today, cache):
                    with self.lock:
                        if self.db.execute('SELECT 1 FROM sent WHERE user_id=? AND key=?', (user_id, notice['key'])).fetchone():
                            continue
                    if notice.get('season') is not None and not self._playable(notice, playable):
                        continue
                    with self.lock:
                        self.db.execute('INSERT INTO sent VALUES (?,?,?)', (user_id, notice['key'], time.time()))
                        self.db.commit()
                    message = {name: notice[name] for name in ('key', 'title', 'body', 'url', 'image') if notice.get(name)}
                    for device in user_devices:
                        sent_total += self.deliver(device, message)
        return sent_total

    def _playable(self, notice, playable):
        """An episode is announced once a source has it; without Lampac — by the air date."""
        if not self.lampac or not notice.get('query'):
            return True
        key = notice['key']
        if key not in playable:
            try:
                playable[key] = self.lampac.has_episode(notice['query'], int(notice['season']), int(notice['episode']))
            except Exception as error:
                print(f'push: lampac check failed: {type(error).__name__}', flush=True)
                playable[key] = False
        return playable[key]

    def deliver(self, device, message):
        from tools.web_push import send
        try:
            status = send(self.vapid, device['subscription'], message)
        except Exception as error:
            print(f'push: {type(error).__name__}', flush=True)
            return 0
        if status in (404, 410):
            with self.lock:
                self.db.execute('DELETE FROM devices WHERE endpoint=?', (device['endpoint'],))
                self.db.commit()
        return 1 if 200 <= status < 300 else 0

    def loop(self, store):
        time.sleep(60)
        while True:
            try:
                sent = self.check(store)
                if sent:
                    print(f'push: sent {sent}', flush=True)
            except Exception as error:
                print(f'push check failed: {type(error).__name__}: {error}', flush=True)
            time.sleep(CHECK_EVERY)


notifier = None


def start(library, public_url=''):
    """Включает уведомления, если есть ключ TMDB и библиотека cryptography."""
    global notifier
    token = os.environ.get('CINEVAULT_TMDB_BROWSER_TOKEN', '').strip() or getattr(library, 'tmdb_api_token', '')
    if not token:
        print('Push notifications: disabled (no TMDB token).', flush=True)
        return
    try:
        notifier = PushNotifier(library.root, token, public_url)
    except ImportError:
        print('Push notifications: disabled (cryptography is not installed).', flush=True)
        return
    threading.Thread(target=notifier.loop, args=(library.accounts,), name='push-notifier', daemon=True).start()
    print('Push notifications: enabled.', flush=True)


def handle(handler, method, parsed):
    if not parsed.path.startswith('/api/push/'):
        return False
    if not handler.require_viewer():
        return True
    route = parsed.path[len('/api/push/'):]
    try:
        if notifier is None:
            raise AccountError('Уведомления на сервере выключены', 503)
        if method == 'GET' and route == 'key':
            handler.send_json(200, {'key': notifier.vapid.public_key})
            return True
        current = accounts_http.actor(handler)
        if not current:
            raise AccountError('Войдите в свой аккаунт', 401)
        if method != 'POST':
            raise AccountError('Метод не поддерживается', 405)
        origin = handler.headers.get('Origin', '')
        if origin and urlsplit(origin).netloc != handler.headers.get('Host', ''):
            raise AccountError('Запрос с другого сайта запрещён', 403)
        if not hmac.compare_digest(handler.headers.get('X-CineVault-CSRF', ''), current['csrf']):
            raise AccountError('Обновите страницу и повторите действие', 403)
        data = handler.read_json()
        if route == 'subscribe':
            notifier.add_device(current['id'], data.get('subscription'))
            if data.get('hello'):
                notifier.deliver({'endpoint': data['subscription']['endpoint'], 'subscription': data['subscription']},
                                 {'title': 'CineVault', 'body': 'Уведомления включены: напишу, когда выйдут новые серии.', 'url': '/feed/', 'key': 'hello'})
            handler.send_json(200, {'ok': True})
        elif route == 'unsubscribe':
            notifier.remove_device(current['id'], str(data.get('endpoint', '')))
            handler.send_json(200, {'ok': True})
        else:
            raise AccountError('Неизвестный endpoint', 404)
    except AccountError as error:
        handler.send_json(error.status, {'error': str(error)})
    except (ValueError, TypeError, KeyError):
        handler.send_json(400, {'error': 'Некорректные данные запроса'})
    return True
