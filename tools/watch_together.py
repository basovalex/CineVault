"""Протокол комнат v2: ведущий, готовность и авторитетная временная шкала.

Вызывается под блокировкой SQLite-хранилища. Секреты остаются в state_json
и никогда не входят в публичный снимок комнаты.
"""
import copy
import math
import secrets
import time

# Mobile Safari can suspend page timers briefly when the share sheet or another
# app is opened. Keep a short foreground interruption from marking the host offline.
HEARTBEAT_TIMEOUT = 90
ROOM_TTL = 24 * 60 * 60
MAX_PARTICIPANTS = 16


def number(value, maximum=864000):
    result = float(value)
    if not math.isfinite(result) or not 0 <= result <= maximum:
        raise ValueError("Недопустимое числовое значение")
    return result


def create(payload, now=None):
    now = time.time() if now is None else now
    host_token = secrets.token_urlsafe(32)
    state = {
        "protocol": int(payload.get("protocol", 2)), "provider": str(payload.get("provider", "alloha")), "title_id": str(payload["title_id"])[:160],
        "target_key": str(payload.get("target_key", payload["title_id"]))[:200], "episode_id": str(payload.get("episode_id", ""))[:160],
        "season": int(number(payload.get("season", 0), 10000)),
        "episode": int(number(payload.get("episode", 0), 100000)),
        "translation": str(payload.get("translation", ""))[:80],
        "position": number(payload.get("position", 0)), "playing": False,
        "desired_playing": bool(payload.get("playing")) if payload.get("sync_mode") == "iframe" or payload.get("provider") == "cinevault" else False, "sync_mode": "iframe" if payload.get("sync_mode") == "iframe" else "verified", "anchor_at": now, "seq": 0, "generation": 1,
        "created_at": now, "updated_at": now, "ended": False, "waiting_since": now,
        "_private": {"host_token": host_token, "host_session": "", "host_instance": "", "host_seen": 0,
                     "command_seq": 0, "participants": {}, "owner_user_id": payload.get("_actor_id"),
                     "context_users": [payload["_actor_id"]] if payload.get("_actor_id") else []},
    }
    return state, host_token


def position(state, now):
    value = state["position"] + (max(0, now - state["anchor_at"]) if state["playing"] else 0)
    duration = state.get("duration", 0)
    return min(value, duration) if duration > 0 else value


def reconcile(state, now):
    private = state["_private"]
    if now - state["created_at"] >= ROOM_TTL:
        state["ended"] = True
    # Удаляем давно отсутствующих; краткое отсутствие удерживает общую паузу.
    for key, p in list(private["participants"].items()):
        if now - p["seen"] > 120:
            del private["participants"][key]
    host_online = now - private["host_seen"] < HEARTBEAT_TIMEOUT
    waiting = [p for p in private["participants"].values()
               if p["required"] and (now - p["seen"] >= HEARTBEAT_TIMEOUT
                  or not p["ready"] or p["generation"] != state["generation"])]
    # Iframe не сообщает буфер. Не превращаем устаревшую телеметрию в общую паузу.
    if state.get("sync_mode") == "iframe":
        waiting = []
    should_play = bool(state["desired_playing"] and host_online and not waiting and not state["ended"])
    if should_play != state["playing"]:
        freeze_at = now
        if state["playing"] and not host_online:
            freeze_at = min(freeze_at, private["host_seen"] + HEARTBEAT_TIMEOUT)
        if state["playing"]:
            for participant in private["participants"].values():
                if participant["required"] and now - participant["seen"] >= HEARTBEAT_TIMEOUT:
                    freeze_at = min(freeze_at, participant["seen"] + HEARTBEAT_TIMEOUT)
        state["position"] = position(state, freeze_at)
        state["anchor_at"] = now
        state["playing"] = should_play
        state["seq"] += 1
    if waiting or not host_online:
        if state["waiting_since"] is None:
            state["waiting_since"] = now
    else:
        state["waiting_since"] = None
    return state


def snapshot(state, now=None):
    now = time.time() if now is None else now
    reconcile(state, now)
    public = {k: copy.deepcopy(v) for k, v in state.items() if k != "_private"}
    private = state["_private"]
    public["server_time"] = now
    public["command_seq"] = private["command_seq"]
    public["host_online"] = now - private["host_seen"] < HEARTBEAT_TIMEOUT
    public["participants"] = [
        {"id": key, "name": p["name"], "host": p["host"], "ready": p["ready"],
         "required": p["required"], "online": now - p["seen"] < HEARTBEAT_TIMEOUT,
         "generation": p["generation"], "reason": p["reason"], "position": p.get("position"), "reported_at": p["seen"], "position_at": p.get("position_at", p["seen"]), "corrections": p.get("corrections", 0)}
        for key, p in private["participants"].items()
    ]
    return public


