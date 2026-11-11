"""Поведение общей временной шкалы и границ доверия, с управляемым временем."""
import json
import tempfile
import unittest
from pathlib import Path
from tools import watch_together as rooms
from tools.media_library_server import MediaLibrary


class TogetherTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        self.s, self.host = rooms.create({"title_id": "film", "translation": "66"}, self.now)
        self.tokens = {}
        self.join('host', True)
        self.join('guest')
        self.command_seq = 0

    def join(self, session, host=False):
        p = {"action": "join", "session": session, "host_token": self.host if host else "",
             "participant_token": self.tokens.get(session, "")}
        r = rooms.update(self.s, p, self.now)
        self.tokens[session] = r['participant_token']
        return r

    def update(self, who, **kwargs):
        return rooms.update(self.s, {"session": who, "participant_token": self.tokens[who],
                            "host_token": self.host if who == 'host' else '', **kwargs}, self.now)

    def ready(self, who, value=True, generation=None):
        return self.update(who, action='report', ready=value,
                           generation=self.s['generation'] if generation is None else generation)

    def command(self, command, **kwargs):
        self.command_seq += 1
        return self.update('host', action='command', command=command, command_seq=self.command_seq, **kwargs)

    def test_wait_for_all_and_manual_pause_wins(self):
        self.command('play')
        self.ready('host')
        self.assertFalse(self.s['playing'])
        self.ready('guest')
        self.assertTrue(self.s['playing'])
        self.now += 2
        self.ready('guest', False)
        self.assertFalse(self.s['playing'])
        self.assertEqual(self.s['position'], 2)
        self.command('pause')
        self.ready('guest')
        self.assertFalse(self.s['playing'])
        self.assertFalse(self.s['desired_playing'])

    def test_stale_readiness_and_duplicate_commands(self):
        self.command('seek', position=50)
        self.ready('host', generation=1)
        self.ready('guest', generation=1)
        self.assertFalse(self.s['_private']['participants']['host']['ready'])
        self.update('host', action='command', command='seek', position=5, command_seq=1)
        self.assertEqual(self.s['position'], 50)
        self.assertEqual(self.s['generation'], 2)

    def test_guest_cannot_control_or_impersonate(self):
        with self.assertRaises(PermissionError):
            self.update('guest', action='command', command='play', command_seq=1)
        with self.assertRaises(PermissionError):
            rooms.update(self.s, {"session": "host", "action": "report", "participant_token": self.tokens['guest']}, self.now)
        with self.assertRaises(PermissionError):
            rooms.update(self.s, {"session": "guest", "action": "join"}, self.now)

    def test_host_single_lease_and_recovery(self):
        with self.assertRaises(PermissionError):
            self.join('other-tab', True)
        self.now += rooms.HEARTBEAT_TIMEOUT + 1
        self.join('other-tab', True)
        self.assertNotIn('host', self.s['_private']['participants'])
        self.assertEqual(self.s['_private']['host_session'], 'other-tab')

    def test_host_loss_freezes_position(self):
        self.ready('host'); self.ready('guest'); self.command('play')
        self.now += rooms.HEARTBEAT_TIMEOUT + 1
        self.ready('guest')
        self.assertFalse(self.s['playing'])
        self.assertFalse(rooms.snapshot(self.s, self.now)['host_online'])
        frozen = self.s['position']
        self.now += 3
        rooms.snapshot(self.s, self.now)
        self.assertEqual(self.s['position'], frozen)

    def test_long_disconnection_does_not_skip_a_minute(self):
        self.ready('host'); self.ready('guest'); self.command('play')
        self.now += 90
        public = rooms.snapshot(self.s, self.now)
        self.assertFalse(public['playing'])
        self.assertEqual(public['position'], rooms.HEARTBEAT_TIMEOUT)

    def test_duplicate_tab_cannot_reuse_host_session(self):
        with self.assertRaises(PermissionError):
            rooms.update(self.s, {"action": "join", "session": "host", "instance": "different-tab", "host_token": self.host}, self.now)

    def test_different_edit_is_not_ready(self):
        self.update('host', action='report', generation=1, ready=True, duration=100)
        self.update('guest', action='report', generation=1, ready=True, duration=110)
        self.assertFalse(self.s['_private']['participants']['guest']['ready'])
        self.assertIn('Длительность', self.s['_private']['participants']['guest']['reason'])

    def test_late_join_does_not_stop_playback(self):
        self.ready('host'); self.ready('guest'); self.command('play')
        self.join('late')
        self.assertTrue(self.s['playing'])
        self.assertFalse(self.s['_private']['participants']['late']['required'])

    def test_exclusion_and_return(self):
        self.ready('host'); self.command('play')
        self.command('exclude', participant='guest')
        self.assertTrue(self.s['playing'])
        self.ready('guest', False)
        self.assertTrue(self.s['playing'])
        self.ready('guest')
        self.assertTrue(self.s['_private']['participants']['guest']['required'])

    def test_no_secrets_in_snapshot_and_expiry(self):
        public = rooms.snapshot(self.s, self.now)
        self.assertNotIn(self.host, json.dumps(public))
        self.assertNotIn(self.tokens['host'], json.dumps(public))
        self.now += rooms.ROOM_TTL
        self.assertTrue(rooms.snapshot(self.s, self.now)['ended'])
        self.assertEqual(rooms.snapshot(self.s, self.now)['participants'], [])

    def test_invalid_position(self):
        with self.assertRaises(ValueError): self.command('seek', position=float('nan'))
        with self.assertRaises(ValueError): self.command('seek', position=-1)

    def test_storage_restart_keeps_host_secret_private(self):
        with tempfile.TemporaryDirectory() as directory:
            lib = MediaLibrary(Path(directory), transcode=False)
            room = lib.create_room(payload={"protocol": 2, "provider": "alloha", "title_id": "film", "target_key": "film"})
            key = room['host_token']; room_id = room['room_id']
            lib.close()
            lib = MediaLibrary(Path(directory), transcode=False)
            try:
                self.assertNotIn(key, json.dumps(lib.get_room(room_id)))
                self.assertIn('participant_token', lib.update_room(room_id, {"action": "join", "session": "new", "host_token": key}))
                with self.assertRaises(PermissionError):
                    lib.update_room(room_id, {"position": 42})
            finally: lib.close()


