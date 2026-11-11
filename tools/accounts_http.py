"""HTTP-маршруты аккаунтов. Basic/viewer-защита остаётся внешним периметром."""
import hmac
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlsplit
from tools.accounts import AccountError, SESSION_TTL

COOKIE = 'cinevault_session'


def actor(handler):
    cookie = SimpleCookie()
    try:
        cookie.load(handler.headers.get('Cookie', ''))
        value = cookie.get(COOKIE)
        return handler.library.accounts.authenticate(value.value if value else '')
    except Exception:
        return None


def handle(handler, method, parsed):
    if not parsed.path.startswith('/api/account/'):
        return False
    if not handler.require_viewer():
        return True
    store = handler.library.accounts
    current = actor(handler)
    headers = {}
    try:
        route = parsed.path[len('/api/account/'):]
        if method == 'GET':
            params = parse_qs(parsed.query)
            if route == 'session':
                result = {'user': store.user(current) if current else None, 'csrf': current['csrf'] if current else None}
            elif route == 'invitation':
                invitation = store.peek_invite(params.get('token', [''])[0])
                result = {'display_name': invitation['display_name']}
            else:
                if not current:
                    raise AccountError('Войдите в свой аккаунт', 401)
                if route == 'contexts':
                    result = {'contexts': store.contexts(current['id'])}
                elif route == 'history':
                    result = {'entries': store.history(current['id'], params.get('context_id', [None])[0]), 'contexts': store.contexts(current['id'])}
                elif route == 'progress':
                    data = {key: values[0] for key, values in params.items()}
                    result = store.get_progress(current['id'], data.get('context_id', ''), data)
                else:
                    raise AccountError('Неизвестный endpoint', 404)
        elif method == 'POST':
            origin = handler.headers.get('Origin', '')
            if origin and urlsplit(origin).netloc != handler.headers.get('Host', ''):
                raise AccountError('Запрос с другого сайта запрещён', 403)
            if handler.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise AccountError('Запрос с другого сайта запрещён', 403)
            if handler.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                raise AccountError('Нужен application/json', 415)
            data = handler.read_json()
            if not isinstance(data, dict):
                raise AccountError('Нужен JSON-объект')
            ip = handler.client_address[0]
            if route in {'register', 'login', 'recover'}:
                result, token = getattr(store, route)(data, ip)
                secure = '; Secure' if handler.headers.get('X-Forwarded-Proto', '') == 'https' else ''
                headers['Set-Cookie'] = f'{COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_TTL}{secure}'
            else:
                if not current:
                    raise AccountError('Войдите в свой аккаунт', 401)
                if not hmac.compare_digest(handler.headers.get('X-CineVault-CSRF', ''), current['csrf']):
                    raise AccountError('Обновите страницу и повторите действие', 403)
                if route == 'logout':
                    store.logout(current)
                    result = {'ok': True}
                    headers['Set-Cookie'] = f'{COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
                elif route == 'delete':
                    store.delete(current, data.get('password'))
                    result = {'ok': True}
                    headers['Set-Cookie'] = f'{COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
                elif route == 'invitation':
                    result = {'token': store.invite(current['id'])}
                elif route == 'accept':
                    result = {'context_id': store.accept_invite(current['id'], data.get('token', ''))}
                elif route == 'progress':
                    result = store.write_progress(current['id'], data.get('context_id', ''), data)
                elif route == 'hide-history':
                    store.hide_history(current['id'], data.get('context_id', ''), data.get('title_id', ''))
                    result = {'ok': True}
                else:
                    raise AccountError('Неизвестный endpoint', 404)
        else:
            raise AccountError('Метод не поддерживается', 405)
        handler.send_json(200, result, extra_headers=headers)
    except AccountError as error:
        handler.send_json(error.status, {'error': str(error)})
    except (ValueError, TypeError, KeyError) as error:
        handler.send_json(400, {'error': 'Некорректные данные запроса'})
    return True


def authorize_mutation(handler):
    current = actor(handler)
    if not current:
        raise AccountError('Войдите в свой аккаунт', 401)
    origin = handler.headers.get('Origin', '')
    if origin and urlsplit(origin).netloc != handler.headers.get('Host', ''):
        raise AccountError('Запрос с другого сайта запрещён', 403)
    if not hmac.compare_digest(handler.headers.get('X-CineVault-CSRF', ''), current['csrf']):
        raise AccountError('Обновите страницу и повторите действие', 403)
    return current
