const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
  let now=10000;const callbacks={};
  const context={window:{},performance:{now:()=>now},Date,Event,console,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync('app/watch-native.js','utf8'),context);
  const Room=context.window.CineVaultNativeRoom;
  const controls=[{disabled:false},{disabled:false}];
  const node=()=>({hidden:false,textContent:'',replaceChildren(){},append(){}});
  const nodes={};for(const key of ['end','role','members','follow','status','join'])nodes[key]=node();
  const root={querySelectorAll:()=>controls,querySelector:()=>null};
  const video={dataset:{},readyState:4,seeking:false,paused:false,currentTime:42,duration:1000,closest:()=>root,pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()}};
  const room=Object.create(Room.prototype);
  Object.assign(room,{video,root,roomStatus:{querySelector:q=>nodes[q.match(/\[data-(.*?)\]/)[1]]},joined:true,closed:false,seq:-1,session:'guest',season:0,episode:0,commandSeq:0,suppressUntil:0,receivedAt:now,onEpisodeChange:()=>{}});
  const snapshot={protocol:3,provider:'cinevault',seq:1,server_time:1000,anchor_at:1000,position:42,playing:false,desired_playing:false,generation:1,host_online:true,translation:'',participants:[{id:'guest',host:false,name:'Зритель',ready:true,online:true}]};
  context.document={createElement:()=>node()};
  return {room,video,controls,nodes,snapshot};
}
test('native guest gets paused and cannot use playback controls',()=>{
 const {room,video,controls,snapshot}=fixture();room.apply({state:snapshot});
 assert.equal(video.paused,true);assert.ok(controls.every(x=>x.disabled));assert.equal(room.isHost,false);
});
test('only host may send native commands',async()=>{
 const {room}=fixture();room.isHost=false;let calls=0;room.post=async()=>{calls++;return {}};
 await room.command('seek',{position:100});assert.equal(calls,0);
});
test('native leader remains enabled and participant controls lock on transfer',()=>{
 const {room,controls,snapshot}=fixture();snapshot.participants[0].host=true;room.apply({state:snapshot});assert.ok(controls.every(x=>!x.disabled));
 room.apply({state:{...snapshot,seq:2,server_time:1001,participants:[{...snapshot.participants[0],host:false}]}});assert.ok(controls.every(x=>x.disabled));
});
test('native buffering reports not ready and can resume after canplay',async()=>{
 const {room,snapshot}=fixture();room.state=snapshot;room.receivedAt=performance.now();room.waiting=true;let reports=[];
 room.post=async payload=>{reports.push(payload);return {state:snapshot}};
 await room.report();assert.equal(reports[0].ready,false);
 room.waiting=false;await room.report();assert.equal(reports[1].ready,true);
});
