const TRACK_LENGTH  = 1000;
const GRAVITY       = 30;

// Spurversatz: [-3.5, 0, +3.5] für Innen/Mitte/Außen
const LANE_OFFSETS = [-3.5, 0, 3.5];

// ── Frozen Circuit – Kontrollpunkte [x, z] für Catmull-Rom-Spline ─────────────
// 14 Punkte → 6 echte Kurven: 2 Haarnadeln, lange Gerade, S-Kurven-Sektor
const ARCTIC_PTS = [
    [ 70,  -2],  //  0  Start/Ziel
    [ 76, -18],  //  1  Kurve 1 – Einfahrt (weiter Rechtsbogen)
    [ 62, -36],  //  2  Kurve 1 – Scheitelpunkt
    [ 28, -44],  //  3  untere Gerade rechts
    [ -2, -44],  //  4  untere Gerade Mitte
    [-30, -42],  //  5  untere Gerade links
    [-58, -30],  //  6  Kurve 2 – Einfahrt (linke Haarnadelkurve)
    [-76,  -6],  //  7  Kurve 2 – Scheitelpunkt (eng!)
    [-62,  20],  //  8  Kurve 2 – Ausfahrt
    [-34,  36],  //  9  obere Gerade links
    [ -6,  38],  // 10  S-Kurve Anfang
    [ 16,  28],  // 11  S-Kurve – erster Bogen
    [ 34,  36],  // 12  S-Kurve – zweiter Bogen
    [ 60,  20],  // 13  Schlusskurve zurück zum Start
];

// ── Catmull-Rom-Interpolation (ein Segment) ────────────────────────────────────
function _crPt(p0, p1, p2, p3, t) {
    const t2 = t*t, t3 = t2*t;
    return [
        0.5*(2*p1[0]+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
        0.5*(2*p1[1]+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3),
    ];
}

// ── Lookup-Table aufbauen: N Punkte, gleichmäßig im Spline-Parameter ──────────
function _buildSplineLUT(pts, N) {
    const n = pts.length;
    const xs = new Float32Array(N), zs = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const u = (i / N) * n;
        const seg = Math.floor(u) % n, t = u - Math.floor(u);
        const r = _crPt(pts[(seg-1+n)%n], pts[seg], pts[(seg+1)%n], pts[(seg+2)%n], t);
        xs[i] = r[0]; zs[i] = r[1];
    }
    const nx = new Float32Array(N), nz = new Float32Array(N), arc = new Float32Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) {
        if (i > 0) { const dx=xs[i]-xs[i-1], dz=zs[i]-zs[i-1]; s+=Math.sqrt(dx*dx+dz*dz); }
        arc[i] = s;
        const pi=(i-1+N)%N, ni=(i+1)%N;
        const dx=xs[ni]-xs[pi], dz=zs[ni]-zs[pi], len=Math.sqrt(dx*dx+dz*dz)||1;
        nx[i]=dz/len; nz[i]=-dx/len;   // rechte Senkrechte = nach außen (CCW)
    }
    const wdx=xs[0]-xs[N-1], wdz=zs[0]-zs[N-1];
    return { xs, zs, nx, nz, arc, total: s+Math.sqrt(wdx*wdx+wdz*wdz), N };
}

// ── 2D-Position aus LUT (für Physik/Slipstream) ───────────────────────────────
function _splinePos2D(lut, progress, laneOff) {
    const s = ((progress % TRACK_LENGTH + TRACK_LENGTH) % TRACK_LENGTH) / TRACK_LENGTH * lut.total;
    let lo=0, hi=lut.N-1;
    while (lo<hi-1) { const m=(lo+hi)>>1; if(lut.arc[m]<=s) lo=m; else hi=m; }
    const b=(lo+1)%lut.N;
    const segLen = (b ? lut.arc[b] : lut.total) - lut.arc[lo];
    const t = segLen > 0 ? (s - lut.arc[lo]) / segLen : 0;
    const ex = lut.xs[lo]+(lut.xs[b]-lut.xs[lo])*t;
    const ez = lut.zs[lo]+(lut.zs[b]-lut.zs[lo])*t;
    const enx= lut.nx[lo]+(lut.nx[b]-lut.nx[lo])*t;
    const enz= lut.nz[lo]+(lut.nz[b]-lut.nz[lo])*t;
    const el = Math.sqrt(enx*enx+enz*enz)||1;
    return { x: ex+(enx/el)*laneOff, z: ez+(enz/el)*laneOff };
}

