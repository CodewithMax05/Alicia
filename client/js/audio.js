const Audio = (() => {
    let ctx         = null;
    let masterGain  = null;
    let bgNode      = null;
    let hoofTimer   = null;
    // Flags: Musik/Hufschlag soll laufen, sobald AudioContext bereit ist
    let _wantBg     = false;
    let _wantHoof   = false;

    // AudioContext erst nach User-Interaktion erstellen (Browser-Anforderung)
    function getCtx() {
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = ctx.createGain();
            masterGain.gain.value = 0.6;
            masterGain.connect(ctx.destination);
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

    function noiseShot(start, dur, cutoff, vol) {
        const c = getCtx();
        const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = c.createBufferSource();
        src.buffer = buf;
        const f = c.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = cutoff;
        const g = c.createGain();
        g.gain.setValueAtTime(vol, start);
        g.gain.exponentialRampToValueAtTime(0.001, start + dur);
        src.connect(f); f.connect(g); g.connect(masterGain);
        src.start(start);
    }

    // ── Sound-Effekte ─────────────────────────────────────────────────────────

    function playHoof() {
        const t = getCtx().currentTime;
        noiseShot(t,       0.04, 300, 0.18);   // dumpfer Aufprall
        noiseShot(t + 0.04,0.03, 600, 0.08);   // kurzes Nachklingen
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
        } else {
            // Stamina: angenehmes Ding-Dong
            osc(523,  'sine', t,       0.18, 0.18);
            osc(784,  'sine', t + 0.1, 0.18, 0.15);
            osc(1047, 'sine', t + 0.2, 0.14, 0.12);
        }
    }

    function playExhausted() {
        const t = getCtx().currentTime;
        // Keuchendes / erschöpftes Geräusch
        noiseShot(t,        0.18, 900,  0.14);
        noiseShot(t + 0.22, 0.14, 600,  0.10);
        osc(140, 'sine', t, 0.35, 0.07, 90);
    }

    // Jubel = gefiltertes Rauschen in drei Stimm-Formant-Bändern — kein Oszillator!
    function _crowdSound(vol, dur) {
        const c = getCtx();
        const t = c.currentTime;

        // Lautstärke-Hüllkurve: schnell anschwellen, halten, langsam abklingen
        const env = c.createGain();
        env.gain.setValueAtTime(0,   t);
        env.gain.linearRampToValueAtTime(vol, t + 0.13);
        env.gain.setValueAtTime(vol,  t + dur * 0.5);
        env.gain.exponentialRampToValueAtTime(0.001, t + dur);
        env.connect(masterGain);

        // Rausch-Puffer (geteilt von allen Bändern)
        const bufLen = Math.ceil(c.sampleRate * (dur + 0.2));
        const buf    = c.createBuffer(1, bufLen, c.sampleRate);
        const d      = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;

        // Drei Bänder wie bei menschlichem Jubel:
        //   300 Hz  = tiefer Crowd-Rumble / Bassstimmen
        //   900 Hz  = „Ahhh"-Vokal-Formant (das Herz des Jubels)
        //  2400 Hz  = hohe Aufregung / Jauchzen
        for (const [freq, Q, gain] of [
            [300,  1.0, 0.6],
            [900,  2.2, 0.9],
            [2400, 1.4, 0.4],
        ]) {
            const src = c.createBufferSource();
            src.buffer = buf;
            const bp = c.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = freq;
            bp.Q.value = Q;
            const g = c.createGain();
            g.gain.value = gain;
            src.connect(bp); bp.connect(g); g.connect(env);
            src.start(t);
        }
    }

    function playCrowdCheer() { _crowdSound(1.0,  2.0); }  // Zieleinlauf / GO
    function playCrowdPass()  { _crowdSound(0.65, 1.4); }  // Vorbeifahren

    function playFinish(position) {
        const t = getCtx().currentTime;
        if (position === 0) {
            // Sieges-Fanfare
            [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => {
                osc(f, 'square', t + i * 0.09, 0.2, 0.3);
            });
        } else {
            osc(330, 'sawtooth', t,      0.3, 0.2, 200);
            osc(200, 'sine',     t + 0.1, 0.3, 0.15);
        }
    }

    // ── Hufschlag-Rhythmus ────────────────────────────────────────────────────
    // Wird basierend auf Geschwindigkeit getaktet

    let _speed = 0;

    function setHoofSpeed(speed) { _speed = speed; }

    function _hoofLoop() {
        if (_speed > 2) {
            playHoof();
            // Galopp-Muster: 3 Schläge pro Zyklus (da-da-DUM)
            const interval = Math.max(60, 350 - _speed * 9);
            hoofTimer = setTimeout(() => {
                if (_speed > 2) {
                    playHoof();
                    hoofTimer = setTimeout(() => {
                        if (_speed > 2) playHoof();
                        hoofTimer = setTimeout(_hoofLoop, interval * 1.3);
                    }, interval * 0.7);
                } else {
                    hoofTimer = setTimeout(_hoofLoop, interval);
                }
            }, interval * 0.55);
        } else {
            hoofTimer = setTimeout(_hoofLoop, 200);
        }
    }

    // ── Hintergrundmusik ──────────────────────────────────────────────────────
    // Einfacher synthethischer Renn-Loop mit Web Audio API

    const BG_NOTES  = [392, 440, 494, 523, 587, 659, 523, 494]; // G A B C D E C B
    const BG_DRUMS  = [1,0,0,1, 0,1,0,0, 1,0,0,1, 0,1,0,0];    // Kick/Snare pattern
    let bgBeat = 0, bgHandle = null;

    function _startBgLoop() {
        if (bgHandle) return;
        bgBeat = 0;
        const BPM      = 148;
        const beatMs   = (60 / BPM) * 1000;

        bgHandle = setInterval(() => {
            const c = getCtx();
            const t = c.currentTime;

            // Drums
            if (BG_DRUMS[bgBeat % 16] === 1) {
                if (bgBeat % 16 < 8) {
                    noiseShot(t, 0.08, 120, 0.12);            // Kick
                    osc(80, 'sine', t, 0.1, 0.12);
                } else {
                    noiseShot(t, 0.06, 5000, 0.06);           // Snare
                }
            }
            // Hi-Hat jeden halben Beat
            noiseShot(t, 0.025, 8000, 0.025);

            // Melodie (alle 2 Beats)
            if (bgBeat % 2 === 0) {
                const note = BG_NOTES[(bgBeat / 2) % BG_NOTES.length];
                osc(note / 2, 'triangle', t, 0.22, 0.06);   // eine Oktave tiefer, leise
            }

            bgBeat++;
        }, beatMs / 2); // 8th notes
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
        init, setHoofSpeed, startHoofLoop, stopBgMusic, startBgMusic,
        playJump, playLand, playHit, playCountdownBeep, playGo, playFinish,
        playPowerup, playExhausted, playCrowdCheer, playCrowdPass,
    };
})();
