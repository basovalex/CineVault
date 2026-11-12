"""Web Push без сторонних сервисов: VAPID (RFC 8292) и шифрование aes128gcm (RFC 8291).

Ключ VAPID создаётся один раз и лежит в папке данных; браузер получает только публичную часть.
"""
import base64
import json
import os
import struct
import time
from pathlib import Path
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hmac import HMAC


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def unb64url(text: str) -> bytes:
    text = str(text or '')
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def _public_bytes(key) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def _hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    mac = HMAC(salt, hashes.SHA256())
    mac.update(ikm)
    return mac.finalize()


def _hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    mac = HMAC(prk, hashes.SHA256())
    mac.update(info + b'\x01')
    return mac.finalize()[:length]


class Vapid:
    def __init__(self, path: Path, contact: str):
        self.path = Path(path)
        self.contact = contact or 'mailto:admin@localhost'
        if self.path.is_file():
            self.key = serialization.load_pem_private_key(self.path.read_bytes(), password=None)
        else:
            self.key = ec.generate_private_key(ec.SECP256R1())
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            os.chmod(self.path, 0o600)
        self.public_key = b64url(_public_bytes(self.key))

    def header(self, endpoint: str) -> str:
        parts = urlsplit(endpoint)
        claims = {'aud': f'{parts.scheme}://{parts.netloc}', 'exp': int(time.time()) + 12 * 3600, 'sub': self.contact}
        signing_input = f"{b64url(json.dumps({'typ': 'JWT', 'alg': 'ES256'}).encode())}.{b64url(json.dumps(claims).encode())}"
        r, s = decode_dss_signature(self.key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
        token = f'{signing_input}.{b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))}'
        return f'vapid t={token}, k={self.public_key}'


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    client_public = unb64url(p256dh)
    auth_secret = unb64url(auth)
    server_key = ec.generate_private_key(ec.SECP256R1())
    server_public = _public_bytes(server_key)
    shared = server_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), client_public))
    ikm = _hkdf_expand(_hkdf_extract(auth_secret, shared), b'WebPush: info\x00' + client_public + server_public, 32)
    salt = os.urandom(16)
    prk = _hkdf_extract(salt, ikm)
    cek = _hkdf_expand(prk, b'Content-Encoding: aes128gcm\x00', 16)
    nonce = _hkdf_expand(prk, b'Content-Encoding: nonce\x00', 12)
    body = AESGCM(cek).encrypt(nonce, payload + b'\x02', None)
    return salt + struct.pack('!I', 4096) + bytes([len(server_public)]) + server_public + body


def send(vapid: Vapid, subscription: dict, message: dict, ttl: int = 86400) -> int:
    """Отправляет одно уведомление; возвращает HTTP-статус push-сервиса (404/410 — подписки больше нет)."""
    endpoint = subscription['endpoint']
    keys = subscription.get('keys') or {}
    body = encrypt(json.dumps(message, ensure_ascii=False).encode(), keys['p256dh'], keys['auth'])
    response = requests.post(endpoint, data=body, timeout=15, headers={
        'Authorization': vapid.header(endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': str(ttl),
        'Urgency': 'normal',
    })
    return response.status_code