if __name__ == '__main__': unittest.main()


class IframeModeTests(unittest.TestCase):
    join = TogetherTests.join
    update = TogetherTests.update
    ready = TogetherTests.ready
    command = TogetherTests.command
    def setUp(self):
        TogetherTests.setUp(self)
        self.s['sync_mode'] = 'iframe'

    def test_play_does_not_wait_for_unknown_buffer(self):
        self.command('play')
        self.assertTrue(self.s['playing'])
        self.assertFalse(self.s['_private']['participants']['guest']['ready'])

    def test_forward_backward_seek_preserves_play_intent(self):
        self.command('play')
        self.command('seek', position=1437)
        self.assertTrue(self.s['playing'])
        self.command('seek', position=1430)
        self.assertTrue(self.s['playing'])
        self.assertEqual(self.s['position'], 1430)

    def test_paused_seek_does_not_start_playback(self):
        self.command('pause')
        self.command('seek', position=1430)
        self.assertFalse(self.s['playing'])
        self.ready('guest')
        self.assertFalse(self.s['playing'])

    def test_report_distinguishes_contact_from_video_sample(self):
        self.update('guest', action='report', ready=False, generation=1, position=829, telemetry_age=20)
        p=next(p for p in rooms.snapshot(self.s, self.now)['participants'] if p['id']=='guest')
        self.assertEqual(p['reported_at'], self.now)
        self.assertEqual(p['position_at'], self.now-20)

    def test_lagging_viewer_pauses_everyone_then_is_let_go(self):
        self.command('play')
        self.ready('host'); self.ready('guest')
        self.assertTrue(self.s['playing'])
        self.ready('guest', False)
        self.now += 2
        self.ready('host'); self.ready('guest', False)
        self.assertTrue(self.s['playing'])
        self.now += 3
        self.ready('host'); self.ready('guest', False)
        self.assertFalse(self.s['playing'])
        self.assertTrue(self.s['desired_playing'])
        self.assertEqual(rooms.snapshot(self.s, self.now)['waiting_for'], ['Зритель 2'])
        self.ready('guest')
        self.assertTrue(self.s['playing'])
        self.ready('guest', False)
        self.now += 50
        self.ready('host'); self.ready('guest', False)
        self.assertTrue(self.s['playing'])

    def test_paused_room_does_not_count_anyone_as_behind(self):
        self.command('pause')
        self.ready('guest', False)
        self.now += 10
        self.ready('host'); self.ready('guest', False)
        self.assertEqual(rooms.snapshot(self.s, self.now)['waiting_for'], [])

    def test_countdown_starts_everyone_at_one_moment(self):
        self.command('play', position=30, countdown=True)
        self.assertTrue(self.s['desired_playing'])
        self.assertEqual(self.s['anchor_at'], self.now + rooms.COUNTDOWN)
        self.assertEqual(rooms.position(self.s, self.now + 1), 30)
        self.assertEqual(rooms.position(self.s, self.now + rooms.COUNTDOWN + 2), 32)

    def test_handover_moves_the_remote(self):
        old_secret = self.host
        self.command('handover', participant='guest')
        snapshot = rooms.snapshot(self.s, self.now)
        self.assertEqual([p['id'] for p in snapshot['participants'] if p['host']], ['guest'])
        with self.assertRaises(PermissionError):
            self.command('pause')
        result = self.update('guest', action='report', ready=True, generation=self.s['generation'], instance='')
        self.assertIn('host_token', result)
        self.assertNotEqual(result['host_token'], old_secret)
        self.host = result['host_token']
        self.assertNotIn('host_token', self.update('guest', action='report', ready=True, generation=self.s['generation'], host_token=self.host))
        self.update('guest', action='command', command='pause', command_seq=50, host_token=self.host)
        self.assertFalse(self.s['desired_playing'])
        self.assertNotIn('pending_host', json.dumps(snapshot))

    def test_player_without_any_video_events_is_never_waited_for(self):
        self.command('play')
        self.update('guest', action='report', ready=False, sampled=False, generation=self.s['generation'])
        self.now += 10
        self.ready('host')
        self.update('guest', action='report', ready=False, sampled=False, generation=self.s['generation'])
        self.assertTrue(self.s['playing'])
