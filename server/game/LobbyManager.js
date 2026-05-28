const RaceManager = require('./RaceManager');

const MAX_PLAYERS = 3;

class LobbyManager {
    constructor() {
        this.lobbies = new Map();
        this._seq    = 1;
    }

    /** Neue Lobby anlegen. Gibt das Lobby-Objekt zurück. */
    create(name, isPublic = true, totalLaps = 2) {
        const id   = 'L' + String(this._seq++).padStart(4, '0');
        const race = new RaceManager(() =>
            console.log(`[${id}] Rennen beendet`),
            Math.max(1, Math.min(10, totalLaps))
        );
        const lobby = {
            id,
            name:     (String(name || 'Lobby').trim().slice(0, 28)) || 'Lobby',
            isPublic: !!isPublic,
            race,
        };
        this.lobbies.set(id, lobby);
        return lobby;
    }

    get(id)    { return this.lobbies.get(id); }

    remove(id) {
        const lb = this.lobbies.get(id);
        if (lb) {
            clearTimeout(lb.race._timer);
            clearInterval(lb.race._lobbyTimer);
        }
        this.lobbies.delete(id);
    }

    /** Ist die Lobby voll oder nicht-joinbar? */
    canJoin(id) {
        const lb = this.lobbies.get(id);
        if (!lb) return false;
        if (lb.race.horses.size >= MAX_PLAYERS) return false;
        // Kein Beitritt während Countdown / Rennen / Ergebnis
        const s = lb.race.state;
        if (s === 'countdown' || s === 'racing' || s === 'results') return false;
        return true;
    }

    /** Liste der öffentlichen Lobbys für den Browser */
    publicList() {
        const out = [];
        for (const lb of this.lobbies.values()) {
            if (!lb.isPublic) continue;
            out.push({
                id:         lb.id,
                name:       lb.name,
                players:    lb.race.horses.size,
                maxPlayers: MAX_PLAYERS,
                state:      lb.race.state,
            });
        }
        // Alphabetisch nach Name sortieren
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }
}

module.exports = { LobbyManager, MAX_PLAYERS };
