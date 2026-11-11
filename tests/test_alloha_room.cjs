const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function client(){
  let clock=10000,id=0;const timers=new Map();
  const context={window:{},performance:{now:()=>clock},console,setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(fs.readFileSync('app/watch-together.js','utf8'),context);
  const room=Object.create(context.window.CineVaultAllohaRoom.prototype),sent=[],commands=[];
  Object.assign(room,{closed:false,ended:false,playing:true,position:100,seq:1,generation:1,receivedAt:clock,isHost:true,session:'h',echoes:[],following:true,
    commandSeq:0,lastCorrection:0,lastTelemetry:clock,state:{protocol:3,sync_mode:'iframe',seq:1,generation:1,position:100,anchor_at:1000,server_time:1000,playing:true,desired_playing:true,translation:'66',season:0,episode:0,participants:[{id:'h',host:true}]},
    frame:()=>({contentWindow:{postMessage:message=>sent.push(JSON.parse(message))}}),
    command:(...a)=>{commands.push(a);return Promise.resolve()},content:()=>({translation:'66',season:0,episode:0}),render:()=>{},message:()=>{},onRole:()=>{}});
  return {room,sent,commands,advance:ms=>{clock+=ms},flush:()=>{const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn())}};
}
test('обычная пауза ведущего передаётся один раз; echo программной паузы не публикуется',()=>{
  const {room,commands,flush}=client();room.onMessage({event:'pause',time:100});flush();assert.equal(commands.length,1);assert.equal(commands[0][0],'pause');
  room.send('pause');room.onMessage({event:'pause',time:100});flush();assert.equal(commands.length,1);
});
test('быстрые перемотки объединяются в конечную; pause при seek не отменяет play-намерение',()=>{
  const {room,commands,flush}=client();room.onMessage({event:'pause',time:100});room.onMessage({event:'seek',time:1437});room.onMessage({event:'seek',time:1430});flush();
  assert.equal(commands.length,1);assert.equal(commands[0][0],'seek');assert.equal(commands[0][1].position,1430);
});
test('снимок новой перемотки не запускает prepare или паузу ведущего',()=>{
  const {room,sent}=client();room.apply({state:{...room.state,seq:2,generation:2,position:1430}});assert.equal(sent.length,0);assert.equal(room.generation,2);
});
test('локальная пауза зрителя не отматывается автоматикой и не публикуется как общая',()=>{
  const {room,sent,commands}=client();room.isHost=false;room.onMessage({event:'pause',time:100});room.synchronize(true);
  assert.equal(room.following,false);assert.equal(commands.length,0);assert.equal(sent.length,0);
});
test('программный seek не мешает другой ручной перемотке в тот же момент',()=>{
  const {room,commands,flush}=client();room.send('seek',120);room.onMessage({event:'seek',time:120});room.onMessage({event:'seek',time:250});flush();assert.equal(commands.length,1);assert.equal(commands[0][1].position,250);
});
test('новая позиция гостя применяется без промежуточной паузы и ручной подготовки',()=>{
  const {room,sent}=client();room.isHost=false;room.session='g';room.apply({state:{...room.state,seq:2,generation:2,position:1430,participants:[{id:'g',host:false}]}});
  assert.deepEqual(sent.map(x=>x.api),['seek','play']);assert.equal(sent[0].value,1430);
});
test('старый снимок не отменяет новую перемотку',()=>{const {room,sent}=client();room.seq=10;room.apply({state:{...room.state,seq:9,position:0}});assert.equal(room.seq,10);assert.equal(sent.length,0)});
test('оценка позиции использует монотонное время',()=>{const {room,advance}=client();room.state.server_time=1001;advance(1500);assert.equal(room.target(),102.5)});
test('события загрузки гостя до первой синхронизации не объявляются его ручной паузой',()=>{
  const {room,commands}=client();room.isHost=false;room.bootstrap=true;room.onMessage({event:'pause',time:0});assert.equal(room.following,true);assert.equal(commands.length,0);
});
test('свежее видео у позиции комнаты завершает первоначальное выравнивание',()=>{
  const {room}=client();room.isHost=false;room.bootstrap=true;room.onMessage({event:'timeupdate',time:100});assert.equal(room.bootstrap,false);assert.equal(room.following,true);
});
test('пауза Alloha в ответ на программный seek зрителя сохраняет следование и восстанавливает play один раз',()=>{
 const {room,sent}=client();room.isHost=false;room.send('seek',1430);room.onMessage({event:'pause',time:1430});
 assert.equal(room.following,true);assert.deepEqual(sent.map(x=>x.api),['seek','play']);
 room.onMessage({event:'pause',time:1430});assert.equal(sent.length,2);
});
test('поздний pause после seek не включает видео при новой общей ручной паузе',()=>{
 const {room,sent}=client();room.isHost=false;room.send('seek',1430);room.state.playing=false;room.onMessage({event:'pause',time:1430});assert.deepEqual(sent.map(x=>x.api),['seek']);
});
test('зритель с другой длительностью получает паузу и не считается синхронным',()=>{
 const {room,sent}=client();room.session='g';room.isHost=false;
 room.apply({state:{...room.state,seq:2,participants:[{id:'g',host:false,reason:'Длительность видео отличается от версии ведущего'}]}});
 assert.equal(room.versionMismatch,true);assert.equal(room.following,false);assert.deepEqual(sent.map(x=>x.api),['pause']);
});
test('смена озвучки ведущим сохраняет позицию и не публикует паузу загрузки',()=>{
 const {room,sent,commands}=client();
 room.loadContent=()=>{};
 room.apply({state:{...room.state,seq:2,generation:2,translation:'63',position:100}});
 room.sourceLoaded();
 assert.deepEqual(sent.map(x=>x.api),['seek','play']);
 room.onMessage({event:'pause',time:0});
 assert.equal(commands.length,0);
 room.onMessage({event:'seek',time:100});
 assert.equal(room.hostSourceSync,null);
 assert.equal(commands.length,0);
});
test('состояние комнаты поступает через поток событий без ожидания опроса',()=>{
 let opened;
 class Events {constructor(url){this.url=url;opened=this;} close(){this.closed=true;}}
 const context={window:{EventSource:Events},performance:{now:()=>0},console,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync('app/watch-together.js','utf8'),context);
 const room=Object.create(context.window.CineVaultAllohaRoom.prototype);let received;
 Object.assign(room,{closed:false,roomId:'abc',apply:data=>{received=data;}});
 room.connectEvents();opened.onmessage({data:JSON.stringify({state:{seq:5}})});
 assert.equal(opened.url,'/api/watch/rooms/abc/events');assert.equal(received.state.seq,5);
});
