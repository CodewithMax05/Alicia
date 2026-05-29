const Audio = (() => {
    let ctx         = null;
    let masterGain  = null;
    let bgNode      = null;
    let hoofTimer   = null;
    // Flags: Musik/Hufschlag soll laufen, sobald AudioContext bereit ist
    let _wantBg     = false;
    let _wantHoof   = false;

    // ── Optionale Sound-Dateien (werden aus client/sounds/ geladen) ───────────
    // Lege eigene MP3/OGG-Dateien ab — wird genutzt wenn vorhanden, sonst Synthese
    const _buffers = {};   // { cheer: AudioBuffer, pass: AudioBuffer }

    async function _loadSounds() {
        for (const [name, url] of [['pass', 'sounds/pass.mp3'], ['horse', 'sounds/horse.mp3']]) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const arr  = await resp.arrayBuffer();
                _buffers[name] = await ctx.decodeAudioData(arr);
                console.log(`[Audio] ${url} geladen`);
            } catch { /* nicht vorhanden → Synthese-Fallback */ }
        }
    }

    // Pferde-Wiehern mit variabler Abspielgeschwindigkeit (Tonhöhe + Energie)
    function _playHorse(rate = 1.0, vol = 0.85) {
        if (!_buffers['horse']) return;
        const src = ctx.createBufferSource();
        src.buffer = _buffers['horse'];
        src.playbackRate.value = rate;
        const g = ctx.createGain();
        g.gain.value = vol;
        src.connect(g); g.connect(masterGain);
        src.start(ctx.currentTime);
    }

    function _playBuffer(name, vol = 1.0) {
        if (!_buffers[name]) return false;
        const src = ctx.createBufferSource();
        src.buffer = _buffers[name];
        const g = ctx.createGain();
        g.gain.value = vol;
        src.connect(g); g.connect(masterGain);
        src.start(ctx.currentTime);
        return true;
    }

    // AudioContext erst nach User-Interaktion erstellen (Browser-Anforderung)
    function getCtx() {
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = ctx.createGain();
            masterGain.gain.value = 0.6;
            masterGain.connect(ctx.destination);
            _loadSounds();   // Sound-Dateien im Hintergrund laden
            // Nachgeholt: War Musik/Hufschlag bereits angefordert?
            if (_wantBg)   _startBgLoop();
            if (_wantHoof) _hoofLoop();
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    // ── Hilfsfunktionen ───────────────────────────────────────────────────────

    function osc(freq, type, start, dur, vol, freqEnd) {
        const c = getCtx();
        const o = c.createOscillator();
        const g = c.createGain();
        o.connect(g); g.connect(masterGain);
        o.type = type;
        o.frequency.setValueAtTime(freq, start);
        if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, start + dur);
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(vol, start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, start + dur);
        o.start(start);
        o.stop(start + dur + 0.02);
    }

    // Geteilter Noise-Buffer — einmalig generiert, von allen Noise-Funktionen wiederverwendet.
    // Verhindert wiederholte Heap-Allokationen und GC-Spikes auf dem Main-Thread.
    let _noiseBuf = null;
    function _getNoiseBuf() {
        if (_noiseBuf) return _noiseBuf;
        _noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 3.0), ctx.sampleRate);
        const d = _noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        return _noiseBuf;
    }

    function noiseShot(start, dur, cutoff, vol) {
        const c = getCtx();
        const src = c.createBufferSource();
        src.buffer = _getNoiseBuf();
        const f = c.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = cutoff;
        const g = c.createGain();
        g.gain.setValueAtTime(vol, start);
        g.gain.exponentialRampToValueAtTime(0.001, start + dur);
        src.connect(f); f.connect(g); g.connect(masterGain);
        src.start(start);
        src.stop(start + dur + 0.02);   // stop() muss nach start() kommen
    }

    // Bandpass-Rauschen: Frequenzband zwischen freqLo und freqHi, mit optionalem Attack
    function bandNoise(start, dur, freqLo, freqHi, vol, attack) {
        const c = getCtx();
        const src = c.createBufferSource();
        src.buffer = _getNoiseBuf();
        const hp = c.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = freqLo;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';  lp.frequency.value = freqHi;
        const g = c.createGain();
        const att = attack || 0.005;
        g.gain.setValueAtTime(0.001, start);
        g.gain.linearRampToValueAtTime(vol, start + att);
        g.gain.exponentialRampToValueAtTime(0.001, start + dur);
        src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(masterGain);
        src.start(start);
        src.stop(start + dur + 0.02);   // stop() muss nach start() kommen
    }

    // ── Sound-Effekte ─────────────────────────────────────────────────────────

    function playHoof(vol = 1.0) {
        const t = getCtx().currentTime;
        noiseShot(t, 0.06, 320, 0.24 * vol);    // dumpfer Aufprall
        osc(72, 'sine', t, 0.09, 0.10 * vol);   // tiefe Resonanz
    }

    function playJump() {
        const t = getCtx().currentTime;
        osc(380, 'sawtooth', t, 0.25, 0.18, 140);   // fallende Frequenz = Whoosh
        noiseShot(t, 0.15, 2000, 0.05);
    }

    function playLand() {
        const t = getCtx().currentTime;
        noiseShot(t, 0.08, 350, 0.25);
        osc(90, 'sine', t, 0.12, 0.2);
    }

    function playHit() {
        const t = getCtx().currentTime;
        noiseShot(t, 0.18, 500, 0.35);
        osc(120, 'sawtooth', t, 0.2, 0.15, 60);
    }

    function playCountdownBeep(num) {
        const t = getCtx().currentTime;
        const freq = num === 1 ? 660 : 440;
        osc(freq, 'sine', t, 0.18, 0.45);
    }

    function playGo() {
        const t = getCtx().currentTime;
        [523, 659, 784, 1047].forEach((f, i) => {
            osc(f, 'square', t + i * 0.07, 0.18, 0.35);
        });
        _playHorse(1.25, 1.20);   // aufgeregtes Wiehern beim Start
    }

    function playPowerup(type) {
        const t = getCtx().currentTime;
        if (type === 'turbo') {
            // Schneller aufsteigender Energie-Sweep
            osc(300, 'sawtooth', t,        0.11, 0.22, 650);
            osc(450, 'sawtooth', t + 0.08, 0.11, 0.20, 1000);
            osc(700, 'square',   t + 0.16, 0.09, 0.16, 1400);
        } else if (type === 'shield') {
            // Magischer Schild-Klang
            osc(880,  'sine', t,        0.28, 0.14);
            osc(1320, 'sine', t + 0.06, 0.22, 0.12);
            osc(1760, 'sine', t + 0.12, 0.18, 0.10);
            noiseShot(t, 0.12, 4000, 0.04);
        } else if (type === 'blitz') {
            // ── Elektrischer Zap ──────────────────────────────────────
            osc(2400, 'sawtooth', t,        0.055, 0.28, 120);  // Zischen: hoch→tief
            osc(1100, 'square',   t + 0.01, 0.030, 0.22,  55);  // Crackle-Oberton
            // ── Einschlag-Crack ───────────────────────────────────────
            noiseShot(t + 0.04, 0.009, 20000, 0.90);            // weißes Knack-Transient
            noiseShot(t + 0.04, 0.030,  5000, 0.65);            // Körper des Einschlags
            // ── Donner-Rumble (mehrschichtig) ─────────────────────────
            bandNoise(t + 0.05, 1.4,  30,  180, 0.55, 0.018);  // tiefer Hauptdonner
            bandNoise(t + 0.06, 1.0,  90,  480, 0.38, 0.012);  // mittlerer Donner
            bandNoise(t + 0.10, 0.8, 200,  900, 0.22, 0.008);  // heller Nachhall
            bandNoise(t + 0.35, 1.8,  25,  130, 0.28, 0.060);  // langes Nachgrollen
            osc(44, 'sine', t + 0.05, 0.9, 0.22);               // Sub-Bass Wumms
        } else {
            // Stamina: angenehmes Ding-Dong
            osc(523,  'sine', t,       0.18, 0.18);
            osc(784,  'sine', t + 0.1, 0.18, 0.15);
            osc(1047, 'sine', t + 0.2, 0.14, 0.12);
        }
    }

    function playExhausted() {
        _playHorse(0.68, 1.20);   // erschöpftes Wiehern (langsam = tief + müde)
    }

    // Kein Jubel-Sound — nur eigene Datei wenn vorhanden (client/sounds/pass.mp3)
    function playCrowdCheer() { /* kein Sound */ }
    function playCrowdPass()  { _playBuffer('pass', 0.7); }

    // Erschrockenes Wiehern (z.B. Blitz-Treffer) — schnell = hoch = erschrocken
    function playHorseScared() { _playHorse(1.55, 1.20); }

    function playFinish(position) {
        const t = getCtx().currentTime;
        if (position === 0) {
            // Sieges-Fanfare
            [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => {
                osc(f, 'square', t + i * 0.09, 0.2, 0.3);
            });
        } else {
            osc(330, 'sawtooth', t,       0.3, 0.2, 200);
            osc(200, 'sine',     t + 0.1, 0.3, 0.15);
        }
    }

    // ── Hufschlag-Rhythmus ────────────────────────────────────────────────────
    // Wird basierend auf Geschwindigkeit getaktet

    let _speed   = 0;
    let _jumping = false;

    function setHoofSpeed(speed)  { _speed   = speed; }
    function setJumping(isJump)   { _jumping = isJump; }

    function _hoofLoop() {
        // Kein Hufschlag während des Sprungs
        if (_jumping) {
            hoofTimer = setTimeout(_hoofLoop, 80);
            return;
        }

        if (_speed > 2) {
            // Basis-Schlaginterval: speed=5→330ms, speed=15→235ms, speed=30→95ms
            const beatMs = Math.max(90, 370 - _speed * 9.2);

            if (_speed < 11) {
                // ── Trab: zwei gleichmäßige Schläge, mittlere Pause ──────────
                // Klingt wie: ta-ta … ta-ta …
                playHoof(0.80);
                hoofTimer = setTimeout(() => {
                    if (!_jumping && _speed > 2) playHoof(0.90);
                    hoofTimer = setTimeout(_hoofLoop, beatMs * 1.0);
                }, beatMs * 1.05);

            } else {
                // ── Galopp: ungleichmäßiges quick-quick-HEAVY Muster ─────────
                // Erster Schlag: weich
                // Zweiter Schlag: schnell dahinter (0.45× Abstand)
                // Dritter Schlag: schwerer Hauptschlag (0.80× Abstand weiter)
                // Dann längere Pause (1.5× beatMs)
                playHoof(0.70);
                hoofTimer = setTimeout(() => {
                    if (!_jumping && _speed > 2) playHoof(0.80);
                    hoofTimer = setTimeout(() => {
                        if (!_jumping && _speed > 2) playHoof(1.15); // schwerer Hauptschlag
                        hoofTimer = setTimeout(_hoofLoop, beatMs * 1.5);
                    }, Math.round(beatMs * 0.80));
                }, Math.round(beatMs * 0.45));
            }
        } else {
            hoofTimer = setTimeout(_hoofLoop, 300);
        }
    }

    // ── Hintergrundmusik ──────────────────────────────────────────────────────
    // Lookahead-Scheduler: Audio wird 120ms im Voraus geplant → kein Main-Thread-Lag
    // Stil: ruhige keltisch/folk-angehauchte Begleitung, 96 BPM, C–Am–F–G

    const _BG_LOOKAHEAD = 0.12;               // Sekunden vorausplanen
    const _BG_STEP_DUR  = (60 / 72) / 2;     // Achtelnote bei 72 BPM ≈ 0.417 s (ruhig)

    // 16-Schritt-Sequenz (Achtelnoten). 0 = Pause
    // Sparsame Melodie — viele Pausen, wenige Noten (Fahrstuhl-Stil)
    const BG_MEL    = [659,  0,  0,  0, 784,  0,  0, 659, 523,  0,  0,  0, 587,  0, 523,  0];
    // Bass — nur Grundton, bewegt sich kaum
    const BG_BASS   = [131,  0,  0,  0, 110,  0,  0,   0, 175,  0,  0,  0, 196,  0,   0,  0];
    // Sanfte Akkord-Pads: C – Am – F – G (Sinus, lang überlappend)
    const BG_CHORDS = [
        [262, 330, 392],  // C-Dur  (Schritt  0)
        [220, 262, 330],  // Am     (Schritt  4)
        [175, 220, 262],  // F-Dur  (Schritt  8)
        [196, 247, 294],  // G-Dur  (Schritt 12)
    ];

    let _bgNextTime = 0, _bgStep = 0, bgHandle = null;

    function _scheduleBgStep(t, step) {
        const s = step % 16;

        // Melodie (Sinus, sehr weich, lange Sustain)
        if (BG_MEL[s] > 0) osc(BG_MEL[s], 'sine', t, 0.55, 0.018);

        // Bass (Sinus, dezent)
        if (BG_BASS[s] > 0) osc(BG_BASS[s], 'sine', t, 0.42, 0.022);

        // Akkord-Pads — Töne leicht versetzt einspielen (weicher Wash-Effekt)
        const ci = [0, 4, 8, 12].indexOf(s);
        if (ci >= 0) BG_CHORDS[ci].forEach((f, i) => osc(f, 'sine', t + i * 0.045, 1.9, 0.010));
        // kein Schlagzeug, keine Hi-Hats
    }

    function _startBgLoop() {
        if (bgHandle) return;
        _bgStep     = 0;
        _bgNextTime = getCtx().currentTime + 0.10;

        // Feuert alle 75ms — prüft ob neue Schritte geplant werden müssen.
        // Der eigentliche Audio-Aufwand läuft im Audio-Thread, nicht hier.
        bgHandle = setInterval(() => {
            if (!ctx) return;
            const limit = ctx.currentTime + _BG_LOOKAHEAD;
            while (_bgNextTime < limit) {
                try { _scheduleBgStep(_bgNextTime, _bgStep); } catch(e) { console.warn('[Audio] BG:', e); }
                _bgNextTime += _BG_STEP_DUR;   // immer vorrücken, auch bei Fehler
                _bgStep++;
            }
        }, 75);
    }

    function startBgMusic() {
        _wantBg = true;
        if (ctx) _startBgLoop();   // AudioContext schon bereit → sofort starten
    }

    function stopBgMusic() {
        _wantBg = false; _wantHoof = false;
        if (bgHandle)  { clearInterval(bgHandle); bgHandle  = null; }
        if (hoofTimer) { clearTimeout(hoofTimer);  hoofTimer = null; }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        // AudioContext bei erster Nutzerinteraktion erstellen
        const unlock = () => { getCtx(); };
        document.addEventListener('keydown',    unlock, { once: true });
        document.addEventListener('click',      unlock, { once: true });
        document.addEventListener('touchstart', unlock, { once: true });
    }

    function startHoofLoop() {
        _wantHoof = true;
        if (ctx && !hoofTimer) _hoofLoop();
    }

    return {
        init, setHoofSpeed, setJumping, startHoofLoop, stopBgMusic, startBgMusic,
        playJump, playLand, playHit, playCountdownBeep, playGo, playFinish,
        playPowerup, playExhausted, playCrowdCheer, playCrowdPass, playHorseScared,
    };
})();
