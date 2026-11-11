/* Alloha iframe: синхронизация команд, без обещаний контроля буфера.
   Поля ready/position обозначают наблюдение событий, а не canplay. */
(() => {
  'use strict';
  const ORIGIN = 'https://theatre.stravers.live';
  const timecode = value => { const n=Math.max(0,Math.floor(Number(value)||0)); return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`; };
  const messagePayload = value => {
    let payload=value;
    for(let depth=0;depth<3;depth++){
      if(typeof payload==='string'){try{payload=JSON.parse(payload);continue;}catch{return null;}}
      if(!payload||typeof payload!=='object')return null;
      if(payload.event||payload.api)return payload;
      payload=payload.data??payload.detail??payload.message;
    }
    return payload&&typeof payload==='object'?payload:null;
  };
  const seconds = value => {
    if(Number.isFinite(Number(value)))return Number(value);
    if(typeof value!=='string')return NaN;
    const parts=value.trim().split(':');
    if(parts.length<2||parts.length>3||parts.some(part=>!/^\d+(\.\d+)?$/.test(part)))return NaN;
    return parts.map(Number).reduce((total,part)=>total*60+part,0);
  };
  const normalizeMessage = value => {
    const payload=messagePayload(value);
    if(!payload)return null;
    const aliases={time:'timeupdate',playing:'play',paused:'pause',seeked:'seek'};
    const event=aliases[payload.event]||payload.event;
    if(typeof event!=='string')return payload;
    const time=seconds(payload.time??payload.currentTime??payload.value);
    return Number.isFinite(time)?{...payload,event,time}:payload;
  };
  class AllohaRoom {
    constructor(options) {
      Object.assign(this, {onRole:()=>{}, initialPosition:0, initialPlaying:false, protocol:2}, options);
      this.instance=crypto.randomUUID(); this.storageKey=`cinevault.room.${this.roomId}.participant`;
      let saved={};try{saved=JSON.parse(sessionStorage.getItem(this.storageKey)||'{}');}catch{}
      this.session=saved.session||crypto.randomUUID();this.token=saved.token||'';
      this.hostToken=this.readSecret();this.isHost=!!this.hostToken;
      this.position=this.initialPosition;this.playing=this.initialPlaying;this.duration=0;
      this.seq=-1;this.generation=-1;this.commandSeq=0;this.corrections=0;
      this.echoes=[];this.bootstrap=true;this.following=true;this.closed=false;this.joined=false;this.pending=false;
      this.lastContact=performance.now();this.receivedAt=performance.now();this.lastTelemetry=null;
      this.commandTail=Promise.resolve();this.startedAt=performance.now();this.lastCorrection=0;
      this.renderShell();this.tickTimer=setInterval(()=>this.tick(),1000);
      // Создание комнаты — согласие ведущего; зритель подтверждает отдельно.
      if(this.isHost)this.join();
    }
    readSecret(){try{return localStorage.getItem(`cinevault.room.${this.roomId}.host`)||'';}catch{return '';}}
    async post(payload){
      const sentAt=performance.now();const headers={'content-type':'application/json'};
      if(this.protocol===3&&window.CineVaultAccounts?.csrf)headers['X-CineVault-CSRF']=window.CineVaultAccounts.csrf;
      const result=await this.request(`/api/watch/rooms/${encodeURIComponent(this.roomId)}`,{method:'POST',headers,
        body:JSON.stringify({session:this.session,instance:this.instance,host_token:this.hostToken,participant_token:this.token,...payload}),signal:AbortSignal.timeout(7000)});
      const data=await result.json();if(!result.ok){const e=new Error(data.error||`HTTP ${result.status}`);e.status=result.status;throw e;}
      this.lastContact=performance.now();if(data.state)data.state.server_time+=(performance.now()-sentAt)/2000;return data;
    }
    send(api,value){
      const event={play:'play',pause:'pause',seek:'seek'}[api];
      if(api==='seek')this.remoteSeek={target:value,until:performance.now()+8000,resumed:false,firstTime:null};
      if(event){this.echoes=this.echoes.filter(e=>e.until>performance.now());this.echoes.push({event,value,until:performance.now()+1500});}
      this.frame()?.contentWindow?.postMessage(JSON.stringify(value===undefined?{api}:{api,value}),ORIGIN);
    }
    consumeEcho(payload){
      this.echoes=this.echoes.filter(e=>e.until>performance.now());
      const i=this.echoes.findIndex(e=>e.event===payload.event&&(e.event!=='seek'||Math.abs(Number(payload.time)-e.value)<1));
      if(i<0)return false;this.echoes.splice(i,1);return true;
    }
    message(text){const el=this.panel.querySelector('[data-status]');if(el.textContent!==text)el.textContent=text;}
    renderShell(){
      this.panel.hidden=false;
      this.panel.innerHTML=`<header class="together-heading"><strong data-role>Смотрим вместе</strong><span data-clock class="together-clock"></span></header>
        <p data-status role="status">${this.isHost?'Подключаюсь…':'Подтвердите участие. Совместная история доступна участникам комнаты.'}</p>
        <div data-members class="together-members"></div><div class="together-actions">
        <button type="button" data-join>${this.isHost?'Повторить подключение':'Присоединиться и смотреть'}</button>
        <button type="button" data-takeover hidden>Восстановить управление здесь</button>
        <button type="button" data-follow hidden>Вернуться к ведущему</button>
        <button type="button" data-copy>Пригласить</button><button type="button" data-leave>Продолжить одному</button></div>
        <details data-host-menu hidden><summary>Действия ведущего</summary>
        ${this.item.kind==='series'?'<div class="together-series"><label>Сезон<input data-season type="number" min="1" max="1000" value="1"></label><label>Серия<input data-episode type="number" min="1" max="10000" value="1"></label><button type="button" data-content>Открыть серию у всех</button></div>':''}
        <button type="button" data-end>Завершить комнату для всех</button></details>
        <p data-progress class="together-progress" role="status"></p>
        <label data-link-label hidden>Приглашение<input data-link readonly></label>
        <p class="together-limit">Управляйте просмотром кнопками Alloha. В режиме iframe зритель тоже может нажать паузу или перемотать у себя. Буферизация не определяется: ведущий может поставить общую паузу, пока другой участник загружается.</p>`;
      const bind=(key,fn)=>this.panel.querySelector(`[data-${key}]`)?.addEventListener('click',()=>Promise.resolve().then(fn).catch(e=>this.message(e.message)));
      bind('join',()=>this.join());
      bind('takeover',()=>this.join(true));
      bind('follow',()=>{if(this.versionMismatch)return;this.following=true;this.needsGesture=false;this.synchronize(true);this.render(this.state);});
      bind('copy',async()=>{const url=this.shareLink(this.roomId);try{await navigator.clipboard.writeText(url);this.message('Приглашение скопировано.');}catch{this.panel.querySelector('[data-link-label]').hidden=false;this.panel.querySelector('[data-link]').value=url;}});
      bind('leave',async()=>{await this.leave();this.onLeave();});
      bind('end',()=>this.command('end'));
      bind('content',()=>{const season=Number(this.panel.querySelector('[data-season]').value),episode=Number(this.panel.querySelector('[data-episode]').value);
        if(!Number.isInteger(season)||season<1||!Number.isInteger(episode)||episode<1)throw new Error('Укажите сезон и серию, начиная с 1.');
        return this.command('content',{season,episode,translation:this.state.translation,position:0});});
    }
    async join(takeover=false){
      if(this.closed||this.pending)return;
      if(this.protocol===3&&!await window.CineVaultAccounts?.requireLogin())return;
      this.pending=true;
      try{const data=await this.post({action:'join',consent:true,sync_mode:'iframe',takeover});if(this.closed)return;
        this.token=data.participant_token;this.joined=true;this.error='';this.panel.querySelector('[data-takeover]').hidden=true;
        try{sessionStorage.setItem(this.storageKey,JSON.stringify({session:this.session,token:this.token}));}catch{}
        this.apply(data);if(!this.isHost)this.following=true;this.connectEvents();
      }catch(e){this.error=e.message;const duplicate=e.status===403&&this.isHost&&e.message.includes('другой вкладке');this.panel.querySelector('[data-takeover]').hidden=!duplicate;this.message(duplicate?`${e.message}. Можно перенести управление сюда; другая вкладка потеряет роль ведущего.`:e.message);}
      finally{this.pending=false;this.panel.querySelector('[data-join]').hidden=this.joined;}
    }
    connectEvents(){
      if(this.events||!window.EventSource||this.closed)return;
      const events=new window.EventSource(`/api/watch/rooms/${encodeURIComponent(this.roomId)}/events`);
      this.events=events;
      events.onmessage=event=>{try{this.apply(JSON.parse(event.data));}catch{}};
      // The regular heartbeat is also a polling fallback during reconnects.
    }
    target(s=this.state){if(!s)return this.position;return Math.max(0,s.position+(s.playing?Math.max(0,s.server_time-s.anchor_at+(performance.now()-this.receivedAt)/1000):0));}
    apply(data){
      if(this.closed)return;const s=data.state;
      if(!s||![2,3].includes(s.protocol)||s.seq<this.seq||(s.seq===this.seq&&this.state&&s.server_time<this.state.server_time))return;
      const previous=this.state;this.state=s;this.receivedAt=performance.now();this.seq=s.seq;
      this.commandSeq=Math.max(this.commandSeq,s.command_seq||0);
      const me=s.participants.find(p=>p.id===this.session);
      if(!me){this.joined=false;this.token='';return;}
      this.isHost=!!me.host;this.onRole(this.isHost);
      if(!this.isHost&&me.reason?.includes('Длительность видео отличается')){
        if(!this.versionMismatch)this.send('pause');
        this.versionMismatch=true;this.following=false;
        this.error='Длительность видео отличается от версии ведущего. Выберите одинаковую версию или продолжите одному.';
      }else this.versionMismatch=false;
      const content=this.content();
      const changed=String(content.translation)!==s.translation||Number(content.season||0)!==s.season||Number(content.episode||0)!==s.episode;
      if(changed){this.pendingHostSource=this.isHost;this.hostSourceSync=this.isHost?{until:performance.now()+20000,lastSeek:0}:null;this.bootstrap=true;this.duration=0;this.lastTelemetry=null;this.loadContent(s);}
      const generationChanged=this.generation!==s.generation;this.generation=s.generation;
      if(s.ended){this.ended=true;this.send('pause');this.message('Комната завершена. Можно продолжить одному.');this.render(s);return;}
      // Свой принятый seek не отыгрываем обратно ведущему. Пауза не сбрасывает готовность.
      if(!this.isHost&&(generationChanged||!previous||s.playing!==previous.playing))this.synchronize(true);
      this.render(s);
    }
    sourceLoaded(){
      if(!this.state||this.closed||this.ended)return;
      if(this.isHost&&this.pendingHostSource){this.pendingHostSource=false;this.send('seek',Math.max(.05,this.target()));this.hostSourceSync.lastSeek=performance.now();this.send(this.state.desired_playing?'play':'pause');}
      else if(!this.isHost)this.synchronize(true);
    }
    synchronize(force=false){
      if(!this.state||this.closed||this.ended||!this.following)return;
      const target=this.target();
      if(Math.abs(this.position-target)>1&&(force||performance.now()-this.lastCorrection>5000)){
        this.send('seek',Math.max(.05,target));this.lastCorrection=performance.now();this.corrections++;
      }
      if(force||this.state.playing!==this.playing){this.send(this.state.playing?'play':'pause');this.needsGesture=this.state.playing&&this.lastTelemetry===null;}
    }
    render(s){
      if(!s)return;
      this.panel.querySelector('[data-role]').textContent=this.isHost?'Вы ведущий · управление в Alloha':'Смотрим вместе · управление у ведущего';
      this.panel.querySelector('[data-host-menu]').hidden=!this.isHost||!!s.ended;
      this.panel.querySelector('[data-follow]').disabled=!!this.versionMismatch;
      this.panel.querySelector('[data-follow]').hidden=this.isHost||s.ended||(this.following&&!this.needsGesture);
      this.panel.querySelector('[data-copy]').hidden=!!s.ended;
      this.panel.querySelector('[data-clock]').textContent=`В комнате ${timecode((performance.now()-this.startedAt)/1000)}`;
      if(this.item.kind==='series'&&this.formGeneration!==s.generation){for(const k of ['season','episode'])this.panel.querySelector(`[data-${k}]`).value=s[k]||1;this.formGeneration=s.generation;}
      const members=this.panel.querySelector('[data-members]');members.replaceChildren();
      for(const p of s.participants){const row=document.createElement('div');row.className='together-member';
        const name=document.createElement('span');name.textContent=p.name+(p.host?' · ведущий':'');
        const stamp=document.createElement('span');stamp.className='together-clock';
        const fresh=p.position!=null&&s.server_time-(p.position_at||p.reported_at)<4;
        stamp.textContent=!p.online?'Нет связи':fresh?`${timecode(p.position)} · подтверждено`:!s.playing&&p.position!=null?`${timecode(p.position)} · последняя позиция`:'Нет свежих данных о видео';row.append(name,stamp);members.append(row);}
      const progress=s.shared_progress||{};
      const progressLabel=this.panel.querySelector('[data-progress]');
      if(progress.revision){
        const profile=s.context_kind==='shared'?'Общий профиль':'Личный профиль';
        progressLabel.textContent=`Сохранено в ${profile}${s.context_label?` · ${s.context_label}`:''}: ${timecode(progress.position)}${progress.completed?' · просмотрено':''}`;
      }else progressLabel.textContent=s.context_kind==='shared'?'Общий прогресс появится, когда все участники подключатся.':'Личная точка появится после первых секунд просмотра.';
      if(s.ended)return;
      if(this.error)this.message(this.error);
      else if(!s.host_online)this.message('Ведущий не на связи. Ждём возвращения; видео может продолжаться в iframe.');
      else if(!this.following)this.message('Просмотр у вас приостановлен или перемотан. Вернитесь к ведущему или продолжите одному.');
      else if(this.needsGesture||(!this.isHost&&this.bootstrap&&s.playing&&!this.playing))this.message('Если видео не началось, нажмите Play внутри Alloha, затем «Вернуться к ведущему».');
      else if(this.isHost&&this.lastTelemetry===null)this.message('Комната подключена, но Alloha ещё не передал позицию. Нажмите Play внутри плеера.');
      else if(this.isHost&&this.lastTelemetry!==null&&performance.now()-this.lastTelemetry>5000)this.message('Позиция Alloha давно не обновлялась. Комната пока не может подтвердить прогресс.');
      else if(this.lastTelemetry!==null&&performance.now()-this.lastTelemetry>5000&&s.playing)this.message('Нет свежих событий видео. Проверьте плеер: загрузка не определяется через API Alloha.');
      else this.message(s.desired_playing?'Смотрим вместе · загрузка у участников не проверяется автоматически':'Общая пауза');
    }
    command(command,extras={}){
      if(!this.isHost||this.closed||this.ended)return Promise.resolve();
      const run=async()=>{if(this.closed)return;const data=await this.post({action:'command',command,command_seq:++this.commandSeq,...extras});this.error='';this.apply(data);};
      const result=this.commandTail.then(run);this.commandTail=result.catch(()=>{});return result;
    }
    onMessage(payload){
      if(this.closed||this.ended)return;
      payload=normalizeMessage(payload);
      if(!payload)return;
      if(payload.event==='duration'){if(Number(payload.time)>0)this.duration=Number(payload.time);return;}
      if(!['play','pause','seek','timeupdate','ended'].includes(payload.event))return;
      const time=Number(payload.time);if(!Number.isFinite(time)||time<0)return;
      const previousPosition=this.position;
      this.position=time;this.lastTelemetry=performance.now();
      if(payload.event==='play'){this.playing=true;this.needsGesture=false;}
      if(payload.event==='pause'||payload.event==='ended')this.playing=false;
      if(!this.state)return;
      const echo=this.consumeEcho(payload);
      if(this.isHost&&this.hostSourceSync){
        const pending=this.hostSourceSync,now=performance.now(),landed=Math.abs(time-this.target())<2;
        if(landed&&(payload.event==='timeupdate'||payload.event==='seek')){
          this.hostSourceSync=null;
          if(this.state.desired_playing&&!this.playing)this.send('play');
        }else if(now<pending.until){
          if(!landed&&now-pending.lastSeek>2000){this.send('seek',Math.max(.05,this.target()));pending.lastSeek=now;}
          return;
        }else{this.hostSourceSync=null;this.message('Не удалось подтвердить позицию после смены озвучки. Проверьте плеер.');return;}
        return;
      }
      const seek=this.remoteSeek;
      if(!this.isHost&&seek&&performance.now()<seek.until){
        const landed=Math.abs(time-seek.target)<2;
        if(payload.event==='pause'&&landed&&this.state.playing&&!seek.resumed){
          seek.resumed=true;this.send('play');return;
        }
        if(payload.event==='pause'||payload.event==='seek')return;
        if(payload.event==='timeupdate'&&landed){
          if(seek.firstTime===null)seek.firstTime=time;
          else if(time-seek.firstTime>.25)this.remoteSeek=null;
        }
      }

      if(!this.isHost&&this.bootstrap){
        if(Math.abs(time-this.target())<2&&(payload.event==='timeupdate'||payload.event==='seek'))this.bootstrap=false;
        else if(payload.event==='timeupdate'&&performance.now()-this.lastCorrection>2000)this.synchronize(true);
        return;
      }
      if(echo)return;
      if(this.isHost){
        // Иногда Alloha начинает видео до установки комнаты и play-событие теряется.
        // Движущаяся шкала ведущего подтверждает фактический запуск.
        if(payload.event==='timeupdate'&&!this.state.desired_playing&&time-previousPosition>.75){
          this.command('play',{position:time}).catch(e=>this.message(e.message));
          return;
        }
        if(payload.event==='seek'){
          clearTimeout(this.pauseTimer);clearTimeout(this.seekTimer);this.seekPending=true;const selectedPosition=time;
          this.seekTimer=setTimeout(()=>{this.seekPending=false;this.command('seek',{position:selectedPosition}).then(()=>{if(this.state?.desired_playing&&!this.playing)this.send('play');}).catch(e=>{this.error=e.message;this.message(e.message);});},150);
        }
        if(payload.event==='play'){clearTimeout(this.pauseTimer);if(!this.state.desired_playing)this.command('play',{position:time}).catch(e=>this.message(e.message));}
        if((payload.event==='pause'||payload.event==='ended')&&this.state.desired_playing&&!this.seekPending){
          clearTimeout(this.pauseTimer);this.pauseTimer=setTimeout(()=>{if(!this.seekPending)this.command('pause',{position:time}).catch(e=>this.message(e.message));},180);
        }
      }else if(['seek','pause','play'].includes(payload.event)){
        // Не отменяем действия зрителя циклом seek/pause. Возврат к ведущему явный.
        const deviated=payload.event==='seek'||(payload.event==='pause'&&this.state.playing)||(payload.event==='play'&&!this.state.playing);
        if(deviated){this.following=false;this.render(this.state);}
      }
    }
    async tick(){
      if(this.closed||this.ended||!this.joined||this.pending)return;
      if(performance.now()-this.lastContact>9000){this.error='Связь с комнатой потеряна. Переподключаюсь; состояние видео не подтверждено.';this.message(this.error);}
      if(!this.isHost&&this.following&&this.lastTelemetry!==null&&performance.now()-this.lastTelemetry<2500)this.synchronize();
      // После остановки источника временная шкала ведущего снова задаёт общую позицию.
      if(this.isHost&&!this.seekPending&&this.playing&&this.state?.desired_playing&&this.lastTelemetry!==null&&performance.now()-this.lastTelemetry<1500&&Math.abs(this.position-this.target())>2&&performance.now()-this.lastCorrection>5000){
        this.lastCorrection=performance.now();await this.command('seek',{position:this.position}).catch(e=>this.message(e.message));
      }
      this.pending=true;
      try{const age=this.lastTelemetry===null?3600:(performance.now()-this.lastTelemetry)/1000;
        const data=await this.post({action:'report',generation:this.generation,ready:age<3&&Math.abs(this.position-this.target())<3,
          position:this.position,telemetry_age:Math.min(age,3600),duration:this.duration,corrections:this.corrections,reason:age<3?'':'Нет свежих событий видео'});
        this.error='';this.apply(data);
      }catch(e){this.error=e.message;if(e.status===401||e.status===403){this.joined=false;this.panel.querySelector('[data-join]').hidden=false;}this.message(this.error);}
      finally{this.pending=false;}
    }
    async leave(){try{if(this.token&&!this.ended)await this.post({action:'leave'});}catch{}finally{try{sessionStorage.removeItem(this.storageKey);}catch{}this.dispose();}}
    dispose(){this.closed=true;this.events?.close();clearInterval(this.tickTimer);clearTimeout(this.seekTimer);clearTimeout(this.pauseTimer);}
  }
  AllohaRoom.normalizeMessage=normalizeMessage;
  window.CineVaultAllohaRoom=AllohaRoom;
})();
