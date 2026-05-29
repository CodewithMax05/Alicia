const TRACK_LENGTH  = 1000;
const GRAVITY       = 30;
const TRACK_A       = 55;    // Ellipsen-Halbachse X (muss mit renderer.js übereinstimmen)
const TRACK_B       = 28;    // Ellipsen-Halbachse Z

// Spurversatz: [-3.5, 0, +3.5] für Innen/Mitte/Außen
const LANE_OFFSETS = [-3.5, 0, 3.5];

// Spurlängen-Skalierung:
//   Für eine konvexe geschlossene Kurve gilt: C(d) = C₀ + 2π·d
//   Ellipsen-Umfang Mitte ≈ 267.6 → Innen (d=-3.5): 245.6 | Außen (d=+3.5): 289.6
//   LANE_SCALE[lane] = C_mitte / C_lane → rawProgress schneller auf Innenbahn, langsamer auf Außenbahn
const LANE_SCALE = [267.6 / 245.6,   // Innen  ≈ 1.0896
                    1.000,            // Mitte
                    267.6 / 289.6];  // Außen  ≈ 0.9240

// Mittlere Bogenlänge der Mittelspur: ∫₀^2π sqrt(sin²t·A²+cos²t·B²) dt / (2π)
// ≈ Ellipsen-Umfang / (2π) ≈ 267.6 / (2π) ≈ 42.60
// Wird für Arc-Normalisierung verwendet, damit Pferd physisch überall gleich schnell fährt.
const AVG_RAW_ARC = 42.60;

// Gibt 2D-Weltposition auf der Strecke zurück (für physische Distanzberechnungen)
function trackPos2D(progress, laneOffset) {
    const t  = (progress / TRACK_LENGTH) * Math.PI * 2;
    const cx = Math.cos(t) * TRACK_A;
    const cz = Math.sin(t) * TRACK_B;
    if (laneOffset === 0) return { x: cx, z: cz };
    const tx  = -Math.sin(t) * TRACK_A;
    const tz  =  Math.cos(t) * TRACK_B;
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
    constructor(onRaceEnd, totalLaps = 2) {
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
        // Start wenn alle Spieler bereit sind (funktioniert in Lobby und Ergebnis-Screen)
        const allReady = this.horses.size > 0 &&
                         this.readyPlayers.size >= this.horses.size;
        if (allReady && (this.state === 'lobby' || this.state === 'results')) {
            clearInterval(this._lobbyTimer);
            this._startCountdown();
        }
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
        const obs     = [];
        const blocked = [];

        // ── Heuballen (einzelne Spur, überspringen oder ausweichen) ────────────
        for (let i = 0; i < 5; i++) {
            const pos = this._findPos(blocked, 80);
            blocked.push({ pos, minDist: 50 });
            obs.push({ id: i, progress: pos, lane: Math.floor(Math.random() * 3), type: 'haybale' });
        }

        // ── Holzzäune (alle Spuren, Sprung zwingend nötig) ──────────────────────
        for (let i = 0; i < 2; i++) {
            const pos = this._findPos(blocked, 80);
            blocked.push({ pos, minDist: 55 });
            obs.push({ id: 5 + i, progress: pos, lane: -1, type: 'fence' });
        }

        // ── Heuwagen (Schiebebande mit Heuthema) ─────────────────────────────────
        for (let i = 0; i < 3; i++) {
            const pos = this._findPos(blocked, 100);
            blocked.push({ pos, minDist: 65 });
            obs.push({
                id: 9 + i, progress: pos, lane: 1, laneFloat: 1.0,
                lanePhase: i * 1.55 + Math.random() * 0.9,
                laneSpeed: 0.65 + Math.random() * 0.55,
                type: 'haycart',
            });
        }

        return obs;
    }

    _generatePowerups() {
        // 8 Power-Ups: min. 45 Einh. Abstand zu Hindernissen, min. 80 Einh. zueinander
        const types    = ['stamina','turbo','shield','blitz','stamina','turbo','shield','blitz'];
        const obsConst = this.obstacles.map(o => ({ pos: o.progress, minDist: 45 }));
        const puConst  = [];   // wächst pro platziertem Power-Up

        return types.map((type, i) => {
            const pos = this._findPos([...obsConst, ...puConst], 60);
            puConst.push({ pos, minDist: 80 });
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
            // → funktioniert in Kurven und auf Geraden gleich
            h.slipstream = false;
            {
                const hPos = trackPos2D(h.progress, LANE_OFFSETS[h.lane]);
                for (const [oid, other] of this.horses) {
                    if (oid === id || other.finished) continue;
                    if (other.lane !== h.lane) continue;
                    if (other.rawProgress <= h.rawProgress) continue; // muss vor uns sein
                    const oPos = trackPos2D(other.progress, LANE_OFFSETS[other.lane]);
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
            const t_arc   = (h.rawProgress / TRACK_LENGTH) * Math.PI * 2;
            const rawArc  = Math.sqrt(
                Math.sin(t_arc) * Math.sin(t_arc) * TRACK_A * TRACK_A +
                Math.cos(t_arc) * Math.cos(t_arc) * TRACK_B * TRACK_B
            );
            const arcNorm = AVG_RAW_ARC / rawArc;

            const prevLap  = Math.floor(h.rawProgress / TRACK_LENGTH);
            h.rawProgress += h.speed * deltaTime * LANE_SCALE[h.lane] * arcNorm;
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
                for (const obs of this.obstacles) {
                    if (Math.abs(h.progress - obs.progress) > 7) continue;
                    const laneHit = obs.lane === -1 || obs.lane === h.lane;
                    if (!laneHit) continue;

                    // ── Sprung (>= 1.0) schützt vor allen Hindernissen ──
                    if (h.jumpHeight >= 1.0) continue;

                    if (h.penaltyTimer > 0) continue;   // schon bestraft

                    if (h.shieldActive) {
                        h.shieldActive   = false;
                        h._blockCooldown = 1.5;
                        h.shieldHits++;           // Schild hat absorbiert → Sound-Event
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
            readyPlayers:  [...this.readyPlayers],
        };
    }
}

module.exports = RaceManager;
