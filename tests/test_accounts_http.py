"""Проверки реального HTTP-периметра аккаунтов, без браузерных заглушек."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from tools.media_library_server import MediaLibrary, MediaLibraryHandler


class AccountHTTPTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.library = MediaLibrary(Path(self.directory.name), transcode=False)
        handler = lambda *a, **kw: MediaLibraryHandler(*a, directory=self.directory.name, **kw)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.server.library = self.library
        self.server.viewer_token = ''
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.library.close()
        self.directory.cleanup()

    def request(self, path, body=None, headers=None):
        h = {'Content-Type':'application/json', **(headers or {})}
        request = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=h)
        try:
            response = self.opener.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        return response.code, json.load(response), response.headers

    def register(self):
        status, result, headers = self.request('/api/account/register', {'username':'fixture','display_name':'Тест','password':'test-fixture-password'}, {'X-Forwarded-Proto':'https'})
        self.assertEqual(status, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('Secure', headers['Set-Cookie'])
        self.assertIn('SameSite=Lax', headers['Set-Cookie'])
        self.assertEqual(headers['Cache-Control'], 'no-store')
        return result, {'Cookie':headers['Set-Cookie'].split(';')[0], 'X-CineVault-CSRF':result['csrf']}

    def test_session_csrf_and_logout(self):
        result, headers = self.register()
        status, session, _ = self.request('/api/account/session', headers=headers)
        self.assertEqual(session['user']['id'], result['user']['id'])
        status, _, _ = self.request('/api/account/logout', {}, {'Cookie':headers['Cookie']})
        self.assertEqual(status, 403)
        status, _, _ = self.request('/api/account/logout', {}, headers)
        self.assertEqual(status, 200)
        status, session, _ = self.request('/api/account/session', headers=headers)
        self.assertIsNone(session['user'])

    def test_cross_origin_and_content_type(self):
        _, headers = self.register()
        status, _, _ = self.request('/api/account/invitation', {}, {**headers, 'Origin':'https://evil.example'})
        self.assertEqual(status, 403)
        status, _, _ = self.request('/api/account/invitation', {}, {**headers, 'Sec-Fetch-Site':'cross-site'})
        self.assertEqual(status, 403)
        status, _, _ = self.request('/api/account/invitation', {}, {**headers, 'Content-Type':'text/plain'})
        self.assertEqual(status, 415)

    def test_viewer_perimeter_remains_required(self):
        self.server.viewer_token = 'fixture-viewer'
        status, _, _ = self.request('/api/account/session')
        self.assertEqual(status, 401)
        status, _, _ = self.request('/api/account/session', headers={'Authorization':'Bearer fixture-viewer'})
        self.assertEqual(status, 200)

    def test_anonymous_cannot_read_history_or_create_account_room(self):
        self.assertEqual(self.request('/api/account/history')[0], 401)
        self.assertEqual(self.request('/api/watch/rooms', {'protocol':3,'provider':'alloha','title_id':'film','translation':'66'})[0], 401)
