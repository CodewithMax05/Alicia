// Pferde-Farben (für Renderer)
const HORSE_COLORS = {
    blitz: [0.85, 0.55, 0.15],
    sturm: [0.38, 0.45, 0.52],
    nebel: [0.42, 0.68, 0.85],
    feuer: [0.78, 0.12, 0.05],
};

// ── Highscore (localStorage) ──────────────────────────────────────────────────
const HS_KEY = 'alicia_highscores';

function hsLoad() {
    try { return JSON.parse(localStorage.getItem(HS_KEY)) || []; }
    catch { return []; }
}

function hsSave(entry) {
    const list = hsLoad();
    list.push(entry);
    list.sort((a, b) => a.time - b.time);
    localStorage.setItem(HS_KEY, JSON.stringify(list.slice(0, 20)));
}

function hsPersonalBest(name, horse) {
    return hsLoad()
        .filter(e => e.name === name && e.horse === horse)
        .sort((a, b) => a.time - b.time)[0] || null;
}

// Zeitformat global verfügbar (genutzt in startGame und Results)
function fmtTimeGlobal(s) {
    if (s == null) return '--';
    const m   = Math.floor(s / 60);
    const sec = (s % 60).toFixed(2);
    return `${m}:${sec.padStart(5, '0')}`;
}

