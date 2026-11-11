import io
import json
import unittest
from unittest.mock import patch, Mock
from tools.alloha_direct import client_ip, media_url, normalize, resolve, DirectSourceError


class DirectTests(unittest.TestCase):
    def test_response_keeps_default_audio_and_valid_qualities(self):
        result = normalize({'data':{'file':{'hlsSource':[{'quality':{'360':'https://cdn.example/low.m3u8'}},
            {'default':True,'quality':{'1080':'https://cdn.example/high.m3u8','720':'http://cdn.example/unsafe.m3u8'}}]}}}, '66')
        self.assertEqual([v['quality'] for v in result['variants']], ['1080'])
        self.assertEqual(result['verification'], 'provider-response-only')

    def test_unsafe_and_non_media_response_are_rejected(self):
        for value in ['javascript:alert(1)', 'https://127.0.0.1/a', 'https://user:pass@cdn.example/a', 'https://localhost/a']:
            self.assertIsNone(media_url(value))
        with self.assertRaises(DirectSourceError):
            normalize({'data':{'file':{'hlsSource':[]}}}, '66')

    def test_proxy_chain_ignores_spoofed_leftmost_ip(self):
        self.assertEqual(client_ip('172.18.0.2', '1.1.1.1, 8.8.8.8', '172.18.0.0/16'), '8.8.8.8')
        self.assertEqual(client_ip('8.8.8.8', '1.1.1.1', ''), '8.8.8.8')
        with self.assertRaises(DirectSourceError):
            client_ip('127.0.0.1', '', '')

    @patch.dict('os.environ', {'CINEVAULT_ALLOHA_DIRECT_API_URL':'https://provider.example/direct', 'CINEVAULT_ALLOHA_DIRECT_SECRET':'private-fixture-secret'})
    def test_server_side_secret_is_not_in_result_and_redirects_disabled(self):
        response = Mock(status_code=200)
        response.raw.read.return_value = json.dumps({'data':{'file':{'hlsSource':[{'quality':{'720':'https://cdn.example/720.m3u8'}}]}}}).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        session = Mock()
        session.get.return_value = response
        result = resolve({'id':'66','embedUrl':'https://theatre.stravers.live/?token_movie=fixture'}, '8.8.8.8', session=session)
        self.assertNotIn('private-fixture-secret', str(result))
        self.assertFalse(session.get.call_args.kwargs['allow_redirects'])
        self.assertEqual(session.get.call_args.kwargs['params']['ip'], '8.8.8.8')

    @patch.dict('os.environ', {'CINEVAULT_ALLOHA_DIRECT_API_URL':'', 'CINEVAULT_ALLOHA_DIRECT_SECRET':''})
    def test_missing_access_is_explicit_without_network(self):
        with self.assertRaises(DirectSourceError) as error:
            resolve({}, '8.8.8.8')
        self.assertEqual(error.exception.status, 503)