// ── Map-Konfigurationen ───────────────────────────────────────────────────────
// Jede Map hat eigene Ellipsen-Halbachsen, Spurlängen-Skalierung und Arc-Normierung.
//
//  TRACK_A / TRACK_B  – Ellipsen-Halbachsen (müssen mit renderer.js übereinstimmen)
//  LANE_SCALE         – C_mitte / C_spur; schneller auf Innenbahn, langsamer außen
//  AVG_RAW_ARC        – Mittlere Bogenlänge pro Bogensekunde (für physikalisch
//                       gleichmäßige Geschwindigkeit auf Kurve und Geraden)
const MAP_CONFIGS = {
    meadow: {
        TRACK_A:     55,
        TRACK_B:     28,
        LANE_SCALE:  [267.6 / 245.6, 1.000, 267.6 / 289.6],
        AVG_RAW_ARC: 42.60,
        useSpline:   false,
    },
    arctic: {
        // Frozen Circuit: Spline-basierte Strecke mit echten Kurven
        TRACK_A:     0,    // nicht genutzt – Spline übernimmt Positionierung
        TRACK_B:     0,
        LANE_SCALE:  [1.058, 1.000, 0.948],
        AVG_RAW_ARC: 1.0,  // bei Spline: arcNorm = 1.0 (LUT ist bogenparametriert)
        useSpline:   true,
    },
};

// Gibt 2D-Weltposition auf der Strecke zurück (für physische Distanzberechnungen)
// Nutzt Instanz-Variablen this.TRACK_A / this.TRACK_B — muss als Methode aufgerufen werden.
// Standalone-Wrapper für Aufrufe außerhalb der Klasse:
function _trackPos2D_static(progress, laneOffset, trackA, trackB) {
    const t  = (progress / TRACK_LENGTH) * Math.PI * 2;
    const cx = Math.cos(t) * trackA;
    const cz = Math.sin(t) * trackB;
    if (laneOffset === 0) return { x: cx, z: cz };
    const tx  = -Math.sin(t) * trackA;
    const tz  =  Math.cos(t) * trackB;
    const len = Math.sqrt(tx * tx + tz * tz);
    return { x: cx + (tz / len) * laneOffset, z: cz + (-tx / len) * laneOffset };
}

const WEATHER_OPTIONS = ['sunny', 'sunset', 'night', 'dawn', 'rainy', 'foggy'];

const HORSE_TYPES = {
    //         maxSpeed  accel  drain  jump    Konzept
    blitz: { maxSpeed: 34, acceleration: 22, staminaDrain:  9, jumpVelocity: 20 },  // Allrounder — solide in allem, Sprint ~11s
    sturm: { maxSpeed: 32, acceleration: 36, staminaDrain: 10, jumpVelocity: 20 },  // Beschleunigung — schnellste Reaktion, niedrigere Topspeed, Sprint ~10s
    nebel: { maxSpeed: 30, acceleration: 18, staminaDrain:  6, jumpVelocity: 24 },  // Ausdauer — läuft ~17s, aber traagste Topspeed + Beschleunigung
    feuer: { maxSpeed: 40, acceleration: 17, staminaDrain: 10, jumpVelocity: 18 },  // Topspeed — schnellstes Pferd, träge Beschleunigung, Sprint ~10s
};

class RaceManager {
    constructor(onRaceEnd, totalLaps = 2, mapId = 'meadow') {
        this.horses          = new Map();
        this.state           = 'waiting';
        this.countdown       = 0;
        this.finishOrder     = [];
        this.obstacles       = [];
        this.powerups        = [];
        this._raceTime       = 0;
        this.onRaceEnd       = onRaceEnd;
        this.totalLaps       = Math.max(1, Math.min(10, totalLaps));
        this._timer          = null;
        this._lobbyTimer     = null;
        this.weatherPreset   = 'sunny';
        this.readyPlayers    = new Set();
        this._puRespawnQueue = [];   // [{type, timer}]

        // Map-spezifische Physik-Parameter
        this._applyMapConfig(mapId);
    }

    /** Wechselt die Map-Konfiguration (Physik-Parameter). */
    setMap(mapId) {
        this._applyMapConfig(mapId);
    }

