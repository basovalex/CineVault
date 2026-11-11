import json
import tempfile
import unittest
from pathlib import Path
from tools.accounts import AccountError
from tools.media_library_server import MediaLibrary


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.library = MediaLibrary(Path(self.directory.name), transcode=False)
        self.store = self.library.accounts
        self.time = 1000000
        self.store.clock = lambda: self.time
        self.sasha, self.token = self.store.register({'username':'sasha','display_name':'Саша','password':'example-password-1'})
        self.maria, self.mtoken = self.store.register({'username':'maria','display_name':'Марияша','password':'example-password-2'})
        self.sid, self.mid = self.sasha['user']['id'], self.maria['user']['id']
        self.solo = self.store.context_for([self.sid])['id']

    def tearDown(self):
        self.library.close()
        self.directory.cleanup()

    def progress(self, **extra):
        return {'title_id':'film','season':0,'episode':0,'edition':'alloha:66','position':100,'duration':1000,
                'expected_revision':0,'operation_id':'op1', **extra}

    def test_passwords_and_session_tokens_are_hashed(self):
        row = self.library._db.execute('SELECT * FROM account_users WHERE id=?',(self.sid,)).fetchone()
        self.assertNotIn('example-password', row['password_hash'])
        self.assertNotEqual(row['recovery_hash'],self.sasha['recovery_code'])
        saved = self.library._db.execute('SELECT * FROM account_sessions WHERE user_id=?',(self.sid,)).fetchone()
        self.assertNotEqual(saved['token_hash'],self.token)
        self.assertEqual(self.store.authenticate(self.token)['id'],self.sid)
        self.assertIsNone(self.store.authenticate('not-a-token'))

    def test_second_device_login_and_expiry(self):
        result, token = self.store.login({'username':'SASHA','password':'example-password-1'})
        self.assertEqual(self.store.authenticate(token)['id'],self.sid)
        self.assertIsNotNone(self.store.authenticate(self.token))
        self.time += 31*86400
        self.assertIsNone(self.store.authenticate(token))

    def test_recovery_invalidates_sessions_and_rotates_code(self):
        result, token = self.store.recover({'username':'sasha','recovery_code':self.sasha['recovery_code'],'new_password':'new-example-password'})
        self.assertIsNone(self.store.authenticate(self.token))
        self.assertIsNotNone(self.store.authenticate(token))
        with self.assertRaises(AccountError):
            self.store.recover({'username':'sasha','recovery_code':self.sasha['recovery_code'],'new_password':'other-example-password'})

    def test_context_order_and_solo_shared_separation(self):
        first = self.store.context_for([self.sid,self.mid])['id']
        self.assertEqual(first,self.store.context_for([self.mid,self.sid,self.mid])['id'])
        self.store.write_progress(self.sid,self.solo,self.progress(position=23*60+50,duration=6000))
        self.store.claim_room(self.sid,first,'room1')
        self.store.write_progress(self.sid,first,self.progress(position=48*60+12,duration=6000),room_id='room1')
        self.assertEqual(self.store.get_progress(self.sid,self.solo,self.progress())['position'],1430)
        self.assertEqual(self.store.get_progress(self.mid,first,self.progress())['position'],2892)
        with self.assertRaises(AccountError):
            self.store.write_progress(self.sid,first,self.progress(expected_revision=1,operation_id='op2'))

    def test_outsider_cannot_read_or_write(self):
        with self.assertRaises(AccountError):self.store.history(self.mid,self.solo)
        with self.assertRaises(AccountError):self.store.write_progress(self.mid,self.solo,self.progress())
        with self.assertRaises(AccountError):self.store.get_progress(self.mid,self.solo,self.progress())

    def test_stale_offline_write_and_duplicate_operation(self):
        first = self.store.write_progress(self.sid,self.solo,self.progress())
        again = self.store.write_progress(self.sid,self.solo,self.progress())
        self.assertEqual(first['revision'],again['revision'])
        with self.assertRaises(AccountError):self.store.write_progress(self.sid,self.solo,self.progress(position=200))
        with self.assertRaises(AccountError):self.store.write_progress(self.sid,self.solo,self.progress(operation_id='offline-old',position=200))
        result=self.store.write_progress(self.sid,self.solo,self.progress(expected_revision=1,operation_id='new',position=200))
        self.assertEqual(result['revision'],2)

    def test_invitation_consent_and_single_recipient(self):
        token = self.store.invite(self.sid)
        self.assertEqual(self.store.peek_invite(token)['display_name'],'Саша')
        cid = self.store.accept_invite(self.mid,token)
        self.assertEqual(cid,self.store.context_for([self.sid,self.mid])['id'])
        self.assertEqual(self.store.contexts(self.mid)[1]['label'],'Вместе: Саша')
        another,_ = self.store.register({'username':'another','display_name':'Другой','password':'example-password-3'})
        with self.assertRaises(AccountError):self.store.accept_invite(another['user']['id'],token)

    def test_same_context_cannot_have_two_active_rooms(self):
        cid=self.store.context_for([self.sid,self.mid])['id']
        self.store.claim_room(self.sid,cid,'first')
        with self.assertRaises(AccountError):self.store.claim_room(self.mid,cid,'second')
        self.time += 16
        self.store.claim_room(self.mid,cid,'second')
        with self.assertRaises(AccountError):self.store.write_progress(self.sid,cid,self.progress(),room_id='first')

    def test_hide_shared_history_does_not_delete_for_partner(self):
        cid=self.store.context_for([self.sid,self.mid])['id'];self.store.claim_room(self.sid,cid,'r')
        self.store.write_progress(self.sid,cid,self.progress(),room_id='r')
        self.store.hide_history(self.sid,cid,'film')
        self.assertEqual(self.store.history(self.sid,cid),[])
        self.assertEqual(len(self.store.history(self.mid,cid)),1)

    def test_delete_account_preserves_partner_progress_anonymously(self):
        cid=self.store.context_for([self.sid,self.mid])['id'];self.store.claim_room(self.sid,cid,'r')
        self.store.write_progress(self.sid,cid,self.progress(),room_id='r')
        self.store.delete(self.store.authenticate(self.token),'example-password-1')
        self.assertIsNone(self.store.authenticate(self.token))
        self.assertEqual(len(self.store.history(self.mid,cid)),1)
        names=[m['display_name'] for c in self.store.contexts(self.mid) for m in c['members']]
        self.assertIn('Удалённый участник',names)
        self.assertNotIn('Саша',names)

    def test_progress_persists_and_does_not_import_anonymous_history(self):
        self.assertEqual(self.store.history(self.sid),[])
        self.store.write_progress(self.sid,self.solo,self.progress())
        self.library.close()
        self.library=MediaLibrary(Path(self.directory.name),transcode=False)
        self.assertEqual(self.library.accounts.get_progress(self.sid,self.solo,self.progress())['position'],100)

    def test_rate_limit(self):
        for _ in range(10):
            with self.assertRaises(AccountError):self.store.login({'username':'sasha','password':'wrong'},ip='other')
        with self.assertRaises(AccountError) as error:self.store.login({'username':'sasha','password':'example-password-1'},ip='other')
        self.assertEqual(error.exception.status,429)