function startGame(horseType, playerName = 'Fahrer', riderConfig = { face:0, shirt:0, pants:0 }) {
    Renderer.init(document.getElementById('renderCanvas'));
    Audio.init();
    Minimap.init();

    const playerColor = HORSE_COLORS[horseType] || HORSE_COLORS.blitz;
    const keys = { space: false, jump: false, left: false, right: false };
    let camMode = 'follow';

    window.addEventListener('keydown', e => {
        if (e.code === 'Tab') {
            e.preventDefault();
            camMode = camMode === 'overview' ? 'follow' : 'overview';
            Renderer.setCameraMode(camMode);
            document.getElementById('camMode').textContent =
                camMode === 'follow' ? '📷 Third-Person' : '📷 Übersicht';
        }
    });

    window.addEventListener('keydown', e => {
        if (e.code === 'Space')                          { keys.space = true;  e.preventDefault(); }
        if (e.code === 'ArrowUp'  || e.code === 'KeyW') { keys.jump  = true;  e.preventDefault(); }
        if (e.code === 'ArrowLeft')                      { keys.left  = true;  e.preventDefault(); }
        if (e.code === 'ArrowRight')                     { keys.right = true;  e.preventDefault(); }
    });
    window.addEventListener('keyup', e => {
        if (e.code === 'Space')                          keys.space = false;
        if (e.code === 'ArrowUp'  || e.code === 'KeyW') keys.jump  = false;
        if (e.code === 'ArrowLeft')                      keys.left  = false;
        if (e.code === 'ArrowRight')                     keys.right = false;
    });

    setInterval(() => Network.sendInput({
        accelerate: keys.space,
        jump:       keys.jump,
        laneLeft:   keys.left,
        laneRight:  keys.right,
    }), 50);

    let prevRaceState      = null;
    let prevCountdown      = null;
    let goTimeout          = null;
    let _weatherToastTimer = null;
    let _appliedWeather    = null;

    // Zustand des eigenen Pferdes aus letztem Tick (für Änderungs-Erkennung)
    let prevJumpHeight   = 0;
    let prevPenalized    = false;
    let prevFinished     = false;
    let prevLapCount     = 0;
    let splitTimeout     = null;
    let prevTurboTimer   = 0;
    let prevShieldActive = false;
    let prevStamina      = 100;
    let prevExhausted    = false;
    let prevProgress     = 0;

    // Zeitformatierung (lokale Referenz auf globale Funktion)
    const fmtTime = fmtTimeGlobal;

    // ── Bereit-System (Lobby + Ergebnis-Screen) ──────────────────────────────
    let _isReady = false;

    function _setReadyUI(ready) {
        _isReady = ready;
        Network.sendReady(ready);
        // Lobby-Panel-Button
        const lbBtn = document.getElementById('lobbyReadyBtn');
        if (lbBtn) {
            lbBtn.textContent    = ready ? '✓ Bereit! (Abbrechen)' : '✓ Ich bin bereit!';
            lbBtn.style.background = ready ? '#22aa44' : '';
        }
        // Ergebnis-Screen-Button
        const resBtn = document.getElementById('resultsReadyBtn');
        if (resBtn) {
            resBtn.textContent = ready ? '⏳ Warte auf andere…' : '▶ Nächste Runde';
            resBtn.style.background = ready ? 'rgba(34,170,68,0.25)' : '';
        }
    }

    window.toggleLobbyReady = function() { _setReadyUI(!_isReady); };
    window.resultsReady     = function() { _setReadyUI(true); };

    window.sendChatMsg = function() {
        const input = document.getElementById('chatInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        Network.sendChat(text);
        input.value = '';
        input.focus();
    };

    function addChatMessage(sender, message) {
        const box = document.getElementById('chatMessages');
        if (!box) return;
        const div = document.createElement('div');
        div.className = 'chat-msg';
        div.innerHTML = `<span class="chat-sender">${sender}:</span> ${message}`;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
        // Max 80 Nachrichten
        while (box.children.length > 80) box.removeChild(box.firstChild);
    }

    // ── Lobby-Browser ────────────────────────────────────────────────────────
    let _inLobby    = false;
    let _lobbyName  = null;   // Name der Lobby in der wir sind (für HUD)

    const STATE_LABELS = {
        waiting: 'Wartet', lobby: 'Lobby', countdown: 'Startet…',
        racing: '🏇 Läuft', results: 'Ergebnis',
    };

    window.createLobby = function() {
        const nameEl   = document.getElementById('newLobbyName');
        const pubEl    = document.getElementById('newLobbyPublic');
        const lobbyName = (nameEl?.value.trim() || playerName + 's Lobby').slice(0, 28);
        const isPublic  = pubEl ? pubEl.checked : true;
        hide('lobbyBrowserError');
        Network.sendCreateLobby(lobbyName, isPublic, horseType, playerName, riderConfig);
    };

    window.joinLobbyById = function(lobbyId) {
        hide('lobbyBrowserError');
        Network.sendJoinLobby(lobbyId, horseType, playerName, riderConfig);
    };

    function renderLobbyBrowser(lobbies) {
        if (_inLobby) return;
        show('lobbyBrowser');

        const listEl = document.getElementById('lobbyList');
        if (!listEl) return;

        if (!lobbies || lobbies.length === 0) {
            listEl.innerHTML = '<div class="lb-empty">Noch keine offenen Lobbys — erstelle die erste!</div>';
            return;
        }
        listEl.innerHTML = lobbies.map(lb => {
            const ingame  = lb.state === 'racing' || lb.state === 'countdown' || lb.state === 'results';
            const canJoin = !ingame && lb.players < lb.maxPlayers;
            const stateLabel = STATE_LABELS[lb.state] || lb.state;
            return `<div class="lb-row">
                <span class="lb-name">${lb.name}</span>
                <span class="lb-players">${lb.players}/${lb.maxPlayers}</span>
                <span class="lb-state lb-state-${lb.state}">${stateLabel}</span>
                <button class="lb-join-btn" ${!canJoin ? 'disabled' : ''}
                    onclick="joinLobbyById('${lb.id}')">
                    ${lb.players >= lb.maxPlayers ? 'Voll' : ingame ? 'Läuft' : '➜ Beitreten'}
                </button>
            </div>`;
        }).join('');
    }

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    Network.connect(wsUrl, {
    onState: (state) => {
        const pid = Network.getPlayerId();
        const rs  = state.raceState;

        // ── Minimap ──────────────────────────────────────────────────────────
        if (rs === 'racing' || rs === 'countdown')
            Minimap.draw(state, pid);

        // ── Pferde ───────────────────────────────────────────────────────────
        for (const [id, h] of Object.entries(state.horses)) {
            const col = (id === pid) ? playerColor : null;
            Renderer.updateHorse(id, h.progress, h.speed, h.lane ?? 1, h.jumpHeight ?? 0, !!h.penalized, id === pid, col, h.name, h.rider, h.horseType, h.laps ?? 0, !!h.shieldActive, h.turboTimer > 0, !!h.finished);
        }

        // ── Hindernisse ──────────────────────────────────────────────────────
        if (state.obstacles) Renderer.updateObstacles(state.obstacles);

        // ── Power-Ups ────────────────────────────────────────────────────────
        if (state.powerups) Renderer.updatePowerups(state.powerups);

        // ── Audio: eigenes Pferd ──────────────────────────────────────────────
        if (pid && state.horses[pid]) {
            const h = state.horses[pid];

            // Hufschlag-Tempo an Geschwindigkeit anpassen
            Audio.setHoofSpeed(h.speed);

            // Sprung-Whoosh (steigende Flanke: jumpHeight geht von 0 auf >0)
            if (h.jumpHeight > 0.1 && prevJumpHeight <= 0.1) Audio.playJump();
            // Landung
            if (h.jumpHeight <= 0.1 && prevJumpHeight > 0.1) Audio.playLand();
            // Treffer
            if (h.penalized && !prevPenalized) Audio.playHit();
            // Zieleinlauf
            if (h.finished && !prevFinished) {
                const pos = state.finishOrder.indexOf(pid);
                Audio.playFinish(pos);
                Audio.playCrowdCheer();
                Renderer.triggerFinishConfetti();
                Renderer.triggerVictoryCamera();
            }
            // Power-Up aufgenommen (steigende Flanke je Typ)
            if (h.turboTimer > 0.1 && prevTurboTimer <= 0.1) Audio.playPowerup('turbo');
            if (h.shieldActive && !prevShieldActive)          Audio.playPowerup('shield');
            if (h.stamina > prevStamina + 30)                 Audio.playPowerup('stamina');
            // Erschöpfung einsetzt
            if (h.exhausted && !prevExhausted)                Audio.playExhausted();

            // Tribünen-Jubel + Zuschauer-Welle beim Vorbeifahren
            if (rs === 'racing') {
                const prog = h.progress || 0;
                if (prevProgress < 490 && prog >= 490) {
                    Audio.playCrowdPass();
                    Renderer.triggerSpectatorWave(0, 1);
                    Renderer.triggerSpectatorWave(0, -1);
                }
                prevProgress = prog;
            }

            prevJumpHeight   = h.jumpHeight;
            prevPenalized    = h.penalized;
            prevFinished     = h.finished;
            prevTurboTimer   = h.turboTimer;
            prevShieldActive = h.shieldActive;
            prevStamina      = h.stamina;
            prevExhausted    = h.exhausted;

            // HUD
            const pct = Math.round(h.stamina);
            document.getElementById('speed').textContent      = `⚡ ${h.speed.toFixed(1)}`;
            document.getElementById('stamBar').style.width    = pct + '%';
            document.getElementById('stamBar').style.background =
                h.exhausted ? '#880000' : pct > 50 ? '#4caf50' : pct > 25 ? '#ff9800' : '#f44336';
            const stamLabelEl = document.getElementById('stamLabel');
            if (stamLabelEl) stamLabelEl.textContent = h.exhausted ? 'Stamina: 😮‍💨 Erschöpft!' : 'Stamina:';
            if (rs === 'racing' || rs === 'countdown')
                document.getElementById('lapNum').textContent = Math.min(h.laps + 1, state.totalLaps);

            // Live-Lap-Timer
            if (rs === 'racing') {
                const timerEl = document.getElementById('lapTimer');
                if (timerEl) timerEl.textContent = fmtTime(h.currentLapTime);
            }

            // Rundenzeit-Split einblenden wenn Runde abgeschlossen
            if (h.lapTimes && h.lapTimes.length > prevLapCount && prevLapCount >= 0) {
                Audio.playCrowdPass();
                Renderer.triggerSpectatorWave(0, 1);
                Renderer.triggerSpectatorWave(0, -1);
                const lapIdx  = h.lapTimes.length - 1;
                const lapSec  = h.lapTimes[lapIdx];
                const splitEl = document.getElementById('lapSplit');
                if (splitEl) {
                    clearTimeout(splitTimeout);
                    splitEl.textContent = `Runde ${lapIdx + 1}: ${fmtTime(lapSec)}`;
                    splitEl.style.display = 'block';
                    splitTimeout = setTimeout(() => { splitEl.style.display = 'none'; }, 3000);
                }
            }
            prevLapCount = h.lapTimes ? h.lapTimes.length : 0;

            // Buff-Anzeige
            const buffEl = document.getElementById('buffs');
            if (buffEl) {
                const parts = [];
                if (h.turboActive)    parts.push(`<span style="color:#ffd700">⚡ Turbo ${h.turboTimer.toFixed(1)}s</span>`);
                if (h.shieldActive)   parts.push(`<span style="color:#55aaff">🛡️ Schild</span>`);
                if (h.slipstream)     parts.push(`<span style="color:#aaffcc">💨 Windschatten</span>`);
                buffEl.innerHTML = parts.join('');
            }
        }

        // ── Platzierung ──────────────────────────────────────────────────────
        if (state.ranking?.length > 0 && (rs === 'racing' || rs === 'countdown')) {
            const medals = ['🥇','🥈','🥉'];
            document.getElementById('rankList').innerHTML = state.ranking.map((id, i) => {
                const name = id === pid
                    ? 'Du'
                    : (state.horses[id]?.name || '?');
                const horse = state.horses[id];
                const ICONS = { blitz:'⚡', sturm:'🌪', nebel:'🌫', feuer:'🔥' };
                const icon  = ICONS[horse?.horseType] || '🐴';
                return `<div class="rank-entry ${id===pid?'me':''}">
                    <span class="rank-pos">${medals[i] ?? (i+1)+'.'}  </span>
                    <span class="rank-icon">${icon}</span>
                    <span class="rank-name">${name}</span>
                </div>`;
            }).join('');
            show('ranking');
        }

        // ── Race-State ───────────────────────────────────────────────────────
        if (rs === 'waiting') {
            hideAll();
            hide('minimap');
            Audio.stopBgMusic();
            document.getElementById('status').textContent = 'Rennen startet gleich...';
        }

        if (rs === 'countdown') {
            hide('results'); show('lapDisplay'); show('ranking'); show('minimap');
            if (state.countdown !== prevCountdown) {
                prevCountdown = state.countdown;
                showCountdown(state.countdown, false);
                Audio.playCountdownBeep(state.countdown);
            }
            show('countdown');
        }

        if (rs === 'racing' && prevRaceState === 'countdown') {
            clearTimeout(goTimeout);
            showCountdown('GO!', true);
            show('countdown');
            goTimeout = setTimeout(() => hide('countdown'), 1100);
            show('lapDisplay'); show('ranking');
            document.getElementById('status').textContent = 'Rennen läuft!';
            Audio.playGo();
            Audio.playCrowdCheer();
            Audio.startBgMusic();
            Audio.startHoofLoop();
            Renderer.triggerSpectatorWave(0, 1);
            Renderer.triggerSpectatorWave(0, -1);
        }

        if (rs === 'racing' && prevRaceState !== 'racing' && prevRaceState !== 'countdown') {
            hide('countdown'); show('lapDisplay'); show('ranking');
            document.getElementById('status').textContent = 'Rennen läuft!';
            Audio.startBgMusic();
            Audio.startHoofLoop();
        }

        if (rs === 'results' && prevRaceState !== 'results') {
            hide('countdown'); hide('lapDisplay'); hide('ranking'); hide('minimap');
            Audio.stopBgMusic();
            Renderer.resetVictoryCamera();

            // Bereit-Button zurücksetzen
            _setReadyUI(false);

            // ── Eigene Zeit speichern & Rekord prüfen ─────────────────────────
            const myHorse = pid ? state.horses[pid] : null;
            const badge   = document.getElementById('recordBadge');
            if (myHorse?.finishTime != null) {
                const prev     = hsPersonalBest(playerName, horseType);
                const isRecord = !prev || myHorse.finishTime < prev.time;
                if (badge) badge.style.display = isRecord ? 'inline-block' : 'none';
                hsSave({
                    name: playerName, horse: horseType,
                    time: myHorse.finishTime, laps: myHorse.lapTimes || [],
                    savedAt: Date.now(),
                });
            } else {
                if (badge) badge.style.display = 'none';
            }

            // ── Podium befüllen ───────────────────────────────────────────────
            // Visuelle Reihenfolge: links=2., mitte=1., rechts=3.
            const podMap = [
                { elId: 'pod2', finishIdx: 1 },
                { elId: 'pod1', finishIdx: 0 },
                { elId: 'pod3', finishIdx: 2 },
            ];
            podMap.forEach(({ elId, finishIdx }) => {
                const id    = state.finishOrder[finishIdx];
                const slotEl = document.getElementById(elId);
                if (!slotEl) return;
                if (!id) { slotEl.style.visibility = 'hidden'; return; }
                slotEl.style.visibility = '';

                const h    = state.horses[id];
                const isMe = id === pid;
                const displayName = isMe ? playerName : (h?.name || 'Pferd');
                const time = h?.finishTime != null ? fmtTime(h.finishTime) : '--';

                slotEl.querySelector('.pod-avatar').textContent = isMe ? '🏇' : '🐴';
                const nameEl = slotEl.querySelector('.pod-name');
                nameEl.textContent = displayName + (isMe ? ' 👈' : '');
                nameEl.className   = 'pod-name' + (isMe ? ' is-me' : '');
                slotEl.querySelector('.pod-time').textContent = '⏱ ' + time;
            });

            // ── Detaillierte Ergebnistabelle ──────────────────────────────────
            const medals = ['🥇','🥈','🥉'];
            document.getElementById('resultsList').innerHTML = state.finishOrder.map((id, i) => {
                const hd    = state.horses[id];
                const isMe  = id === pid;
                const total = hd?.finishTime != null ? fmtTime(hd.finishTime) : '--';
                const name  = isMe ? `<b>${playerName}</b>` : (hd?.name || 'Pferd '+(i+1));
                const laps  = (hd?.lapTimes || []).map((t, li) =>
                    `<span>R${li+1}: ${fmtTime(t)}</span>`
                ).join('');
                const delay = `animation-delay:${i * 0.09}s`;
                return `<div class="result-row ${i===0?'winner':''} ${isMe?'is-me':''}" style="${delay}">
                    <span class="rr-medal">${medals[i] ?? (i+1)+'.'}</span>
                    <span class="rr-name">${name}</span>
                    <div class="rr-laps">${laps}</div>
                    <span class="rr-total">⏱ ${total}</span>
                </div>`;
            }).join('');

            show('results');
        }

        // Ready-Anzeige im Ergebnis-Screen laufend aktualisieren
        if (rs === 'results') {
            const el = document.getElementById('resultsReadyCount');
            if (el) {
                const total = Object.keys(state.horses || {}).length;
                const ready = (state.readyPlayers || []).length;
                el.textContent = ready > 0 ? `${ready}/${total} bereit` : '';
            }
        }

        if (rs === 'countdown' && prevRaceState !== 'countdown') {
            Renderer.clearObstacles();
            Renderer.clearPowerups();

            // Wetter anwenden (nur wenn sich das Preset geändert hat)
            if (state.weatherPreset && state.weatherPreset !== _appliedWeather) {
                _appliedWeather = state.weatherPreset;
                Renderer.setWeather(state.weatherPreset);
                _showWeatherToast(state.weatherPreset);
            }
            prevJumpHeight = 0; prevPenalized = false; prevFinished = false;
            prevLapCount = 0; prevTurboTimer = 0; prevShieldActive = false;
            prevStamina = 100; prevExhausted = false; prevProgress = 0;
            const buffEl  = document.getElementById('buffs');
            const timerEl = document.getElementById('lapTimer');
            const splitEl = document.getElementById('lapSplit');
            if (buffEl)  buffEl.innerHTML   = '';
            if (timerEl) timerEl.textContent = '0:00.00';
            if (splitEl) splitEl.style.display = 'none';
        }

        // ── Lobby ────────────────────────────────────────────────────────────
        if (rs === 'lobby') {
            hideAll();
            hide('minimap');
            Audio.stopBgMusic();

            // Lobby-Panel anzeigen
            show('lobbyPanel');

            // Bereit-Status
            const rdEl = document.getElementById('lobbyReadyCount');
            if (rdEl) {
                const total   = Object.keys(state.horses || {}).length;
                const readyCt = (state.readyPlayers || []).length;
                rdEl.textContent = `${readyCt}/${total} bereit`;
            }

            // Spielerliste
            const listEl = document.getElementById('lobbyPlayerList');
            if (listEl) {
                const readySet = new Set(state.readyPlayers || []);
                listEl.innerHTML = Object.values(state.horses || {}).map(h => {
                    const isReady = readySet.has(h.id);
                    const isMe    = h.id === pid;
                    const HORSE_LABELS = { blitz:'⚡', sturm:'🌪️', nebel:'🌫️', feuer:'🔥' };
                    return `<div class="lobby-player ${isMe ? 'lobby-me' : ''}">
                        <span class="lobby-ready-dot" style="color:${isReady ? '#22ee55' : '#555'}">●</span>
                        <span class="lobby-pname">${h.name || 'Fahrer'}${isMe ? ' (Du)' : ''}</span>
                        <span class="lobby-horse">${HORSE_LABELS[h.horseType] || '🐴'} ${h.horseType || ''}</span>
                        <span class="lobby-status">${isReady ? '✓ Bereit' : 'Wartet...'}</span>
                    </div>`;
                }).join('');
            }

            // Eigener Bereit-Button zurücksetzen wenn wir gerade in die Lobby kommen
            if (prevRaceState !== 'lobby') {
                _setReadyUI(false);
            }
        } else {
            hide('lobbyPanel');
        }

        prevRaceState = rs;
    },
    onChat: (chatMsg) => {
        addChatMessage(chatMsg.sender, chatMsg.message);
    },
    onLobbyList: (lobbies) => {
        renderLobbyBrowser(lobbies);
    },
    onError: (err) => {
        const el = document.getElementById('lobbyBrowserError');
        if (el) { el.textContent = '⚠ ' + err.message; el.style.display = 'block'; }
    },
    onInit: (msg) => {
        _inLobby   = true;
        _lobbyName = msg.lobbyName || null;
        hide('lobbyBrowser');
        // Lobby-Name im HUD anzeigen
        const h2 = document.querySelector('#ui h2');
        if (h2 && _lobbyName) h2.textContent = '🏇 ' + _lobbyName;
    },
    });

    function _showWeatherToast(preset) {
        const NAMES = {
            sunny:  '☀️ Sonnig',
            sunset: '🌅 Sonnenuntergang',
            night:  '🌙 Nacht',
            dawn:   '🌄 Morgendämmerung',
            rainy:  '🌧️ Regen',
            foggy:  '🌫️ Neblig',
        };
        const el = document.getElementById('weatherToast');
        if (!el) return;
        el.textContent = NAMES[preset] || preset;
        el.classList.add('visible');
        clearTimeout(_weatherToastTimer);
        _weatherToastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
    }

    function showCountdown(text, isGo) {
        const el = document.getElementById('countdownNumber');
        el.className = isGo ? 'go' : '';
        el.textContent = text;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
    }

    const FLEX_IDS = new Set(['countdown', 'results', 'lobbyPanel', 'lobbyBrowser']);
    function show(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = FLEX_IDS.has(id) ? 'flex' : 'block';
    }
    function hide(id)  { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
    function hideAll() {
        ['countdown', 'results', 'ranking', 'lapDisplay', 'lobbyPanel', 'lobbyBrowser'].forEach(hide);
    }
}