    _applyMapConfig(mapId) {
        const cfg = MAP_CONFIGS[mapId] || MAP_CONFIGS.meadow;
        this.mapId       = mapId in MAP_CONFIGS ? mapId : 'meadow';
        this.TRACK_A     = cfg.TRACK_A;
        this.TRACK_B     = cfg.TRACK_B;
        this.LANE_SCALE  = cfg.LANE_SCALE;
        this.AVG_RAW_ARC = cfg.AVG_RAW_ARC;
        // Spline-LUT für nicht-elliptische Strecken
        this.splineLUT   = cfg.useSpline ? _buildSplineLUT(ARCTIC_PTS, 512) : null;
    }

    // ── Pferde ────────────────────────────────────────────────────────────────

    addHorse(id, type = 'blitz', playerName = 'Fahrer', rider = {}) {
        const slot  = this.horses.size;
        const stats = HORSE_TYPES[type] || HORSE_TYPES.blitz;
        this.horses.set(id, {
            id,
            playerName,
            rider,
            horseType:      type,
            jumpVelocity:   stats.jumpVelocity,
            staminaDrain:   stats.staminaDrain,
            rawProgress:    slot * 8,
            progress:       slot * 8,
            speed:          0,
            maxSpeed:       stats.maxSpeed,
            acceleration:   stats.acceleration,
            stamina:        100,
            laps:           0,
            finished:       false,
            accelerating:   false,
            lane:           1,
            laneCooldown:   0,
            prevLaneLeft:   false,
            prevLaneRight:  false,
            jumpHeight:     0,
            isJumping:      false,
            prevJump:       false,
            penaltyTimer:   0,
            shieldActive:    false,
            turboTimer:      0,
            blitzStunTimer:  0,
            _blockCooldown:  0,
            _hitObsId:       null,   // ID des zuletzt treffenden Hindernisses
            _hitObsCooldown: 0,      // Cooldown für dasselbe Hindernis
            exhausted:       false,
            exhaustedTimer:  0,
            lapStartTime:    0,
            lapTimes:        [],
            finishTime:      null,
            slipstream:      false,
            pickupCount:     0,      // erhöht sich bei jeder Aufnahme (auch ohne Effekt)
            lastPickupType:  null,
            shieldHits:      0,      // erhöht sich wenn Schild einen Treffer absorbiert
        });
        if (this.state === 'waiting') this._tryStart();
    }

    removeHorse(id) {
        this.horses.delete(id);
        this.readyPlayers.delete(id);
        if (this.horses.size === 0 && this.state === 'lobby') {
            clearInterval(this._lobbyTimer);
            this.state = 'waiting';
        }
    }

    setReady(id, ready = true) {
        if (ready) this.readyPlayers.add(id);
        else        this.readyPlayers.delete(id);
    }

    returnToLobby() {
        if (this.state !== 'results') return;
        this._startLobby();
    }

    tryStartGame() {
        if (this.state !== 'lobby' && this.state !== 'results') return false;
        const allReady = this.horses.size > 0 &&
                         this.readyPlayers.size >= this.horses.size;
        if (!allReady) return false;
        clearInterval(this._lobbyTimer);
        this._startCountdown();
        return true;
    }

    setInput(id, input) {
        const h = this.horses.get(id);
        if (!h || h.finished) return;

        h.accelerating = !!input.accelerate;

        // Sprung (steigende Flanke)
        if (!!input.jump && !h.prevJump && !h.isJumping) {
            h.isJumping = true;
            h._jumpV    = h.jumpVelocity;
        }
        h.prevJump = !!input.jump;

        // Spurwechsel (steigende Flanke + Cooldown)
        if (h.laneCooldown <= 0) {
            if (!!input.laneLeft  && !h.prevLaneLeft  && h.lane > 0) { h.lane--; h.laneCooldown = 0.35; }
            if (!!input.laneRight && !h.prevLaneRight && h.lane < 2) { h.lane++; h.laneCooldown = 0.35; }
        }
        h.prevLaneLeft  = !!input.laneLeft;
        h.prevLaneRight = !!input.laneRight;
    }

    // ── Race State ────────────────────────────────────────────────────────────

    _tryStart() {
        if (this.horses.size === 0 || this.state !== 'waiting') return;
        clearTimeout(this._timer);
        this._startLobby();
    }