if __name__ == '__main__':unittest.main()

class AccountRoomTests(unittest.TestCase):
    setUp = AccountTests.setUp
    tearDown = AccountTests.tearDown
    def room(self):
        return self.library.create_room(payload={'protocol':3,'provider':'alloha','title_id':'film','target_key':'film','translation':'66'},actor=self.store.authenticate(self.token))

    def test_native_room_restricts_controls_and_waits_for_viewer(self):
        a=self.store.authenticate(self.token); b=self.store.authenticate(self.mtoken)
        room=self.library.create_room(payload={'protocol':3,'provider':'cinevault','title_id':'film','target_key':'film','position':42,'playing':True},actor=a)
        uid=room['room_id']; secret=room['host_token']
        self.assertEqual(room['state']['provider'],'cinevault')
        host=self.library.update_room(uid,{'action':'join','session':'host','instance':'one','host_token':secret,'consent':True},actor=a)
        guest=self.library.update_room(uid,{'action':'join','session':'guest','instance':'two','consent':True},actor=b)
        with self.assertRaises(PermissionError):
            self.library.update_room(uid,{'action':'command','session':'guest','participant_token':guest['participant_token'],'command':'seek','command_seq':1,'position':100},actor=b)
        for actor,session,token in ((a,'host',host['participant_token']),(b,'guest',guest['participant_token'])):
            state=self.library.update_room(uid,{'action':'report','session':session,'instance':'one' if session=='host' else 'two','participant_token':token,'host_token':secret if session=='host' else '', 'generation':1,'ready':True,'position':42,'duration':1000},actor=actor)['state']
        self.assertTrue(state['playing'])
        state=self.library.update_room(uid,{'action':'report','session':'guest','participant_token':guest['participant_token'],'generation':1,'ready':False,'position':42,'duration':1000},actor=b)['state']
        self.assertFalse(state['playing'])
        self.assertTrue(state['desired_playing'])

    def test_authenticated_room_identity_is_server_bound(self):
        room=self.room();uid=room['room_id'];a=self.store.authenticate(self.token);b=self.store.authenticate(self.mtoken)
        host=self.library.update_room(uid,{'action':'join','session':'host','instance':'one','host_token':room['host_token'],'consent':True},actor=a)
        with self.assertRaises(PermissionError):
            self.library.update_room(uid,{'action':'join','session':'other','instance':'two','host_token':room['host_token'],'consent':True},actor=b)
        with self.assertRaises(AccountError):
            self.library.update_room(uid,{'action':'report','session':'host','participant_token':host['participant_token'],'host_token':room['host_token'],'instance':'one','_account':a},actor=None)

    def test_room_creates_stable_shared_context_after_both_consent(self):
        room=self.room();uid=room['room_id'];a=self.store.authenticate(self.token);b=self.store.authenticate(self.mtoken)
        self.library.update_room(uid,{'action':'join','session':'host','instance':'one','host_token':room['host_token'],'consent':True},actor=a)
        with self.assertRaises(ValueError):self.library.update_room(uid,{'action':'join','session':'guest'},actor=b)
        joined=self.library.update_room(uid,{'action':'join','session':'guest','consent':True},actor=b)
        self.assertEqual(joined['state']['context_id'],self.store.context_for([a['id'],b['id']])['id'])
        names=[p['name'] for p in joined['state']['participants']]
        self.assertEqual(set(names),{'Саша','Марияша'})
        self.assertEqual(self.store.history(self.sid),[])

class AccountLeaseTests(unittest.TestCase):
    setUp = AccountTests.setUp
    tearDown = AccountTests.tearDown
    def test_explicit_owner_takeover_revokes_old_tab(self):
        a=self.store.authenticate(self.token)
        room=self.library.create_room(payload={'protocol':3,'provider':'alloha','title_id':'film','target_key':'film','translation':'66','sync_mode':'iframe'},actor=a)
        base={'action':'join','host_token':room['host_token'],'consent':True}
        first=self.library.update_room(room['room_id'],{**base,'session':'one','instance':'first'},actor=a)
        second=self.library.update_room(room['room_id'],{**base,'session':'two','instance':'second','takeover':True},actor=a)
        self.assertTrue(next(p for p in second['state']['participants'] if p['id']=='two')['host'])
        with self.assertRaises(PermissionError):
            self.library.update_room(room['room_id'],{'action':'report','session':'one','instance':'first','host_token':room['host_token'],'participant_token':first['participant_token'],'generation':1},actor=a)
