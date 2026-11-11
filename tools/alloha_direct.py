"""Адаптер отдельного доступа Alloha /direct. Не извлекает поток из iframe.

Контракт получен из открытой интеграции Lampac и требует живой проверки
с собственным secret_token провайдера перед включением в пользовательский плеер.
"""
import ipaddress
import os
from urllib.parse import parse_qs, urlsplit
import requests


class DirectSourceError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def configured():
    return bool(os.environ.get('CINEVAULT_ALLOHA_DIRECT_SECRET', '').strip()
                and os.environ.get('CINEVAULT_ALLOHA_DIRECT_API_URL', '').strip())


def public_ip(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise DirectSourceError('Не удалось определить внешний адрес устройства', 503)
    if not address.is_global:
        raise DirectSourceError('Для прямого потока нужен внешний IP устройства. Настройте доверенный reverse proxy', 503)
    return str(address)


def client_ip(peer, forwarded='', trusted=''):
    """Доверяем XFF только при соединении от явно настроенного proxy.

    Разбираем цепочку справа налево, чтобы клиент не мог подставить свой XFF.
    """
    try:
        networks = [ipaddress.ip_network(part.strip()) for part in trusted.split(',') if part.strip()]
        chain = [ipaddress.ip_address(peer)]
        if forwarded:
            chain = [ipaddress.ip_address(part.strip()) for part in forwarded.split(',')] + chain
    except ValueError:
        raise DirectSourceError('Некорректная конфигурация адресов proxy', 503)
    if len(chain) > 16:
        raise DirectSourceError('Слишком длинная цепочка proxy', 400)
    while len(chain) > 1 and any(chain[-1] in network for network in networks):
        chain.pop()
    return public_ip(str(chain[-1]))


def media_url(value):
    if not isinstance(value, str) or len(value) > 8192:
        return None
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        if parsed.scheme != 'https' or not host or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        if host.lower() in {'localhost', 'localhost.localdomain'} or host.lower().endswith(('.local', '.localhost')):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        return value
    except ValueError:
        return None


def normalize(payload, translation):
    data = payload.get('data', {}) if isinstance(payload, dict) else {}
    file = data.get('file', {}) if isinstance(data, dict) else {}
    sources = file.get('hlsSource', []) if isinstance(file, dict) else []
    if not isinstance(sources, list):
        sources = []
    candidates = [s for s in sources if isinstance(s, dict)]
    source = next((s for s in candidates if s.get('default')), candidates[0] if candidates else {})
    qualities = source.get('quality', {})
    variants = []
    if isinstance(qualities, dict):
        for quality, value in list(qualities.items())[:16]:
            url = media_url(value)
            if url:
                label = str(quality)[:20]
                variants.append({'quality': label, 'url': url, 'type': 'application/vnd.apple.mpegurl'})
    if not variants:
        raise DirectSourceError('Alloha не вернул доступных прямых HLS-потоков')
    tracks = []
    raw_tracks = file.get('tracks') or []
    if not isinstance(raw_tracks, list):
        raw_tracks = []
    for track in raw_tracks[:32]:
        if isinstance(track, dict) and media_url(track.get('src')):
            tracks.append({'label': str(track.get('label', 'Субтитры'))[:80], 'url': track['src']})
    return {'provider': 'alloha', 'mode': 'direct', 'translation': str(translation),
            'variants': variants, 'tracks': tracks, 'verification': 'provider-response-only'}


def resolve(option, address, season=0, episode=0, session=requests):
    """option приходит исключительно из валидированного server-side player-options."""
    endpoint = os.environ.get('CINEVAULT_ALLOHA_DIRECT_API_URL', '').strip()
    secret = os.environ.get('CINEVAULT_ALLOHA_DIRECT_SECRET', '').strip()
    if not endpoint or not secret:
        raise DirectSourceError('Прямой доступ Alloha не настроен. Нужен отдельный secret_token провайдера', 503)
    parsed = urlsplit(endpoint)
    if not media_url(endpoint) or parsed.query or parsed.fragment or parsed.path.rstrip('/') != '/direct':
        raise DirectSourceError('Настройте HTTPS endpoint Alloha /direct без параметров', 503)
    embed = urlsplit(option['embedUrl'])
    if embed.scheme != 'https' or embed.hostname != 'theatre.stravers.live':
        raise DirectSourceError('Источник Alloha не подтверждён', 400)
    movie = parse_qs(embed.query).get('token_movie', [''])[0]
    if not movie:
        raise DirectSourceError('В ответе Alloha отсутствует идентификатор фильма')
    params = {'secret_token': secret, 'token_movie': movie, 'ip': public_ip(address), 'translation': option['id']}
    if season:
        params['season'] = int(season)
    if episode:
        params['episode'] = int(episode)
    try:
        with session.get(endpoint, params=params, timeout=(5, 15), stream=True, allow_redirects=False) as response:
            if response.status_code in (401, 403):
                raise DirectSourceError('Alloha отклонил доступ к прямым ссылкам', 503)
            if response.status_code != 200:
                raise DirectSourceError('Сервис прямых ссылок Alloha сейчас недоступен')
            raw = response.raw.read(256 * 1024 + 1, decode_content=True)
            if len(raw) > 256 * 1024:
                raise DirectSourceError('Ответ Alloha превышает допустимый размер')
            import json
            payload = json.loads(raw)
    except (requests.RequestException, ValueError):
        # requests exception может содержать URL с secret_token: наружу его не выводим.
        raise DirectSourceError('Не удалось получить прямой поток Alloha') from None
    result = normalize(payload, option['id'])
    if secret in str(result):
        raise DirectSourceError('Провайдер вернул некорректную ссылку')
    return result