def update(state, payload, now=None):
    now = time.time() if now is None else now
    reconcile(state, now)
    if state["ended"]:
        raise ValueError("Комната завершена или срок её действия истёк")
    private = state["_private"]
    action = payload.get("action")
    session = str(payload.get("session", ""))[:100]
    if not session:
        raise PermissionError("Не указана сессия участника")
    instance = str(payload.get("instance", ""))[:100]
    is_host = secrets.compare_digest(str(payload.get("host_token", "")), private["host_token"])
    p = private["participants"].get(session)
    account = payload.get("_account") or {}
    if state.get("protocol") == 3:
        if not account.get("id"):
            raise PermissionError("Войдите в свой аккаунт")
        if is_host and account["id"] != private.get("owner_user_id"):
            raise PermissionError("Это комната другого ведущего")
        if p and p.get("account_id") != account["id"]:
            raise PermissionError("Подключение принадлежит другому аккаунту")
        if action == "join" and payload.get("consent") is not True:
            raise ValueError("Подтвердите участие в совместном просмотре")
        expected = private.get("expected_users")
        if action == "join" and expected and account["id"] not in expected:
            raise PermissionError("Приглашение предназначено участникам выбранного просмотра")
    credentials = {}
    if action == "join":
        if is_host and payload.get("sync_mode") == "iframe":
            state["sync_mode"] = "iframe"
        if is_host:
            owner = private["host_session"]
            if owner and (owner != session or private.get("host_instance", "") != instance) and now - private["host_seen"] < HEARTBEAT_TIMEOUT and payload.get("takeover") is not True:
                raise PermissionError("Ведущий уже открыт в другой вкладке")
            private["host_session"] = session
            private["host_instance"] = instance
            private["host_seen"] = now
            # Старое подключение ведущего не должно удерживать ожидание.
            if owner and owner != session:
                private["participants"].pop(owner, None)
        elif p:
            if not secrets.compare_digest(str(payload.get("participant_token", "")), p["token"]):
                raise PermissionError("Не подтверждена личность участника")
        if not p:
            if len(private["participants"]) >= MAX_PARTICIPANTS:
                raise ValueError("В комнате уже 16 участников")
            p = {"token": secrets.token_urlsafe(24), "name": "Ведущий" if is_host else f"Зритель {len(private['participants']) + 1}",
                 "host": is_host, "required": is_host or not state["desired_playing"],
                 "ready": False, "generation": state["generation"], "reason": "Загрузка видео", "seen": now}
            if state.get("protocol") == 3:
                p["account_id"] = account["id"]
                p["name"] = account["display_name"]
            private["participants"][session] = p
        if state.get("protocol") == 3:
            private["context_users"] = sorted(set(private.get("context_users", []) + [account["id"]]))
        if p["host"] and not is_host:
            raise PermissionError("Нужен секрет ведущего")
        p["ready"] = False
        p["reason"] = "Загрузка видео"
        credentials["participant_token"] = p["token"]
    else:
        if not p or not secrets.compare_digest(str(payload.get("participant_token", "")), p["token"]):
            raise PermissionError("Не подтверждена личность участника")
        if p["host"] and (not is_host or private["host_session"] != session or private.get("host_instance", "") != instance):
            raise PermissionError("Управление доступно только действующему ведущему")
        if action == "report":
            generation = int(number(payload.get("generation", 0), 1000000000))
            if generation == state["generation"]:
                p["ready"] = payload.get("ready") is True
                p["generation"] = generation
                p["reason"] = str(payload.get("reason", ""))[:160]
                if "position" in payload:
                    p["position"] = number(payload["position"])
                    p["position_at"] = now - number(payload.get("telemetry_age", 0), 3600)
                if "corrections" in payload:
                    p["corrections"] = int(number(payload["corrections"], 1000000000))
                if "duration" in payload:
                    duration = number(payload["duration"])
                    if p["host"] and duration:
                        state["duration"] = duration
                    elif duration and state.get("duration") and abs(duration - state["duration"]) > 3:
                        p["ready"] = False
                        p["reason"] = "Длительность видео отличается от версии ведущего"
                # Вернувшийся зритель сначала синхронизируется, потом участвует в ожидании.
                if p["ready"]:
                    p["required"] = True
        elif action == "leave":
            private["participants"].pop(session)
            if p["host"]:
                private["host_seen"] = 0
            p = None
        elif action == "command":
            if not is_host or not p["host"]:
                raise PermissionError("Просмотром управляет ведущий")
            command_seq = int(number(payload.get("command_seq", 0), 1000000000))
            if command_seq <= private["command_seq"]:
                return credentials
            command = payload.get("command")
            if command not in {"play", "pause", "seek", "content", "exclude", "end", "wait"}:
                raise ValueError("Неизвестная команда")
            state["position"] = position(state, now)
            state["anchor_at"] = now
            if command in {"play", "pause"}:
                state["desired_playing"] = command == "play"
                if state.get("sync_mode") == "iframe" and "position" in payload:
                    state["position"] = number(payload["position"])
            elif command in {"seek", "content"}:
                new_position = number(payload.get("position", 0))
                if command == "content":
                    state["duration"] = 0
                    for key in ("season", "episode"):
                        state[key] = int(number(payload.get(key, state[key]), 100000))
                    state["translation"] = str(payload.get("translation", state["translation"]))[:80]
                state["position"] = new_position
                state["playing"] = False
                state["generation"] += 1
                for person in private["participants"].values():
                    person["ready"] = False
                state["waiting_since"] = now
            elif command == "exclude":
                other = private["participants"].get(str(payload.get("participant", "")))
                if not other or other["host"]:
                    raise ValueError("Участник не найден")
                other["required"] = False
            elif command == "end":
                state["ended"] = True
            elif command == "wait":
                state["waiting_since"] = now
            private["command_seq"] = command_seq
            state["seq"] += 1
        else:
            raise ValueError("Неизвестное действие")
    if p:
        p["seen"] = now
        if p["host"]:
            private["host_seen"] = now
    state["updated_at"] = now
    reconcile(state, now)
    return credentials
