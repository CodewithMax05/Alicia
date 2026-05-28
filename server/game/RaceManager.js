const TRACK_LENGTH  = 1000;
const TOTAL_LAPS    = 2;
const GRAVITY       = 30;

const WEATHER_OPTIONS = ['sunny', 'sunset', 'night', 'dawn', 'rainy', 'foggy'];

const HORSE_TYPES = {
    blitz: { maxSpeed: 35, acceleration: 20, staminaDrain: 13, jumpVelocity: 22 },
    sturm: { maxSpeed: 30, acceleration: 25, staminaDrain:  9, jumpVelocity: 22 },
    nebel: { maxSpeed: 26, acceleration: 13, staminaDrain:  6, jumpVelocity: 28 },
    feuer: { maxSpeed: 40, acceleration: 18, staminaDrain: 18, jumpVelocity: 19 },
};

class RaceManager {
    constructor(onRaceEnd) {
        this.horses          = new Map();
        this.state           = 'waiting';
        this.countdown       = 0;
        this.finishOrder     = [];
        this.obstacles       = [];
        this.powerups        = [];
        this._raceTime       = 0;
        this.onRaceEnd       = onRaceEnd;
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
            shieldActive:   false,
            turboTimer:     0,
            _blockCooldown: 0,
            exhausted:      false,
            lapStartTime:   0,
            lapTimes:       [],
            finishTime:     null,
            slipstream:     false,
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
                shieldActive: false, turboTimer: 0, _blockCooldown: 0,
                lapStartTime: 0, lapTimes: [], finishTime: null,
                slipstream: false,
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
                shieldActive: false, turboTimer: 0, _blockCooldown: 0,
                lapStartTime: 0, lapTimes: [], finishTime: null,
                slipstream: false,
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

    _generateObstacles() {
        const obs = [];

        // ── Statische Hindernisse (Kegel + Hürden) ────────────────────────────
        const fixedCount = 12;
        for (let i = 0; i < fixedCount; i++) {
            const base   = 80 + i * ((TRACK_LENGTH - 160) / fixedCount) + (Math.random() - 0.5) * 22;
            const hurdle = Math.random() < 0.22;
            obs.push({
                id:       i,
                progress: Math.round(base),
                lane:     hurdle ? -1 : Math.floor(Math.random() * 3),
                type:     hurdle ? 'hurdle' : 'cone',
            });
        }

        // ── Gleitende Schiebebanden (bewegen sich seitlich zwischen Spuren) ──
        for (let i = 0; i < 4; i++) {
            obs.push({
                id:         fixedCount + i,
                progress:   Math.round(130 + i * 210 + (Math.random() - 0.5) * 35),
                lane:       1,
                laneFloat:  1.0,
                lanePhase:  i * 1.55 + Math.random() * 0.9,
                laneSpeed:  0.65 + Math.random() * 0.55,
                type:       'slider',
            });
        }

        return obs;
    }

    _generatePowerups() {
        // Nur 3 Power-Ups zu Rennbeginn (einer pro Typ), Rest spawnt dynamisch nach
        const types = ['stamina', 'turbo', 'shield'];
        return types.map((type, i) => ({
            id:        `pu_start_${i}`,
            progress:  Math.round(120 + i * 280 + (Math.random() - 0.5) * 60),
            lane:      Math.floor(Math.random() * 3),
            type,
            collected: false,
        }));
    }

    _spawnPowerup(type) {
        // Eingesammelte bereinigen, dann neues Power-Up an zufälliger Stelle hinzufügen
        this.powerups = this.powerups.filter(p => !p.collected);
        this.powerups.push({
            id:       `pu_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            progress: Math.round(80 + Math.random() * (TRACK_LENGTH - 160)),
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
            if (obs.type === 'slider') {
                obs.laneFloat = 1 + Math.sin(this._raceTime * obs.laneSpeed + obs.lanePhase); // 0..2
                obs.lane      = Math.round(obs.laneFloat);
            }
        }

        for (const [id, h] of this.horses) {
            if (h.finished) continue;

            if (h.laneCooldown   > 0) h.laneCooldown   -= deltaTime;
            if (h.penaltyTimer   > 0) h.penaltyTimer   -= deltaTime;
            if (h.turboTimer     > 0) h.turboTimer     -= deltaTime;
            if (h._blockCooldown > 0) h._blockCooldown -= deltaTime;

            // Erschöpfungs-Erholung (langsame Stamina-Regen wenn exhausted)
            if (h.exhausted) {
                h.stamina = Math.min(100, h.stamina + 3 * deltaTime);
                if (h.stamina >= 30) h.exhausted = false;
            }

            // Effektive Maximalgeschwindigkeit:
            //   - Normal:    volle Speed bis 60% Stamina, darunter linear auf 50% runter
            //   - Erschöpft: 38% als hartes Cap (unabhängig von Turbo)
            //   - Turbo:     +40% auf Base-MaxSpeed (nur wenn nicht erschöpft)
            const staminaFactor = h.stamina >= 60 ? 1.0 : 0.5 + (h.stamina / 60) * 0.5;
            const baseMax       = h.exhausted ? h.maxSpeed * 0.38 : h.maxSpeed * staminaFactor;
            let   effectiveMax  = (!h.exhausted && h.turboTimer > 0) ? h.maxSpeed * 1.4 : baseMax;

            // Windschatten: direkt hinter einem anderen Pferd (nur Range entscheidet)
            h.slipstream = false;
            for (const [oid, other] of this.horses) {
                if (oid === id || other.finished) continue;
                if (other.lane !== h.lane) continue;
                const gap = other.rawProgress - h.rawProgress;
                if (gap > 2 && gap < 70) { h.slipstream = true; break; }
            }

            // Geschwindigkeit & Stamina
            if (h.accelerating && !h.exhausted && h.stamina > 0) {
                h.speed   = Math.min(h.speed + h.acceleration * deltaTime, effectiveMax);
                h.stamina = Math.max(0, h.stamina - h.staminaDrain * deltaTime);
                if (h.stamina <= 0) h.exhausted = true;
            } else if (h.exhausted) {
                // Erschöpft: abbremsen auf das fixe erschöpfte Cap (kein Turbo-Snap-Bug)
                h.speed = Math.max(baseMax, h.speed - h.acceleration * 0.5 * deltaTime);
            } else {
                // Während Strafe: Floor auf 2 absenken damit die Strafe spürbar bleibt
                const coastMin = h.penaltyTimer > 0 ? 8 : h.maxSpeed * 0.38;
                h.speed   = Math.max(coastMin, h.speed - h.acceleration * 0.45 * deltaTime);
                h.stamina = Math.min(100, h.stamina + 12 * deltaTime);
            }
            h.speed = Math.min(h.speed, effectiveMax);

            // Windschatten: direkter Geschwindigkeits-Push (immer wenn in Range)
            if (h.slipstream) {
                h.speed = Math.min(h.speed + h.acceleration * 0.4 * deltaTime, h.maxSpeed * 1.12);
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
            const prevLap  = Math.floor(h.rawProgress / TRACK_LENGTH);
            h.rawProgress += h.speed * deltaTime;
            const newLap   = Math.floor(h.rawProgress / TRACK_LENGTH);
            if (newLap > prevLap) {
                h.laps = newLap;
                // Rundenzeit aufzeichnen
                const lapTime = this._raceTime - h.lapStartTime;
                h.lapTimes.push(Math.round(lapTime * 1000) / 1000);
                h.lapStartTime = this._raceTime;

                if (h.laps >= TOTAL_LAPS) {
                    h.finished    = true;
                    h.finishTime  = this._raceTime;
                    h.rawProgress = TOTAL_LAPS * TRACK_LENGTH;
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
                this._puRespawnQueue.push({ type: pu.type, timer: 8 + Math.random() * 8 });
                if (pu.type === 'stamina') { h.stamina = 100; h.exhausted = false; }
                if (pu.type === 'turbo')   { h.turboTimer = 3.0; h.exhausted = false; }
                if (pu.type === 'shield')  { h.shieldActive = true; }
            }

            // Kollision mit Hindernissen (Kegel, Hürden, Slider)
            if (h.penaltyTimer <= 0 && h._blockCooldown <= 0) {
                for (const obs of this.obstacles) {
                    if (Math.abs(h.progress - obs.progress) > 7) continue;
                    const laneHit = obs.lane === -1 || obs.lane === h.lane;
                    if (laneHit && h.jumpHeight < 1.0) {
                        if (h.shieldActive) {
                            h.shieldActive   = false;
                            h._blockCooldown = 1.5;
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
                turboActive:  h.turboTimer > 0,
                turboTimer:   Math.max(0, h.turboTimer),
                shieldActive: h.shieldActive,
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
            totalLaps: TOTAL_LAPS, obstacles: this.obstacles,
            powerups: this.powerups.filter(p => !p.collected),
            weatherPreset: this.weatherPreset,
            readyPlayers:  [...this.readyPlayers],
        };
    }
}

module.exports = RaceManager;
