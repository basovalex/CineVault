"""Аккаунты и контексты просмотра. Старую анонимную историю не присваивает."""
import hashlib
import hmac
import json
import math
import re
import secrets
import sqlite3
import time
import unicodedata
import uuid

SESSION_TTL = 30 * 86400


class AccountError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def digest(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def password_hash(password):
    if not isinstance(password, str) or not 10 <= len(password) <= 256:
        raise AccountError("Пароль должен содержать от 10 до 256 символов")
    salt = secrets.token_hex(16)
    value = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, maxmem=64 * 1024 * 1024)
    return f"scrypt${salt}${value.hex()}"


def password_matches(password, encoded):
    try:
        scheme, salt, expected = encoded.split('$')
        if scheme != 'scrypt' or not isinstance(password, str) or len(password) > 256:
            return False
        value = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(value.hex(), expected)
    except (ValueError, TypeError):
        return False


def text(value, limit=160):
    return str(value or '').strip()[:limit]


def position(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise AccountError("Некорректная позиция видео")
    if not math.isfinite(result) or not 0 <= result <= 864000:
        raise AccountError("Некорректная позиция видео")
    return result


class Accounts:
    def __init__(self, db, lock, clock=time.time):
        self.db, self.lock, self.clock = db, lock, clock
        self.attempts = {}
        self.last_cleanup = 0
        with lock:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS account_users (
              id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
              password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created_at REAL NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS account_sessions (
              token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
            CREATE TABLE IF NOT EXISTS watch_contexts (
              id TEXT PRIMARY KEY, member_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
              created_at REAL NOT NULL, writer_room TEXT, writer_until REAL NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS watch_context_members (context_id TEXT NOT NULL, user_id TEXT NOT NULL,
              PRIMARY KEY(context_id,user_id));
            CREATE TABLE IF NOT EXISTS context_invites (token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
              expires_at REAL NOT NULL, accepted_by TEXT);
            CREATE TABLE IF NOT EXISTS account_progress (
              context_id TEXT NOT NULL, title_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL,
              edition TEXT NOT NULL, position REAL NOT NULL, duration REAL NOT NULL, completed INTEGER NOT NULL,
              revision INTEGER NOT NULL, updated_at REAL NOT NULL, last_operation TEXT NOT NULL,
              last_payload TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(context_id,title_id,season,episode,edition));
            CREATE TABLE IF NOT EXISTS account_watch_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, actor_id TEXT NOT NULL,
              title_id TEXT NOT NULL, kind TEXT NOT NULL, position REAL NOT NULL, created_at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS account_history_context ON account_progress(context_id,updated_at DESC);
            CREATE TABLE IF NOT EXISTS account_hidden_history (
              user_id TEXT NOT NULL, context_id TEXT NOT NULL, title_id TEXT NOT NULL,
              PRIMARY KEY(user_id,context_id,title_id));
            CREATE TABLE IF NOT EXISTS account_site_state (
              user_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at REAL NOT NULL);
            ''')
            db.commit()

    def limit(self, key):
        now = self.clock()
        with self.lock:
            if len(self.attempts) > 2048:
                self.attempts = {k: v for k, v in self.attempts.items() if v and now - v[-1] < 900}
                if len(self.attempts) > 2048:
                    raise AccountError("Попробуйте войти позже", 429)
            recent = [t for t in self.attempts.get(key, []) if now - t < 900]
            if len(recent) >= 10:
                raise AccountError("Слишком много попыток. Повторите через 15 минут", 429)
            self.attempts[key] = recent + [now]

    def user(self, row):
        return {k: row[k] for k in ('id', 'username', 'display_name')}

    def _session(self, user_id):
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        now = self.clock()
        self.db.execute('DELETE FROM account_sessions WHERE expires_at < ?', (now,))
        self.db.execute('INSERT INTO account_sessions VALUES (?,?,?,?)', (digest(token), user_id, csrf, now + SESSION_TTL))
        self.db.commit()
        return token, csrf

    def register(self, payload, ip='local'):
        self.limit(('register', ip))
        username = unicodedata.normalize('NFKC', text(payload.get('username'), 40)).casefold()
        if not re.fullmatch(r'[\w.-]{3,32}', username):
            raise AccountError("Логин: 3–32 буквы, цифры, точка, дефис или подчёркивание")
        name = text(payload.get('display_name'), 40)
        if not name:
            raise AccountError("Укажите имя, которое увидят участники")
        hashed = password_hash(payload.get('password'))
        user_id, recovery = uuid.uuid4().hex, secrets.token_urlsafe(24)
        with self.lock:
            try:
                self.db.execute('INSERT INTO account_users VALUES (?,?,?,?,?,?,0)',
                                (user_id, username, name, hashed, digest(recovery), self.clock()))
                self.context_for([user_id])
                token, csrf = self._session(user_id)
            except sqlite3.IntegrityError:
                self.db.rollback()
                raise AccountError("Этот логин уже занят", 409)
            return {'user': {'id': user_id, 'username': username, 'display_name': name},
                    'csrf': csrf, 'recovery_code': recovery}, token

    def login(self, payload, ip='local'):
        self.limit(('login', ip))
        name = unicodedata.normalize('NFKC', text(payload.get('username'), 40)).casefold()
        with self.lock:
            row = self.db.execute('SELECT * FROM account_users WHERE username=? AND deleted=0', (name,)).fetchone()
        # Равная стоимость проверки для существующего и неизвестного пользователя.
        encoded = row['password_hash'] if row else 'scrypt$' + '00' * 16 + '$' + '00' * 64
        valid = password_matches(payload.get('password'), encoded)
        if not row or not valid:
            raise AccountError("Неверный логин или пароль", 401)
        with self.lock:
            token, csrf = self._session(row['id'])
        return {'user': self.user(row), 'csrf': csrf}, token

    def authenticate(self, token):
        if not token:
            return None
        with self.lock:
            row = self.db.execute('''SELECT u.id,u.username,u.display_name,s.csrf,s.token_hash
                FROM account_sessions s JOIN account_users u ON u.id=s.user_id
                WHERE s.token_hash=? AND s.expires_at>? AND u.deleted=0''', (digest(token), self.clock())).fetchone()
            return dict(row) if row else None

    def logout(self, actor):
        with self.lock:
            self.db.execute('DELETE FROM account_sessions WHERE token_hash=?', (actor['token_hash'],))
            self.db.commit()

    def recover(self, payload, ip='local'):
        self.limit(('recover', ip))
        username = unicodedata.normalize('NFKC', text(payload.get('username'), 40)).casefold()
        code = str(payload.get('recovery_code', ''))
        with self.lock:
            row = self.db.execute('SELECT * FROM account_users WHERE username=? AND deleted=0', (username,)).fetchone()
            if not row or not hmac.compare_digest(digest(code), row['recovery_hash']):
                raise AccountError("Неверный логин или код восстановления", 401)
            hashed = password_hash(payload.get('new_password'))
            recovery = secrets.token_urlsafe(24)
            self.db.execute('UPDATE account_users SET password_hash=?, recovery_hash=? WHERE id=?', (hashed, digest(recovery), row['id']))
            self.db.execute('DELETE FROM account_sessions WHERE user_id=?', (row['id'],))
            token, csrf = self._session(row['id'])
            return {'user': self.user(row), 'csrf': csrf, 'recovery_code': recovery}, token

    def delete(self, actor, password):
        with self.lock:
            row = self.db.execute('SELECT * FROM account_users WHERE id=?', (actor['id'],)).fetchone()
            if not password_matches(password, row['password_hash']):
                raise AccountError("Неверный пароль", 403)
            personal = self.context_for([actor['id']])['id']
            self.db.execute('DELETE FROM account_sessions WHERE user_id=?', (actor['id'],))
            self.db.execute('UPDATE account_users SET deleted=1,username=?,display_name=?,password_hash=?,recovery_hash=? WHERE id=?',
                            ('deleted-' + actor['id'], 'Удалённый участник', '', '', actor['id']))
            self.db.execute('DELETE FROM account_progress WHERE context_id=?', (personal,))
            self.db.execute('DELETE FROM account_watch_events WHERE context_id=?', (personal,))
            self.db.execute('DELETE FROM context_invites WHERE owner_id=?', (actor['id'],))
            self.db.execute('DELETE FROM account_site_state WHERE user_id=?', (actor['id'],))
            self.db.commit()

    def context_for(self, user_ids):
        ids = sorted(set(user_ids))
        if not ids or len(ids) > 16:
            raise AccountError("Некорректный состав участников")
        key = ','.join(ids)
        context_id = hashlib.sha256(key.encode()).hexdigest()[:32]
        with self.lock:
            for uid in ids:
                if not self.db.execute('SELECT 1 FROM account_users WHERE id=?', (uid,)).fetchone():
                    raise AccountError("Участник не найден", 404)
            self.db.execute('INSERT OR IGNORE INTO watch_contexts(id,member_key,kind,created_at) VALUES (?,?,?,?)',
                            (context_id, key, 'solo' if len(ids) == 1 else 'shared', self.clock()))
            self.db.executemany('INSERT OR IGNORE INTO watch_context_members VALUES (?,?)', [(context_id, uid) for uid in ids])
            return dict(self.db.execute('SELECT * FROM watch_contexts WHERE id=?', (context_id,)).fetchone())

    def require_context(self, actor_id, context_id):
        row = self.db.execute('''SELECT c.* FROM watch_contexts c JOIN watch_context_members m ON m.context_id=c.id
                              WHERE c.id=? AND m.user_id=?''', (context_id, actor_id)).fetchone()
        if not row:
            raise AccountError("Контекст просмотра недоступен", 404)
        return dict(row)

    def contexts(self, actor_id):
        with self.lock:
            rows = self.db.execute('''SELECT c.id,c.kind FROM watch_contexts c JOIN watch_context_members m
                 ON m.context_id=c.id WHERE m.user_id=? ORDER BY c.kind DESC,c.created_at DESC''', (actor_id,)).fetchall()
            result = []
            for row in rows:
                members = [dict(x) for x in self.db.execute('''SELECT u.id,u.display_name FROM account_users u
                     JOIN watch_context_members m ON m.user_id=u.id WHERE m.context_id=? ORDER BY u.display_name''', (row['id'],))]
                others = [m['display_name'] for m in members if m['id'] != actor_id]
                result.append({**dict(row), 'members': members, 'label': 'Один' if not others else 'Вместе: ' + ', '.join(others)})
            return result

    def invite(self, actor_id):
        token = secrets.token_urlsafe(24)
        with self.lock:
            self.db.execute('DELETE FROM context_invites WHERE expires_at<?', (self.clock(),))
            self.db.execute('INSERT INTO context_invites VALUES (?,?,?,NULL)', (digest(token), actor_id, self.clock() + 48 * 3600))
            self.db.commit()
        return token

    def peek_invite(self, token):
        with self.lock:
            row = self.db.execute('''SELECT i.*,u.display_name FROM context_invites i JOIN account_users u ON u.id=i.owner_id
                    WHERE i.token_hash=? AND i.expires_at>? AND u.deleted=0''', (digest(token), self.clock())).fetchone()
            if not row:
                raise AccountError("Приглашение не найдено или истекло", 404)
            return row

    def accept_invite(self, actor_id, token):
        with self.lock:
            invite = self.peek_invite(token)
            if invite['owner_id'] == actor_id:
                raise AccountError("Это ваше приглашение. Отправьте его другому человеку")
            if invite['accepted_by'] and invite['accepted_by'] != actor_id:
                raise AccountError("Приглашение уже использовано", 409)
            context = self.context_for([actor_id, invite['owner_id']])
            self.db.execute('UPDATE context_invites SET accepted_by=? WHERE token_hash=?', (actor_id, digest(token)))
            self.db.commit()
            return context['id']

    def progress_key(self, payload):
        title = text(payload.get('title_id'))
        edition = text(payload.get('edition', 'default'), 100)
        if not title or not edition:
            raise AccountError("Не указан фильм или версия видео")
        try:
            season, episode = int(payload.get('season', 0)), int(payload.get('episode', 0))
            if not (0 <= season <= 10000 and 0 <= episode <= 100000):
                raise ValueError
        except (ValueError, TypeError):
            raise AccountError("Некорректный сезон или серия")
        return title, season, episode, edition

    def get_progress(self, actor_id, context_id, payload):
        with self.lock:
            self.require_context(actor_id, context_id)
            key = self.progress_key(payload)
            row = self.db.execute('''SELECT * FROM account_progress WHERE context_id=? AND title_id=? AND season=? AND episode=? AND edition=?''', (context_id, *key)).fetchone()
            return self.public_progress(row) if row else {'revision': 0, 'position': 0, 'deleted': False}

    def public_progress(self, row):
        return {k: row[k] for k in ('context_id', 'title_id', 'season', 'episode', 'edition', 'position', 'duration', 'completed', 'revision', 'updated_at', 'deleted')}

    def write_progress(self, actor_id, context_id, payload, room_id=None):
        with self.lock:
            context = self.require_context(actor_id, context_id)
            if context['kind'] == 'shared':
                if not room_id or context['writer_room'] != room_id or context['writer_until'] < self.clock():
                    raise AccountError("Совместный прогресс обновляет только действующая комната", 403)
            key = self.progress_key(payload)
            pos, duration = position(payload.get('position')), position(payload.get('duration', 0))
            if duration and pos > duration + 2:
                raise AccountError("Позиция за пределами видео")
            operation = text(payload.get('operation_id'), 100)
            if not operation:
                raise AccountError("Не указан номер операции")
            try:
                revision = int(payload.get('expected_revision', -1))
            except (ValueError, TypeError):
                raise AccountError("Некорректная версия прогресса")
            serialized = json.dumps([*key, pos, duration, bool(payload.get('completed')), bool(payload.get('deleted'))])
            row = self.db.execute('''SELECT * FROM account_progress WHERE context_id=? AND title_id=? AND season=? AND episode=? AND edition=?''', (context_id, *key)).fetchone()
            if row and row['last_operation'] == operation:
                if row['last_payload'] != serialized:
                    raise AccountError("Номер операции уже использован для других данных", 409)
                return self.public_progress(row)
            if revision != (row['revision'] if row else 0):
                raise AccountError("Просмотр обновлён на другом устройстве. Выберите, с какого места продолжить", 409)
            now, deleted = self.clock(), int(bool(payload.get('deleted')))
            if now - self.last_cleanup > 3600:
                self.db.execute('DELETE FROM account_watch_events WHERE created_at<?', (now - 90 * 86400,))
                self.db.execute('DELETE FROM account_sessions WHERE expires_at<?', (now,))
                self.db.execute('DELETE FROM context_invites WHERE expires_at<?', (now,))
                self.last_cleanup = now
            self.db.execute('''INSERT OR REPLACE INTO account_progress VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                            (context_id, *key, pos, duration, int(bool(payload.get('completed'))), revision + 1,
                             now, operation, serialized, deleted))
            self.db.execute('INSERT INTO account_watch_events(context_id,actor_id,title_id,kind,position,created_at) VALUES (?,?,?,?,?,?)',
                            (context_id, actor_id, key[0], 'deleted' if deleted else 'checkpoint', pos, now))
            self.db.execute('DELETE FROM account_hidden_history WHERE user_id=? AND context_id=? AND title_id=?', (actor_id, context_id, key[0]))
            self.db.commit()
            return self.get_progress(actor_id, context_id, payload)

    def history(self, actor_id, context_id=None):
        with self.lock:
            if context_id:
                self.require_context(actor_id, context_id)
            rows = self.db.execute('''SELECT p.* FROM account_progress p JOIN watch_context_members m ON m.context_id=p.context_id
               WHERE m.user_id=? AND p.deleted=0 AND (? IS NULL OR p.context_id=?)
               AND NOT EXISTS (SELECT 1 FROM account_hidden_history h WHERE h.user_id=? AND h.context_id=p.context_id AND h.title_id=p.title_id)
               ORDER BY p.updated_at DESC LIMIT 500''', (actor_id, context_id, context_id, actor_id)).fetchall()
            return [self.public_progress(row) for row in rows]

    def hide_history(self, actor_id, context_id, title_id):
        with self.lock:
            context = self.require_context(actor_id, context_id)
            # Личное скрытие не удаляет общую точку продолжения другого участника.
            self.db.execute('INSERT OR IGNORE INTO account_hidden_history VALUES (?,?,?)', (actor_id, context_id, title_id))
            self.db.commit()

    def claim_room(self, actor_id, context_id, room_id):
        with self.lock:
            context = self.require_context(actor_id, context_id)
            if context['writer_room'] and context['writer_room'] != room_id and context['writer_until'] > self.clock():
                raise AccountError("Этот совместный просмотр уже открыт в другой комнате", 409)
            self.db.execute('UPDATE watch_contexts SET writer_room=?,writer_until=? WHERE id=?', (room_id, self.clock() + 15, context_id))
            self.db.commit()

    def release_room(self, room_id):
        with self.lock:
            self.db.execute('UPDATE watch_contexts SET writer_room=NULL,writer_until=0 WHERE writer_room=?', (room_id,))
            self.db.commit()

    def site_state(self, actor_id):
        with self.lock:
            row = self.db.execute('SELECT state_json FROM account_site_state WHERE user_id=?', (actor_id,)).fetchone()
        return {'state': json.loads(row['state_json']) if row else merge_site_state({}, {})}

    def save_site_state(self, actor_id, incoming):
        """Merge what a device sends with what other devices saved; the newer record wins."""
        if not isinstance(incoming, dict):
            raise AccountError('Нужен JSON-объект')
        with self.lock:
            row = self.db.execute('SELECT state_json FROM account_site_state WHERE user_id=?', (actor_id,)).fetchone()
            merged = merge_site_state(json.loads(row['state_json']) if row else {}, incoming)
            encoded = json.dumps(merged, ensure_ascii=False, separators=(',', ':'))
            if len(encoded) > SITE_STATE_LIMIT:
                raise AccountError('Слишком много данных', 413)
            self.db.execute('INSERT INTO account_site_state VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at',
                            (actor_id, encoded, self.clock()))
            self.db.commit()
        return {'state': merged}


SITE_STATE_LIMIT = 768 * 1024
SITE_MARK_LISTS = ('favorites', 'watchlist')


def _stamp(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) and number > 0 else 0.0


def merge_site_state(saved, incoming):
    """Favourites and watchlist are {id: {on, at}} so a removal on one device reaches the others;
    history is {id: last seen}; progress is the site's own records, the latest per key."""
    result = {}
    for name in SITE_MARK_LISTS:
        marks = {}
        for source in (saved, incoming):
            for key, mark in ((source or {}).get(name) or {}).items() if isinstance((source or {}).get(name), dict) else ():
                if not isinstance(mark, dict) or not str(key).strip() or len(str(key)) > 120:
                    continue
                entry = {'on': bool(mark.get('on')), 'at': _stamp(mark.get('at'))}
                if str(key) not in marks or entry['at'] >= marks[str(key)]['at']:
                    marks[str(key)] = entry
        result[name] = dict(sorted(marks.items(), key=lambda item: item[1]['at'], reverse=True)[:2000])
    history = {}
    for source in (saved, incoming):
        for key, seen in ((source or {}).get('history') or {}).items() if isinstance((source or {}).get('history'), dict) else ():
            if str(key).strip() and len(str(key)) <= 120:
                history[str(key)] = max(history.get(str(key), 0.0), _stamp(seen))
    result['history'] = dict(sorted(history.items(), key=lambda item: item[1], reverse=True)[:300])
    progress = {}
    for source in (saved, incoming):
        for key, record in ((source or {}).get('progress') or {}).items() if isinstance((source or {}).get('progress'), dict) else ():
            if not isinstance(record, dict) or not str(key).strip() or len(str(key)) > 160:
                continue
            if str(key) not in progress or _stamp(record.get('updatedAt')) >= _stamp(progress[str(key)].get('updatedAt')):
                progress[str(key)] = record
    result['progress'] = dict(sorted(progress.items(), key=lambda item: _stamp(item[1].get('updatedAt')), reverse=True)[:600])
    return result
