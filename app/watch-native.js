/* Общая комната для HTML5-плеера CineVault. */
(() => {
  'use strict';
  class NativeRoom {
    constructor({roomId, video, item, season, episode, roomStatus, onEpisodeChange, request, shareLink, onLeave}) {
      Object.assign(this, {roomId, video, item, roomStatus, onEpisodeChange, request, shareLink, onLeave});
      this.season=Number(season||0);this.episode=Number(episode||0);this.storageKey=`cinevault.native.room.${roomId}`;
      let saved={};try{saved=JSON.parse(sessionStorage.getItem(this.storageKey)||'{}');}catch{}
      this.instance=saved.instance||crypto.randomUUID();this.session=saved.session||crypto.randomUUID();this.token=saved.token||'';this.hostToken='';this.isHost=false;this.closed=false;
      try { this.hostToken=localStorage.getItem(`cinevault.room.${roomId}.host`)||''; } catch {}
      this.isHost=!!this.hostToken;this.seq=-1;this.commandSeq=0;this.suppressUntil=0;this.waiting=video.readyState<2;
      this.tail=Promise.resolve();this.listeners=[];this.renderShell();this.setControls(true);
      for(const event of ['waiting','stalled','seeking'])this.listen(event,()=>{this.waiting=true;this.reportSoon();});
      for(const event of ['canplay','playing','seeked','loadeddata'])this.listen(event,()=>{this.waiting=false;this.applyPending();this.reportSoon();});
      this.root=this.video.closest('.player-modal');
      this.editionCapture=e=>{if(this.isHost&&!this.applyingEdition&&e.target.matches('#video-variant,select[id$="-hls-audio"]'))this.suppressUntil=Date.now()+1500;};
      this.editionChange=e=>{if(!this.isHost||this.applyingEdition||!this.joined)return;const el=e.target;
        const value=el.matches('#video-variant')?`v:${el.value}`:el.matches('select[id$="-hls-audio"]')?`a:${el.selectedOptions[0]?.textContent||''}`:'';
        if(value)this.command('content',{season:this.season,episode:this.episode,translation:value,position:Number(this.video.currentTime)||0}).catch(err=>this.message(err.message));};
      this.root?.addEventListener('change',this.editionCapture,true);this.root?.addEventListener('change',this.editionChange);
      this.timer=setInterval(()=>this.report(),1000);
      if(this.isHost)this.join();
    }
    listen(event,fn){this.video.addEventListener(event,fn);this.listeners.push([event,fn]);}
    renderShell(){
      this.roomStatus.hidden=false;this.roomStatus.classList.add('together-panel');
      this.roomStatus.innerHTML='<header class="together-heading"><strong data-role>Совместный просмотр</strong><span data-clock class="together-clock"></span></header><p data-status role="status">Подключение к комнате…</p><div data-members class="together-members"></div><div class="together-actions"><button type="button" data-join>Присоединиться и смотреть</button><button type="button" data-follow hidden>Запустить видео</button><button type="button" data-copy>Пригласить</button><button type="button" data-leave>Продолжить одному</button><button type="button" data-end hidden>Завершить для всех</button></div>';
      const bind=(key,fn)=>this.roomStatus.querySelector(`[data-${key}]`).addEventListener('click',()=>Promise.resolve().then(fn).catch(e=>this.message(e.message)));
      bind('join',()=>this.join());bind('follow',()=>{this.needsGesture=false;this.applyPending(true);});
      bind('copy',async()=>{try{await navigator.clipboard.writeText(this.shareLink(this.roomId));this.message('Приглашение скопировано.');}catch{this.message('Ссылка на комнату находится в адресной строке.');}});
      bind('leave',()=>this.leave());bind('end',()=>this.command('end'));
      this.roomStatus.querySelector('[data-join]').hidden=this.isHost;
    }
    message(text){const node=this.roomStatus.querySelector('[data-status]');if(node)node.textContent=text;}
    setControls(locked){
      this.video.dataset.roomLocked=locked?'true':'false';
      const root=this.video.closest('.player-modal');if(!root)return;
      for(const node of root.querySelectorAll('.player-play-button,.player-skip-button,.video-play-overlay,input[type="range"][id$="-range"],#player-season,#player-episode,#video-variant,select[id$="-hls-audio"],#library-skip-now,#library-skip-auto'))node.disabled=locked;
    }
    async post(payload){
      const headers={'content-type':'application/json'};
      if(window.CineVaultAccounts?.csrf)headers['X-CineVault-CSRF']=window.CineVaultAccounts.csrf;
      const start=performance.now();
      const response=await this.request(`/api/watch/rooms/${encodeURIComponent(this.roomId)}`,{method:'POST',headers,body:JSON.stringify({session:this.session,instance:this.instance,host_token:this.hostToken,participant_token:this.token,...payload}),signal:AbortSignal.timeout(7000)});
      const data=await response.json();if(!response.ok){const e=new Error(data.error||`HTTP ${response.status}`);e.status=response.status;throw e;}
      if(data.state)data.state.server_time+=(performance.now()-start)/2000;
      return data;
    }
    async join(){
      if(this.closed||this.joining)return;
      if(!await window.CineVaultAccounts?.requireLogin())return;
      this.joining=true;
      try{const data=await this.post({action:'join',consent:true});if(this.closed)return;
        this.token=data.participant_token;this.joined=true;try{sessionStorage.setItem(this.storageKey,JSON.stringify({session:this.session,instance:this.instance,token:this.token}));}catch{}
        this.roomStatus.querySelector('[data-join]').hidden=true;
        this.apply(data);this.openEvents();await this.report();
      }catch(e){this.message(e.message);this.roomStatus.querySelector('[data-join]').hidden=false;}
      finally{this.joining=false;}
    }
    openEvents(){if(this.events||!window.EventSource)return;this.events=new EventSource(`/api/watch/rooms/${encodeURIComponent(this.roomId)}/events`);this.events.onmessage=e=>{try{this.apply(JSON.parse(e.data));}catch{}};}
    target(s=this.state){const value=Math.max(0,Number(s.position||0)+(s.playing?Math.max(0,Number(s.server_time)-Number(s.anchor_at)+(performance.now()-this.receivedAt)/1000):0));
      return Number.isFinite(this.video.duration)&&this.video.duration>0?Math.min(value,this.video.duration):value;}
    apply(data){
      if(this.closed||!this.joined)return;const s=data?.state;
      if(!s||s.provider!=='cinevault'||s.seq<this.seq||(s.seq===this.seq&&this.state&&s.server_time<this.state.server_time))return;
      const me=s.participants.find(p=>p.id===this.session);if(!me){this.joined=false;this.setControls(true);this.message('Соединение с комнатой потеряно.');this.roomStatus.querySelector('[data-join]').hidden=false;return;}
      this.state=s;this.receivedAt=performance.now();this.seq=s.seq;this.commandSeq=Math.max(this.commandSeq,s.command_seq||0);this.isHost=!!me.host;
      this.setControls(!this.isHost||s.ended);this.roomStatus.querySelector('[data-end]').hidden=!this.isHost||s.ended;
      this.roomStatus.querySelector('[data-role]').textContent=this.isHost?'Вы ведущий':'Смотрим вместе · управление у ведущего';
      const members=this.roomStatus.querySelector('[data-members]');members.replaceChildren();
      for(const p of s.participants){const row=document.createElement('div');row.className='together-member';const name=document.createElement('span');name.textContent=p.name+(p.host?' · ведущий':'');const status=document.createElement('span');status.textContent=!p.online?'Нет связи':p.ready?'Готов':'Загрузка';row.append(name,status);members.append(row);}
      if(s.ended){this.suppressUntil=Date.now()+1000;this.video.pause();this.message('Комната завершена. Можно продолжить одному.');return;}
      if(Number(s.season||0)!==this.season||Number(s.episode||0)!==this.episode){this.season=Number(s.season||0);this.episode=Number(s.episode||0);this.onEpisodeChange?.(this.season,this.episode);return;}
      if(this.isHost&&Date.now()<(this.localUntil||0))return;
      if(!this.applyEdition(s.translation))return;
      this.applyPending();
      const waiting=s.participants.some(p=>p.required&&(!p.ready||!p.online));
      this.message(!s.host_online?'Ведущий не на связи.':waiting?'Ждём загрузку видео у участников.':s.playing?'Смотрим вместе':'Общая пауза');
    }
    applyEdition(edition){
      if(!edition)return true;const kind=edition.slice(0,2),wanted=edition.slice(2);
      const select=kind==='v:'?this.root?.querySelector('#video-variant'):kind==='a:'?this.root?.querySelector('select[id$="-hls-audio"]'):null;
      if(!select){this.message('Ждём загрузки общей озвучки.');return false;}
      const option=[...select.options].find(o=>kind==='v:'?o.value===wanted:o.textContent===wanted);
      if(!option){this.message('Общая озвучка пока недоступна в этом источнике.');return false;}
      if(select.value!==option.value){this.suppressUntil=Date.now()+1500;this.applyingEdition=true;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));this.applyingEdition=false;}
      return true;
    }
    applyPending(force=false){
      const s=this.state;if(!s||s.ended||!this.joined||!this.applyEdition(s.translation))return;
      if(this.video.readyState<1)return;
      const target=this.target(s);const delta=Math.abs(Number(this.video.currentTime||0)-target);
      if(delta>1.2&&!this.video.seeking){this.suppressUntil=Date.now()+1200;try{this.video.currentTime=target;}catch{}}
      if(s.playing&&this.video.paused){this.suppressUntil=Date.now()+1200;const p=this.video.play();p?.catch(()=>{this.needsGesture=true;this.roomStatus.querySelector('[data-follow]').hidden=false;this.message('Нажмите «Запустить видео», чтобы продолжить совместный просмотр.');});}
      else if(!s.playing&&!this.video.paused){this.suppressUntil=Date.now()+1200;this.video.pause();}
      if(force&&!this.needsGesture)this.roomStatus.querySelector('[data-follow]').hidden=true;
    }
    isApplying(){return Date.now()<this.suppressUntil;}
    command(command,extra={}){if(!this.isHost||!this.joined||this.closed||this.state?.ended)return Promise.resolve(null);
      const run=async()=>{const data=await this.post({action:'command',command,command_seq:++this.commandSeq,...extra});this.localUntil=0;this.apply(data);return data;};
      const result=this.tail.then(run);this.tail=result.catch(()=>{});return result;
    }
    publish(changes={}){if(this.isApplying()&&!(this.isHost&&this.video.ended&&changes.playing===false))return Promise.resolve(null);if(this.isHost)this.localUntil=Date.now()+1500;
      if('playing'in changes)return this.command(changes.playing?'play':'pause',{position:Number(changes.position??this.video.currentTime)||0});
      if('position'in changes)return this.command('seek',{position:Number(changes.position)||0});return Promise.resolve(null);
    }
    async publishEpisode(season,episode){const before=[this.season,this.episode];this.season=Number(season);this.episode=Number(episode);
      try{return await this.command('content',{season,episode,translation:this.state?.translation||'',position:0});}
      catch(error){[this.season,this.episode]=before;throw error;}}
    schedulePublish(){if(this.isHost)this.localUntil=Date.now()+1500;clearTimeout(this.publishTimer);this.publishTimer=setTimeout(()=>this.publish({position:this.video.currentTime}),150);}
    reportSoon(){clearTimeout(this.reportTimer);this.reportTimer=setTimeout(()=>this.report(),100);}
    async report(){if(this.closed||!this.joined||this.reporting||!this.state)return;this.reporting=true;
      try{const pos=Number(this.video.currentTime)||0;const ready=this.applyEdition(this.state.translation)&&!this.waiting&&this.video.readyState>=2&&!this.video.seeking&&Math.abs(pos-this.target())<3;
        const data=await this.post({action:'report',generation:this.state.generation,ready,position:pos,telemetry_age:0,duration:Number.isFinite(this.video.duration)?this.video.duration:0,reason:ready?'':'Загрузка видео'});this.apply(data);
      }catch(e){this.message(`Связь с комнатой: ${e.message}`);if(e.status===401||e.status===403){this.joined=false;this.setControls(true);this.roomStatus.querySelector('[data-join]').hidden=false;}}
      finally{this.reporting=false;}
    }
    async leave(){try{if(this.joined&&!this.state?.ended)await this.post({action:'leave'});}catch{}finally{try{sessionStorage.removeItem(this.storageKey);}catch{}this.dispose();this.onLeave?.();}}
    dispose(){if(this.closed)return;this.closed=true;this.events?.close();clearInterval(this.timer);clearTimeout(this.reportTimer);clearTimeout(this.publishTimer);for(const [event,fn]of this.listeners)this.video.removeEventListener(event,fn);this.root?.removeEventListener('change',this.editionCapture,true);this.root?.removeEventListener('change',this.editionChange);this.setControls(false);}
  }
  window.CineVaultNativeRoom=NativeRoom;
})();
