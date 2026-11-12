import json
import struct
import tempfile
import time
import unittest
from pathlib import Path

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # the image has it; a bare Mac may not
    ec = None

if ec:
    from tools import web_push
    from tools.push_notifier import PushNotifier


@unittest.skipIf(ec is None, 'cryptography is not installed')
class WebPushTests(unittest.TestCase):
    def browser_decrypt(self, body, client_key, auth):
        """What the browser does with a push (RFC 8291), written independently of encrypt()."""
        salt, record_size, id_len = body[:16], struct.unpack('!I', body[16:20])[0], body[20]
        server_public = body[21:21 + id_len]
        ciphertext = body[21 + id_len:]
        self.assertEqual(record_size, 4096)
        client_public = client_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        shared = client_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), server_public))
        ikm = web_push._hkdf_expand(web_push._hkdf_extract(auth, shared), b'WebPush: info\x00' + client_public + server_public, 32)
        prk = web_push._hkdf_extract(salt, ikm)
        cek = web_push._hkdf_expand(prk, b'Content-Encoding: aes128gcm\x00', 16)
        nonce = web_push._hkdf_expand(prk, b'Content-Encoding: nonce\x00', 12)
        plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
        self.assertEqual(plain[-1:], b'\x02')
        return plain[:-1]

    def test_message_decrypts_in_the_browser(self):
        client_key = ec.generate_private_key(ec.SECP256R1())
        p256dh = web_push.b64url(client_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
        auth = b'0123456789abcdef'
        message = {'title': 'Новая серия', 'body': '3 сезон, 4 серия'}
        body = web_push.encrypt(json.dumps(message, ensure_ascii=False).encode(), p256dh, web_push.b64url(auth))
        self.assertEqual(json.loads(self.browser_decrypt(body, client_key, auth)), message)

    def test_vapid_header_is_a_valid_es256_token(self):
        with tempfile.TemporaryDirectory() as folder:
            vapid = web_push.Vapid(Path(folder) / 'key.pem', 'https://example.org')
            again = web_push.Vapid(Path(folder) / 'key.pem', 'https://example.org')
            self.assertEqual(vapid.public_key, again.public_key)
            header = vapid.header('https://web.push.apple.com/abc')
            token = header.split('t=')[1].split(',')[0]
            head, claims, signature = token.split('.')
            self.assertEqual(json.loads(web_push.unb64url(claims))['aud'], 'https://web.push.apple.com')
            raw = web_push.unb64url(signature)
            self.assertEqual(len(raw), 64)
            from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
            public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), web_push.unb64url(vapid.public_key))
            public.verify(encode_dss_signature(int.from_bytes(raw[:32], 'big'), int.from_bytes(raw[32:], 'big')), f'{head}.{claims}'.encode(), ec.ECDSA(hashes.SHA256()))


@unittest.skipIf(ec is None, 'cryptography is not installed')
class NotifierTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.notifier = PushNotifier(Path(self.folder.name), 'token', 'https://site.example')
        self.notifier._tmdb = self.fake_tmdb
        self.sent = []
        self.notifier.deliver = lambda device, message: self.sent.append(message['key']) or 1

    def tearDown(self):
        self.folder.cleanup()

    def fake_tmdb(self, path):
        if path.startswith('tv/1/season/2'):
            return {'episodes': [{'season_number': 2, 'episode_number': n, 'name': f'Серия {n}', 'air_date': date}
                                 for n, date in ((1, '2026-11-01'), (2, '2026-11-11'), (3, '2026-11-12'), (4, '2026-11-19'))]}
        if path.startswith('tv/1'):
            return {'name': 'Шоу', 'last_episode_to_air': {'season_number': 2}}
        raise AssertionError(path)

    def test_only_episodes_out_since_subscribing_are_sent_once(self):
        subscribed_ms = time.mktime((2026, 11, 10, 12, 0, 0, 0, 0, -1)) * 1000

        class Store:
            def site_state(self, user_id):
                return {'state': {'subscriptions': {'tmdb-tv-1': {'on': True, 'at': subscribed_ms}, 'tmdb-tv-9': {'on': False, 'at': 1}}}}

        self.notifier.add_device(7, {'endpoint': 'https://push.example/x', 'keys': {'p256dh': 'a', 'auth': 'b'}})
        with self.notifier.lock:
            self.notifier.db.execute('UPDATE devices SET created_at=?', (subscribed_ms / 1000,))
        notices = self.notifier.notices_for('tmdb-tv-1', '2026-11-10', '2026-11-12', {})
        self.assertEqual([n['key'] for n in notices], ['tmdb-tv-1:s2e2', 'tmdb-tv-1:s2e3'])
        self.assertEqual(notices[0]['body'], '2 сезон, 2 серия')


if __name__ == '__main__':
    unittest.main()