    _startLobby() {
        clearInterval(this._lobbyTimer);
        this.readyPlayers = new Set();
        this.state        = 'lobby';

        // Pferde auf Startposition zurücksetzen (Vorschau)
        let slot = 0;
        for (const h of this.horses.values()) {
            const s = slot * 8;
            Object.assign(h, {
                rawProgress: s, progress: s, speed: 0, laps: 0, finished: false,
                stamina: 100, lane: 1, laneCooldown: 0,
                jumpHeight: 0, isJumping: false,
                penaltyTimer: 0, accelerating: false,
                shieldActive: false, turboTimer: 0, blitzStunTimer: 0, _blockCooldown: 0,
                lapStartTime: 0, lapTimes: [], finishTime: null,
                slipstream: false, pickupCount: 0, lastPickupType: null, shieldHits: 0,
            });
            slot++;
        }
        // Kein automatischer Timer — Spieler müssen manuell "Bereit" drücken.
    }

    _startCountdown() {
        clearInterval(this._lobbyTimer);
        this.readyPlayers    = new Set();
        this._puRespawnQueue = [];
        this.state           = 'countdown';
        this.countdown       = 3;
        this.finishOrder     = [];
        this.obstacles       = this._generateObstacles();
        this.powerups        = this._generatePowerups();
        this._raceTime     = 0;
        this.weatherPreset = WEATHER_OPTIONS[Math.floor(Math.random() * WEATHER_OPTIONS.length)];

        let slot = 0;
        for (const h of this.horses.values()) {
            const s = slot * 8;
            Object.assign(h, {
                rawProgress: s, progress: s, speed: 0, laps: 0, finished: false,
                stamina: 100, lane: 1, laneCooldown: 0,
                jumpHeight: 0, isJumping: false,
                penaltyTimer: 0, accelerating: false,
                shieldActive: false, turboTimer: 0, blitzStunTimer: 0, _blockCooldown: 0,
                lapStartTime: 0, lapTimes: [], finishTime: null,
                slipstream: false, pickupCount: 0, lastPickupType: null, shieldHits: 0,
            });
            slot++;
        }

        const tick = () => {
            this.countdown--;
            if (this.countdown <= 0) { this.state = 'racing'; }
            else { this._timer = setTimeout(tick, 1000); }
        };
        this._timer = setTimeout(tick, 1000);
    }

    // ── Hilfsfunktion: Position mit Mindestabstand zu bestehenden Positionen ─────
    // constraints: [{ pos, minDist }, ...]  |  margin: Rand-Abstand von Streckenstart/-ende
    _findPos(constraints, margin = 60) {
        const rand  = () => Math.round(margin + Math.random() * (TRACK_LENGTH - margin * 2));
        const isOK  = p  => constraints.every(c => Math.abs(p - c.pos) >= c.minDist);
        let bestPos = rand(), bestScore = -Infinity;
        for (let i = 0; i < 80; i++) {
            const candidate = rand();
            if (isOK(candidate)) return candidate;   // sofort gut → fertig
            const score = constraints.reduce((s, c) => Math.min(s, Math.abs(candidate - c.pos) / c.minDist), 1);
            if (score > bestScore) { bestScore = score; bestPos = candidate; }
        }
        return bestPos;   // Fallback: nächstbeste gefundene Position
    }

    _generateObstacles() {
        const isArctic = this.mapId === 'arctic';
        const obs      = [];
        const blocked  = [];

        // Mindestabstände je nach Map anpassen (Arctic hat mehr Items → enger)
        const margin     = isArctic ? 55 : 80;
        const distSingle = isArctic ? 28 : 45;
        const distFence  = isArctic ? 35 : 55;
        const distCart   = isArctic ? 35 : 65;

        // ── Einzelspur-Hindernisse (Heuballen / Eisblöcke) ─────────────────────
        const singleCount = isArctic ? 14 : 5;
        for (let i = 0; i < singleCount; i++) {
            const pos = this._findPos(blocked, margin);
            blocked.push({ pos, minDist: distSingle });
            obs.push({ id: i, progress: pos, lane: Math.floor(Math.random() * 3), type: 'haybale' });
        }

        // ── Vollspur-Hindernisse (Zaun / Eiswand, Sprung zwingend) ─────────────
        const fenceCount = isArctic ? 5 : 2;
        for (let i = 0; i < fenceCount; i++) {
            const pos = this._findPos(blocked, margin);
            blocked.push({ pos, minDist: distFence });
            obs.push({ id: 20 + i, progress: pos, lane: -1, type: 'fence' });
        }

        // ── Bewegliche Hindernisse (Heuwagen / Eisschollen) ────────────────────
        const cartCount = isArctic ? 6 : 3;
        for (let i = 0; i < cartCount; i++) {
            const pos = this._findPos(blocked, margin);
            blocked.push({ pos, minDist: distCart });
            obs.push({
                id: 30 + i, progress: pos, lane: 1, laneFloat: 1.0,
                lanePhase: i * 1.55 + Math.random() * 0.9,
                laneSpeed: 0.65 + Math.random() * 0.55,
                type: 'haycart',
            });
        }

        return obs;
        // Arctic gesamt: 14 + 5 + 6 = 25 Hindernisse
    }

