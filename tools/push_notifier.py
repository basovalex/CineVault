"""Уведомления на устройство о новых сериях и премьерах.

Подписки на сериалы и фильмы — это список «Напомнить» в состоянии аккаунта (site-state).
Устройство, разрешившее уведомления, присылает свою push-подписку; раз в 20 минут сервер
спрашивает TMDB, что вышло, и шлёт по одному уведомлению на серию или премьеру.
"""
import hmac
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import requests

from tools import accounts_http
from tools.accounts import AccountError

CHECK_EVERY = 20 * 60
LOOKBACK_DAYS = 3
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
                    show = self._tmdb(f'tv/{tmdb_id}?language=ru-RU')
                    last = show.get('last_episode_to_air') or {}
                    episodes = []
                    if last.get('season_number') is not None:
                        season = self._tmdb(f"tv/{tmdb_id}/season/{last['season_number']}?language=ru-RU")
                        episodes = season.get('episodes') or []
                    cache[title_id] = {'title': show.get('name') or '', 'image': show.get('backdrop_path') or show.get('poster_path') or '',
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
            out.append({'key': key, 'title': title, 'body': body, 'url': url,
                        'image': f'{self.public_url}/tmdb/t/p/w780{image}' if image and self.public_url else ''})
        return out

    def check(self, store):
        devices = self.devices()
        if not devices:
            return 0
        today = datetime.now(timezone.utc).date().isoformat()
        floor = datetime.fromtimestamp(time.time() - LOOKBACK_DAYS * 86400, timezone.utc).date().isoformat()
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
                since = max(subscribed, floor)
                for notice in self.notices_for(title_id, since, today, cache):
                    with self.lock:
                        if self.db.execute('SELECT 1 FROM sent WHERE user_id=? AND key=?', (user_id, notice['key'])).fetchone():
                            continue
                        self.db.execute('INSERT INTO sent VALUES (?,?,?)', (user_id, notice['key'], time.time()))
                        self.db.commit()
                    for device in user_devices:
                        sent_total += self.deliver(device, notice)
        return sent_total

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
