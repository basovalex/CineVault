/* Аккаунты отделены от анонимного localStorage и от комнаты просмотра. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clock = seconds => { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
  const profile = {
    user: null, csrf: '', contexts: [], nextResume: null,
    async api(path, data) {
      const headers = {accept:'application/json'};
      if (data !== undefined) { headers['Content-Type']='application/json'; if (this.csrf) headers['X-CineVault-CSRF']=this.csrf; }
      const viewer = window.CINEVAULT_CONFIG?.viewerToken;
      if (viewer) headers.Authorization = `Bearer ${viewer}`;
      const response = await fetch(`/api/account/${path}`, {method:data === undefined?'GET':'POST', headers, credentials:'same-origin',
        body:data === undefined?undefined:JSON.stringify(data), signal:AbortSignal.timeout(12000)});
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error || `HTTP ${response.status}`); error.status=response.status; throw error; }
      return result;
    },
    async refresh() {
      const state = await this.api('session'); this.user=state.user; this.csrf=state.csrf || '';
      this.contexts=this.user?(await this.api('contexts')).contexts:[];
      this.button.textContent=this.user?.display_name || 'Войти';
      window.dispatchEvent(new CustomEvent('cinevault:account', {detail:{user:this.user}}));
      return this.user;
    },
    modal(title, html) {
      this.dialog.querySelector('[data-account-title]').textContent=title;
      this.dialog.querySelector('[data-account-body]').innerHTML=html;
      this.error('');
      if (!this.dialog.open) this.dialog.showModal();
      const first=this.dialog.querySelector('[data-account-body] input, [data-account-body] button'); first?.focus();
    },
    error(text) { const el=this.dialog.querySelector('[data-account-error]'); el.textContent=text; },
    form(mode='login') {
      const register=mode==='register', recover=mode==='recover';
      this.modal(register?'Создать аккаунт':recover?'Восстановить доступ':'Войти в CineVault', `
        <p class="muted">Личный просмотр и просмотр вместе сохраняются отдельно на ваших устройствах.</p>
        <form data-auth-form>
        <label>Логин<input name="username" autocomplete="username" required minlength="3" maxlength="32"></label>
        ${register?'<label>Ваше имя<input name="display_name" autocomplete="nickname" required maxlength="40" placeholder="Саша"></label>':''}
        ${recover?'<label>Код восстановления<input name="recovery_code" autocomplete="off" required></label>':''}
        <label>${recover?'Новый пароль':'Пароль'}<input name="${recover?'new_password':'password'}" type="password" autocomplete="${register||recover?'new-password':'current-password'}" required minlength="${mode==='login'?1:10}" maxlength="256"></label>
        ${register?'<p class="small muted">Сохраните код восстановления после регистрации. Отправки писем пока нет.</p>':''}
        <button type="submit" class="primary-button">${register?'Создать аккаунт':recover?'Восстановить доступ':'Войти'}</button></form>
        <div class="account-links"><button type="button" data-mode="${register?'login':'register'}">${register?'Уже есть аккаунт':'Создать аккаунт'}</button><button type="button" data-mode="${recover?'login':'recover'}">${recover?'Вернуться ко входу':'Забыли пароль?'}</button></div>`);
      this.dialog.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>this.form(button.dataset.mode));
      this.dialog.querySelector('form').onsubmit=async event=>{
        event.preventDefault(); const form=event.currentTarget; const button=form.querySelector('[type=submit]'); button.disabled=true;
        try {
          const result=await this.api(mode,Object.fromEntries(new FormData(form)));
          this.csrf=result.csrf; await this.refresh();
          if (result.recovery_code) this.recovery(result.recovery_code); else if (!await this.consumeInvitation()) this.home();
        } catch(error) { this.error(error.message); form.querySelector('input')?.focus(); }
        finally { button.disabled=false; }
      };
    },
    recovery(code) {
      this.modal('Сохраните код восстановления',`<p>Это единственный способ восстановить доступ без пароля. Код показывается сейчас, храните его в надёжном месте.</p><label>Код восстановления<input data-recovery readonly value="${escape(code)}"></label><button class="secondary-button" data-copy>Скопировать код</button><button class="primary-button" data-ack>Я сохранил код</button>`);
      this.dialog.querySelector('[data-copy]').onclick=async()=>{try{await navigator.clipboard.writeText(code);this.error('Код скопирован.');}catch{this.dialog.querySelector('[data-recovery]').select();this.error('Скопируйте выделенный код вручную.');}};
      this.dialog.querySelector('[data-ack]').onclick=async()=>{if(!await this.consumeInvitation())this.home();};
    },
    async consumeInvitation() {
      const token=new URL(location.href).searchParams.get('pair'); if(!token||!this.user)return false;
      try {
        const info=await this.api(`invitation?token=${encodeURIComponent(token)}`);
        this.modal('Смотреть вместе',`<p>${escape(info.display_name)} приглашает вас сохранять совместную историю. Вы увидите только историю вашего совместного просмотра.</p><button class="primary-button" data-accept>Принять приглашение</button><button class="secondary-button" data-decline>Не сейчас</button>`);
        const clear=()=>{const url=new URL(location.href);url.searchParams.delete('pair');history.replaceState(history.state,'',url);};
        this.dialog.querySelector('[data-accept]').onclick=async()=>{try{await this.api('accept',{token});clear();await this.refresh();this.home();}catch(e){this.error(e.message);}};
        this.dialog.querySelector('[data-decline]').onclick=()=>{clear();this.home();};
        return true;
      }catch(error){this.error(error.message);return false;}
    },
    home() {
      if(!this.user){this.form();if(this.loadError)this.error(`Сервер аккаунтов недоступен: ${this.loadError}`);return;}
      this.modal(this.user.display_name,`<p class="muted">Ваш аккаунт · ${escape(this.user.username)}</p>
        <div class="account-actions"><button class="primary-button" data-history>История и продолжение</button><button class="secondary-button" data-invite>Пригласить смотреть вместе</button><button class="secondary-button" data-import>Импортировать историю этого браузера</button><button class="text-button" data-logout>Выйти из аккаунта</button></div>
        <details><summary>Управление аккаунтом</summary><p>Удаление уберёт личную историю и входы. У партнёра останется совместный прогресс с анонимным участником.</p><form data-delete><label>Текущий пароль<input name="password" type="password" autocomplete="current-password" required></label><label class="account-checkbox"><input type="checkbox" required>Удалить мой аккаунт и личную историю</label><button type="submit" class="account-danger">Удалить аккаунт</button></form></details>`);
      this.dialog.querySelector('[data-history]').onclick=()=>this.history().catch(e=>this.error(e.message));
      this.dialog.querySelector('[data-invite]').onclick=async()=>{try{
        const result=await this.api('invitation',{});const url=new URL('/',location.origin);url.searchParams.set('pair',result.token);
        this.modal('Приглашение',`<p>Отправьте ссылку человеку, с которым хотите смотреть. Ему понадобится собственный аккаунт и доступ к сайту.</p><label>Ссылка<input readonly value="${escape(url)}" data-invite-link></label><button class="primary-button" data-copy>Скопировать приглашение</button>`);
        this.dialog.querySelector('[data-copy]').onclick=async()=>{try{await navigator.clipboard.writeText(String(url));this.error('Ссылка скопирована.');}catch{this.dialog.querySelector('[data-invite-link]').select();this.error('Скопируйте выделенную ссылку.');}};
      }catch(e){this.error(e.message);}};
      this.dialog.querySelector('[data-import]').onclick=()=>this.importLocal();
      this.dialog.querySelector('[data-logout]').onclick=async()=>{try{await this.api('logout',{});await this.refresh();this.form();}catch(e){this.error(e.message);}};
      this.dialog.querySelector('[data-delete]').onsubmit=async event=>{event.preventDefault();try{await this.api('delete',Object.fromEntries(new FormData(event.currentTarget)));await this.refresh();this.form();}catch(e){this.error(e.message);}};
    },
    async history(contextId='') {
      if(!this.user)return this.form();
      const data=await this.api('history'+(contextId?`?context_id=${encodeURIComponent(contextId)}`:''));
      this.contexts=data.contexts;
      const labels=new Map(data.contexts.map(c=>[c.id,c.label]));
      const cards = new Array(data.entries.length); let nextCard = 0;
      await Promise.all(Array.from({length:Math.min(4, data.entries.length)}, async()=>{
        while (nextCard < data.entries.length) {
        const index = nextCard++; const entry = data.entries[index];
        let title=entry.title_id,poster='';try{const r=await fetch(`/api/catalog/imported/${encodeURIComponent(entry.title_id)}`);if(r.ok){const m=await r.json();title=m.title;poster=m.posterImage||'';}}catch{}
        cards[index] = {...entry,title,poster};
        }
      }));
      this.modal('История просмотра',`<label>Контекст просмотра<select data-context><option value="">Все просмотры</option>${data.contexts.map(c=>`<option value="${escape(c.id)}" ${c.id===contextId?'selected':''}>${escape(c.label)}</option>`).join('')}</select></label><div class="account-history">${cards.length?cards.map((entry,i)=>`<article>${entry.poster?`<img src="${escape(entry.poster)}" alt="" loading="lazy">`:''}<div><strong>${escape(entry.title)}</strong><p>${escape(labels.get(entry.context_id))}${entry.season?` · ${entry.season} сезон, ${entry.episode} серия`:''}</p><p>${entry.completed?'Просмотрено':`Остановились на ${clock(entry.position)}`} · ${new Date(entry.updated_at*1000).toLocaleDateString('ru')}</p><button data-resume="${i}" class="secondary-button">${entry.completed?'Посмотреть ещё раз':'Продолжить'}</button><button data-hide="${i}" class="text-button">Скрыть из моей истории</button></div></article>`).join(''):'<p class="muted">Здесь пока пусто. Личный и совместный прогресс появятся после просмотра.</p>'}</div>`);
      this.dialog.querySelector('[data-context]').onchange=event=>this.history(event.target.value).catch(e=>this.error(e.message));
      this.dialog.querySelectorAll('[data-resume]').forEach(button=>button.onclick=()=>{const record=cards[Number(button.dataset.resume)];this.nextResume=record;this.dialog.close();this.onResume?.(record);});
      this.dialog.querySelectorAll('[data-hide]').forEach(button=>button.onclick=async()=>{const entry=cards[Number(button.dataset.hide)];try{await this.api('hide-history',{context_id:entry.context_id,title_id:entry.title_id});await this.history(contextId);}catch(e){this.error(e.message);}});
    },
    async importLocal() {
      let local={};try{local=JSON.parse(localStorage.getItem('cinevault.state.v1')||'{}');}catch{}
      const rows=Object.values(local.progress||{}).filter(p=>p.titleId&&p.position>0);
      this.modal('Импорт личной истории',`<p>Добавить ${rows.length} записей этого браузера в ваш личный контекст? Существующие серверные записи останутся прежними. Общая анонимная история сервера не импортируется.</p><button class="primary-button" data-confirm>Импортировать в личную историю</button>`);
      this.dialog.querySelector('[data-confirm]').onclick=async()=>{try{
        const context=this.contexts.find(c=>c.kind==='solo');let count=0;
        for(const row of rows){const meta={title_id:row.titleId,season:row.seasonNumber||0,episode:row.episodeNumber||0,edition:row.providerId||'default'};
          const saved=await this.api('progress?'+new URLSearchParams({...meta,context_id:context.id}));
          if(saved.revision)continue;
          await this.api('progress',{...meta,context_id:context.id,position:row.position,duration:row.duration||0,completed:!!row.completed,expected_revision:0,operation_id:crypto.randomUUID()});count++;
        }
        await this.history(context.id);this.error(`Добавлено записей: ${count}.`);
      }catch(e){this.error(e.message);}};
    },
    async prepare(meta, {contextId} = {}) {
      await this.ready;if(!this.user)return null;
      const context=contextId?this.contexts.find(c=>c.id===contextId):this.contexts.find(c=>c.kind==='solo');
      if(!context)throw new Error('Контекст просмотра недоступен. Откройте историю аккаунта заново.');
      const saved=await this.api('progress?'+new URLSearchParams({...meta,context_id:context.id}));
      return {meta,context,revision:saved.revision,userId:this.user.id,saved,pending:false,conflicted:false};
    },
    async chooseSolo(meta, current) {
      await this.ready;if(!this.user)return null;
      await this.refresh();
      const session=await this.prepare(meta);
      this.modal('Продолжить одному', `<p>Совместная точка сохранена отдельно. Выберите, что делать с личным просмотром.</p>
        <div class="account-actions"><button class="primary-button" data-current>С текущего места · ${clock(current.position)}</button>
        ${session.saved.revision?`<button class="secondary-button" data-personal>С личного места · ${clock(session.saved.position)}</button>`:''}
        <button class="text-button" data-nosave>Продолжить без сохранения</button></div><p class="muted">Выбор текущего места заменит вашу личную точку только в этой серии и озвучке.</p>`);
      return new Promise(resolve=>{
        const finish=result=>{this.dialog.removeEventListener('close',cancel);this.dialog.close();resolve(result);};
        const cancel=()=>resolve(null);this.dialog.addEventListener('close',cancel,{once:true});
        this.dialog.querySelector('[data-current]').onclick=()=>finish({session,position:current.position,current:true});
        this.dialog.querySelector('[data-personal]')?.addEventListener('click',()=>finish({session,position:session.saved.position,current:false}));
        this.dialog.querySelector('[data-nosave]').onclick=()=>finish(null);
      });
    },
    async checkpoint(session, values) {
      if(!session||session.pending||session.conflicted||!this.user||session.userId!==this.user.id||session.context.kind!=='solo')return;
      session.pending=true;
      try {const result=await this.api('progress',{...session.meta,...values,context_id:session.context.id,expected_revision:session.revision,operation_id:crypto.randomUUID()});session.revision=result.revision;}
      catch(error){session.conflicted=true;if(error.status===409)this.resolveConflict(session,values).catch(e=>this.error(e.message));window.dispatchEvent(new CustomEvent('cinevault:save-error',{detail:{message:error.message}}));}
      finally{session.pending=false;}
    },
    async resolveConflict(session, values) {
      const saved=await this.api('progress?'+new URLSearchParams({...session.meta,context_id:session.context.id}));
      this.modal('Просмотр изменён на другом устройстве', `<p>Автоматическое сохранение остановлено, чтобы не затереть другую позицию.</p><div class="account-actions"><button data-server class="primary-button">С места на сервере · ${clock(saved.position)}</button><button data-device class="secondary-button">С места этого устройства · ${clock(values.position)}</button><button data-stop class="text-button">Продолжить без сохранения</button></div>`);
      const choose=position=>{session.revision=saved.revision;session.conflicted=false;this.dialog.close();window.dispatchEvent(new CustomEvent('cinevault:progress-choice',{detail:{session,position}}));};
      this.dialog.querySelector('[data-server]').onclick=()=>choose(saved.position);
      this.dialog.querySelector('[data-device]').onclick=()=>choose(values.position);
      this.dialog.querySelector('[data-stop]').onclick=()=>this.dialog.close();
    },
    async requireLogin() {await this.ready;if(this.user)return true;this.form();return false;},
    init() {
      this.button=document.createElement('button');this.button.type='button';this.button.className='account-trigger';this.button.textContent='Войти';this.button.onclick=()=>this.home();document.querySelector('.topbar')?.append(this.button);
      this.dialog=document.createElement('dialog');this.dialog.className='account-dialog';this.dialog.innerHTML='<header><h2 data-account-title></h2><button type="button" aria-label="Закрыть аккаунт" data-account-close><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 7 10 10M17 7 7 17"/></svg></button></header><div data-account-body></div><p data-account-error role="alert"></p>';(document.querySelector('.app-shell') || document.body).append(this.dialog);
      this.dialog.querySelector('[data-account-close]').onclick=()=>this.dialog.close();
      this.ready=this.refresh().catch(error=>{this.loadError=error.message;this.button.textContent="Аккаунт · нет связи";return null;});
      this.ready.then(()=>{if(new URL(location.href).searchParams.has('pair'))this.user?this.consumeInvitation():this.form();});
    },
  };
  window.CineVaultAccounts=profile;
  profile.init();
})();