    _generatePowerups() {
        const isArctic = this.mapId === 'arctic';
        // Arctic: 14 Power-Ups, Meadow: 8
        const count    = isArctic ? 14 : 8;
        const base     = ['stamina', 'turbo', 'shield', 'blitz'];
        const types    = Array.from({ length: count }, (_, i) => base[i % base.length]);
        const obsConst = this.obstacles.map(o => ({ pos: o.progress, minDist: 35 }));
        const puConst  = [];
        const puMinDist = isArctic ? 42 : 70;

        return types.map((type, i) => {
            const pos = this._findPos([...obsConst, ...puConst], 50);
            puConst.push({ pos, minDist: puMinDist });
            return { id: `pu_start_${i}`, progress: pos, lane: Math.floor(Math.random() * 3), type, collected: false };
        });
    }

    _spawnPowerup(type) {
        this.powerups = this.powerups.filter(p => !p.collected);
        // Abstand zu Hindernissen min. 45, zu aktiven Power-Ups min. 80
        const constraints = [
            ...this.obstacles.map(o => ({ pos: o.progress, minDist: 45 })),
            ...this.powerups.map(p => ({ pos: p.progress, minDist: 80 })),
        ];
        const pos = this._findPos(constraints, 60);
        this.powerups.push({
            id:       `pu_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            progress: pos,
            lane:     Math.floor(Math.random() * 3),
            type,
            collected: false,
        });
    }

    _endRace() {
        this.state        = 'results';
        this.readyPlayers = new Set();   // Bereit-Status zurücksetzen
        if (this.onRaceEnd) this.onRaceEnd(this.finishOrder);
        // Kein automatischer Timer — Spieler starten die nächste Runde manuell.
    }

    // ── Update ────────────────────────────────────────────────────────────────

    update(deltaTime) {
        if (this.state !== 'racing') return;

        this._raceTime += deltaTime;

        // ── Power-Up Respawn-Queue ────────────────────────────────────────────
        for (let i = this._puRespawnQueue.length - 1; i >= 0; i--) {
            this._puRespawnQueue[i].timer -= deltaTime;
            if (this._puRespawnQueue[i].timer <= 0) {
                this._spawnPowerup(this._puRespawnQueue.splice(i, 1)[0].type);
            }
        }

        // ── Slider-Positionen aktualisieren ───────────────────────────────────
        for (const obs of this.obstacles) {
            if (obs.type === 'haycart') {
                obs.laneFloat = 1 + Math.sin(this._raceTime * obs.laneSpeed + obs.lanePhase); // 0..2
                obs.lane      = Math.round(obs.laneFloat);
            }
        }

        for (const [id, h] of this.horses) {
            if (h.finished) continue;

            if (h.laneCooldown    > 0) h.laneCooldown    -= deltaTime;
            if (h.penaltyTimer    > 0) h.penaltyTimer    -= deltaTime;
            if (h.turboTimer      > 0) h.turboTimer      -= deltaTime;
            if (h.blitzStunTimer  > 0) h.blitzStunTimer  -= deltaTime;
            if (h._blockCooldown  > 0) h._blockCooldown  -= deltaTime;
            if (h._hitObsCooldown > 0) h._hitObsCooldown -= deltaTime;

            // Erschöpfungs-Erholung (max. 3s, dann automatisch beendet)
            if (h.exhausted) {
                h.exhaustedTimer += deltaTime;
                h.stamina = Math.min(100, h.stamina + 3.9 * deltaTime);
                if (h.stamina >= 30 || h.exhaustedTimer >= 3.0) {
                    h.exhausted = false;
                    h.stamina   = Math.max(h.stamina, 30); // mindestens 30 beim Ende
                }
            }

            // Effektive Maximalgeschwindigkeit:
            //   - Normal:    volle Speed bis 60% Stamina, darunter linear auf 50% runter
            //   - Erschöpft: 38% als hartes Cap (unabhängig von Turbo)
            //   - Turbo:     +40% auf Base-MaxSpeed (nur wenn nicht erschöpft)
            const staminaFactor = h.stamina >= 60 ? 1.0 : 0.5 + (h.stamina / 60) * 0.5;
            const baseMax       = h.exhausted ? h.maxSpeed * 0.38 : h.maxSpeed * staminaFactor;
            let   effectiveMax  = (!h.exhausted && h.turboTimer > 0) ? h.maxSpeed * 1.4 : baseMax;
            // Blitz-Betäubung: Maximalgeschwindigkeit hart begrenzt
            if (h.blitzStunTimer > 0) effectiveMax = Math.min(effectiveMax, h.maxSpeed * 0.42);


            // Windschatten: physische 2D-Distanz statt rawProgress-Lücke
            h.slipstream = false;
            {
                const lut = this.splineLUT;
                const getPos = (prog, lane) => lut
                    ? _splinePos2D(lut, prog, LANE_OFFSETS[lane])
                    : _trackPos2D_static(prog, LANE_OFFSETS[lane], this.TRACK_A, this.TRACK_B);
                const hPos = getPos(h.progress, h.lane);
                for (const [oid, other] of this.horses) {
                    if (oid === id || other.finished) continue;
                    if (other.lane !== h.lane) continue;
                    if (other.rawProgress <= h.rawProgress) continue;
                    const oPos = getPos(other.progress, other.lane);
                    const dx = oPos.x - hPos.x, dz = oPos.z - hPos.z;
                    const dist2 = dx * dx + dz * dz;
                    if (dist2 > 1.5 * 1.5 && dist2 < 9 * 9) { h.slipstream = true; break; }
                }
            }

            // Geschwindigkeit & Stamina
            if (h.accelerating && !h.exhausted && h.stamina > 0) {
                h.speed   = Math.min(h.speed + h.acceleration * deltaTime, effectiveMax);
                // Windschatten: 30% weniger Stamina-Verbrauch
                const drainFactor = h.slipstream ? 0.70 : 1.0;
                h.stamina = Math.max(0, h.stamina - h.staminaDrain * drainFactor * deltaTime);
                if (h.stamina <= 0) { h.exhausted = true; h.exhaustedTimer = 0; }
            } else if (h.exhausted) {
                // Erschöpft: abbremsen auf das fixe erschöpfte Cap (kein Turbo-Snap-Bug)
                h.speed = Math.max(baseMax, h.speed - h.acceleration * 0.5 * deltaTime);
            } else {
                // Während Strafe: Floor auf 2 absenken damit die Strafe spürbar bleibt
                const coastMin = h.penaltyTimer > 0 ? 8 : h.maxSpeed * 0.38;
                h.speed   = Math.max(coastMin, h.speed - h.acceleration * 0.45 * deltaTime);
                h.stamina = Math.min(100, h.stamina + 15.6 * deltaTime);  // +30% schneller
            }
            h.speed = Math.min(h.speed, effectiveMax);

            // Windschatten: spürbarer Geschwindigkeits-Push + leicht erhöhtes Speed-Cap
            if (h.slipstream) {
                h.speed = Math.min(h.speed + h.acceleration * 0.55 * deltaTime, h.maxSpeed * 1.18);
            }

            // Sprungphysik
            if (h.isJumping) {
                h._jumpV     -= GRAVITY * deltaTime;
                h.jumpHeight += h._jumpV * deltaTime;
                if (h.jumpHeight <= 0) {
                    h.jumpHeight = 0; h._jumpV = 0; h.isJumping = false;
                }
            }

            // Fortschritt & Runden
            // Arc-Normalisierung: Pferd bewegt sich physisch überall gleich schnell,
            // egal ob Kurve oder Gerade. rawArc = lokale Bogenlänge pro Progress-Einheit
            // (ohne 2π/TRACK_LENGTH-Faktor). arcNorm = AVG/lokal → in Kurven (rawArc groß)
            // schreitet rawProgress langsamer vor, auf Geraden (rawArc klein) schneller.
            // Spurlängen-Skalierung: Innenbahn schreitet schneller voran (kürzere Strecke).
            // Arc-Normierung: Spline = uniform (arcNorm 1.0), Ellipse = positionsabhängig
            let arcNorm;
            if (this.splineLUT) {
                arcNorm = 1.0;
            } else {
                const t_arc = (h.rawProgress / TRACK_LENGTH) * Math.PI * 2;
                const rawArc = Math.sqrt(
                    Math.sin(t_arc) * Math.sin(t_arc) * this.TRACK_A * this.TRACK_A +
                    Math.cos(t_arc) * Math.cos(t_arc) * this.TRACK_B * this.TRACK_B
                );
                arcNorm = this.AVG_RAW_ARC / rawArc;
            }

            const prevLap  = Math.floor(h.rawProgress / TRACK_LENGTH);
            h.rawProgress += h.speed * deltaTime * this.LANE_SCALE[h.lane] * arcNorm;
            const newLap   = Math.floor(h.rawProgress / TRACK_LENGTH);
            if (newLap > prevLap) {
                h.laps = newLap;
                // Rundenzeit aufzeichnen
                const lapTime = this._raceTime - h.lapStartTime;
                h.lapTimes.push(Math.round(lapTime * 1000) / 1000);
                h.lapStartTime = this._raceTime;

                if (h.laps >= this.totalLaps) {
                    h.finished    = true;
                    h.finishTime  = this._raceTime;
                    h.rawProgress = this.totalLaps * TRACK_LENGTH;
                    h.progress    = h.rawProgress % TRACK_LENGTH;  // = 0, Fix für unbounded-Progress
                    this.finishOrder.push(id);
                    if (this.finishOrder.length === this.horses.size) this._endRace();
                    continue;
                }
            }
            h.progress = h.rawProgress % TRACK_LENGTH;

            // Power-Up aufnehmen
            for (const pu of this.powerups) {
                if (pu.collected) continue;
                if (pu.lane !== h.lane) continue;
                if (Math.abs(h.progress - pu.progress) > 8) continue;

                pu.collected = true;
                this._puRespawnQueue.push({ type: pu.type, timer: 5 });
                h.pickupCount++;                  // immer, unabhängig vom Effekt
                h.lastPickupType = pu.type;
                if (pu.type === 'stamina') { h.stamina = 100; h.exhausted = false; }
                if (pu.type === 'turbo')   { h.turboTimer = 3.0; h.exhausted = false; }
                if (pu.type === 'shield')  { h.shieldActive = true; }
                if (pu.type === 'blitz') {
                    // Alle anderen Pferde betäuben (Schild schützt davor)
                    for (const [oid, other] of this.horses) {
                        if (oid === id || other.finished) continue;
                        if (other.shieldActive) { other.shieldActive = false; continue; }
                        other.speed          *= 0.30;
                        other.blitzStunTimer  = 2.5;
                        other._blockCooldown  = 2.5;
                    }
                }
            }

            // Kollision mit Hindernissen
            if (h._blockCooldown <= 0) {
                // Hilfsfunktion: 2D-Weltposition aus Progress + Lane-Offset
                const worldPos = (prog, off) => this.splineLUT
                    ? _splinePos2D(this.splineLUT, prog, off)
                    : _trackPos2D_static(prog, off, this.TRACK_A, this.TRACK_B);

                // Pferdeposition
                const hPos = worldPos(h.progress, LANE_OFFSETS[h.lane]);

                for (const obs of this.obstacles) {
                    // Grober Vorab-Check (Performance)
                    if (Math.abs(h.progress - obs.progress) > 20) continue;

                    // Dasselbe Hindernis darf nicht doppelt treffen
                    if (h._hitObsId === obs.id && h._hitObsCooldown > 0) continue;

                    let hit = false;

                    if (obs.type === 'fence') {
                        // Zaun = Linie quer zur Strecke → nur Längsabstand messen
                        // (Tangente der Strecke an der Zaunposition berechnen)
                        const fc  = worldPos(obs.progress, 0);
                        const fc2 = worldPos(obs.progress + 2, 0);
                        const tX  = fc2.x - fc.x, tZ = fc2.z - fc.z;
                        const tLen = Math.sqrt(tX * tX + tZ * tZ) || 1;
                        const vX  = hPos.x - fc.x, vZ = hPos.z - fc.z;
                        // Projektion auf Tangente = Längsabstand
                        const longitudinal = Math.abs((vX * tX + vZ * tZ) / tLen);
                        hit = longitudinal < 2.5;
                    } else {
                        // Haybale / Haycart: euklidische 2D-Distanz + Längscheck
                        const obsOff = obs.laneFloat !== undefined
                            ? -3.5 + obs.laneFloat * 3.5
                            : LANE_OFFSETS[obs.lane];
                        const oPos = worldPos(obs.progress, obsOff);
                        const dx = hPos.x - oPos.x, dz = hPos.z - oPos.z;
                        const hitR = obs.type === 'haycart' ? 2.5 : 2.2;
                        if (dx * dx + dz * dz < hitR * hitR) {
                            // Längscheck: Pferd darf max. 1.5 WU vorbeigefahren sein.
                            // Verhindert Spät-Treffer in Kurven, wo die euklidische Distanz
                            // noch klein ist, obwohl das Pferd das Hindernis schon passiert hat.
                            const tc  = worldPos(obs.progress,     0);
                            const tc2 = worldPos(obs.progress + 2, 0);
                            const tX  = tc2.x - tc.x, tZ = tc2.z - tc.z;
                            const tLen = Math.sqrt(tX * tX + tZ * tZ) || 1;
                            // positiv = Pferd ist vor dem Hindernis (in Fahrtrichtung)
                            const longitudinal = (dx * tX + dz * tZ) / tLen;
                            hit = longitudinal < 1.5;
                        }
                    }

                    if (!hit) continue;

                    // ── Sprung (>= 1.0) schützt vor allen Hindernissen ──
                    if (h.jumpHeight >= 1.0) continue;

                    if (h.penaltyTimer > 0) continue;   // schon bestraft

                    // Dasselbe Hindernis für 4s sperren (verhindert Doppel-Treffer)
                    h._hitObsId       = obs.id;
                    h._hitObsCooldown = 4.0;

                    if (h.shieldActive) {
                        h.shieldActive   = false;
                        h._blockCooldown = 1.5;
                        h.shieldHits++;
                    } else {
                        h.speed         *= 0.35;
                        h.penaltyTimer   = 1.5;
                        h._blockCooldown = 2.0;
                    }
                    break;
                }
            }

        }
    }

    // ── State für Clients ─────────────────────────────────────────────────────

    getState() {
        const horsesOut = {};
        for (const [id, h] of this.horses) {
            horsesOut[id] = {
                id: h.id, name: h.playerName, horseType: h.horseType, rider: h.rider,
                progress: h.progress, speed: h.speed,
                stamina: h.stamina, laps: h.laps, finished: h.finished,
                lane: h.lane, jumpHeight: h.jumpHeight,
                penalized:    h.penaltyTimer > 0,
                exhausted:    h.exhausted,
                turboActive:     h.turboTimer > 0,
                turboTimer:      Math.max(0, h.turboTimer),
                shieldActive:    h.shieldActive,
                blitzStunTimer:  Math.max(0, h.blitzStunTimer),
                pickupCount:     h.pickupCount,
                lastPickupType:  h.lastPickupType,
                shieldHits:      h.shieldHits,
                lapTimes:     h.lapTimes,
                finishTime:   h.finishTime,
                currentLapTime: h.finished ? null : this._raceTime - h.lapStartTime,
                slipstream:   h.slipstream,
            };
        }
        const ranked = [...this.horses.values()]
            .sort((a, b) => b.rawProgress - a.rawProgress).map(h => h.id);
        return {
            horses: horsesOut, raceState: this.state, countdown: this.countdown,
            finishOrder: this.finishOrder, ranking: ranked,
            totalLaps: this.totalLaps, obstacles: this.obstacles,
            powerups: this.powerups.filter(p => !p.collected),
            weatherPreset: this.weatherPreset,
            readyPlayers: [...this.readyPlayers],
            mapId: this.mapId,
        };
    }
}

module.exports = RaceManager;
