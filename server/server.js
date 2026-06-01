const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');
const GameLoop  = require('./game/GameLoop');
const { LobbyManager } = require('./game/LobbyManager');

const PORT       = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
};

// ── HTTP-Server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    const pathname  = req.url.split('?')[0].split('#')[0];
    const urlPath   = pathname === '/' ? '/index.html' : pathname;
    const filePath  = path.join(CLIENT_DIR, urlPath);
    if (!filePath.startsWith(CLIENT_DIR)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
});

// ── Lobby-Manager ─────────────────────────────────────────────────────────────
const wss      = new WebSocket.Server({ server: httpServer });
const lobbyMgr = new LobbyManager();

function sendLobbyList(onlyTo) {
    const payload = JSON.stringify({ type: 'lobbyList', lobbies: lobbyMgr.publicList() });
    const pool    = onlyTo ? [onlyTo] : wss.clients;
    for (const c of pool)
        if (c.readyState === WebSocket.OPEN && !c.lobbyId) c.send(payload);
}

function broadcastToLobby(lobbyId, obj) {
    const payload = JSON.stringify(obj);
    for (const c of wss.clients)
        if (c.readyState === WebSocket.OPEN && c.lobbyId === lobbyId) c.send(payload);
}

// ── Hilfe: Map-Gewinner aus Vote-Objekt ermitteln ─────────────────────────────
function _resolveMap(lb) {
    const votes = Object.values(lb.mapVotes || {});
    if (votes.length === 0) return lb.race.mapId || 'meadow';
    const counts = {};
    for (const v of votes) counts[v] = (counts[v] || 0) + 1;
    // Meiste Stimmen gewinnt; Gleichstand = zufällig
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const maxVotes = sorted[0][1];
    const tied = sorted.filter(([, n]) => n === maxVotes).map(([m]) => m);
    return tied[Math.floor(Math.random() * tied.length)];
}

// ── Globaler Game-Loop ────────────────────────────────────────────────────────
const loop = new GameLoop(20, (_tick, dt) => {
    for (const lb of lobbyMgr.lobbies.values()) {
        lb.race.update(dt);
        const payload = JSON.stringify({
            type: 'state',
            ...lb.race.getState(),
            leaderId:  lb.leaderId,
            mapVotes:  lb.mapVotes || {},
        });
        for (const c of wss.clients)
            if (c.readyState === WebSocket.OPEN && c.lobbyId === lb.id) c.send(payload);
    }
});

setInterval(() => sendLobbyList(), 4000);

// ── WebSocket-Handler ─────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
    ws.horseId = null;
    ws.lobbyId = null;

    sendLobbyList(ws);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // ── Lobby erstellen ──────────────────────────────────────────────────
        if (msg.type === 'createLobby' && !ws.lobbyId) {
            const lb = lobbyMgr.create(msg.lobbyName, msg.isPublic !== false, msg.totalLaps || 2);
            const id = Math.random().toString(36).substr(2, 8);
            ws.horseId  = id;
            ws.lobbyId  = lb.id;
            lb.leaderId = id;   // Ersteller wird Leader
            lb.mapVotes = {};   // { horseId: 'meadow'|'arctic' }
            lb.race.addHorse(id, msg.horseType || 'blitz', msg.playerName || 'Fahrer', msg.rider || {});
            ws.send(JSON.stringify({ type: 'init', id, lobbyId: lb.id, lobbyName: lb.name }));
            sendLobbyList();
            console.log(`[+] Lobby ${lb.id} "${lb.name}" erstellt von "${msg.playerName}" — Leader: ${id}`);
        }

        // ── Lobby beitreten ──────────────────────────────────────────────────
        if (msg.type === 'joinLobby' && !ws.lobbyId) {
            const lb = lobbyMgr.get(msg.lobbyId);
            if (!lb) {
                ws.send(JSON.stringify({ type: 'error', code: 'NOT_FOUND', message: 'Lobby nicht gefunden.' }));
                return;
            }
            if (!lobbyMgr.canJoin(msg.lobbyId)) {
                ws.send(JSON.stringify({ type: 'error', code: 'FULL', message: 'Lobby ist voll oder das Rennen hat bereits begonnen.' }));
                return;
            }
            const id = Math.random().toString(36).substr(2, 8);
            ws.horseId = id;
            ws.lobbyId = lb.id;
            lb.race.addHorse(id, msg.horseType || 'blitz', msg.playerName || 'Fahrer', msg.rider || {});
            ws.send(JSON.stringify({ type: 'init', id, lobbyId: lb.id, lobbyName: lb.name }));
            sendLobbyList();
            console.log(`[+] "${msg.playerName}" tritt ${lb.id} bei (${lb.race.horses.size} Spieler)`);
        }

        // ── Eingaben ─────────────────────────────────────────────────────────
        if (msg.type === 'input' && ws.lobbyId && ws.horseId)
            lobbyMgr.get(ws.lobbyId)?.race.setInput(ws.horseId, msg.input);

        // ── Bereit ───────────────────────────────────────────────────────────
        if (msg.type === 'ready' && ws.lobbyId && ws.horseId)
            lobbyMgr.get(ws.lobbyId)?.race.setReady(ws.horseId, msg.ready !== false);

        // ── Map-Vote ──────────────────────────────────────────────────────────
        if (msg.type === 'mapVote' && ws.lobbyId && ws.horseId) {
            const lb = lobbyMgr.get(ws.lobbyId);
            if (lb && ['meadow', 'arctic'].includes(msg.mapId)) {
                lb.mapVotes[ws.horseId] = msg.mapId;
                // Sofortiges Preview: Map auf führenden Vote-Gewinner umstellen
                const winning = _resolveMap(lb);
                if (winning !== lb.race.mapId) lb.race.setMap(winning);
                console.log(`[Map] ${ws.horseId} voted "${msg.mapId}" → aktuell "${winning}"`);
            }
        }

        // ── Spiel starten — nur Leader ────────────────────────────────────────
        if (msg.type === 'startGame' && ws.lobbyId && ws.horseId) {
            const lb = lobbyMgr.get(ws.lobbyId);
            if (lb && lb.leaderId === ws.horseId) {
                // Gewinner-Map vor dem Start festlegen
                lb.race.setMap(_resolveMap(lb));
                lb.race.tryStartGame();
            }
        }

        // ── Zurück in Lobby — nur Leader ──────────────────────────────────────
        if (msg.type === 'returnToLobby' && ws.lobbyId && ws.horseId) {
            const lb = lobbyMgr.get(ws.lobbyId);
            if (lb && lb.leaderId === ws.horseId) {
                lb.mapVotes = {};   // Votes für neue Runde zurücksetzen
                lb.race.returnToLobby();
            }
        }

        // ── Spieler kicken — nur Leader ───────────────────────────────────────
        if (msg.type === 'kickPlayer' && ws.lobbyId && ws.horseId) {
            const lb = lobbyMgr.get(ws.lobbyId);
            if (!lb || lb.leaderId !== ws.horseId) {
                console.log(`[Kick] Abgelehnt: ${ws.horseId} ist kein Leader (Leader: ${lb?.leaderId})`);
                return;
            }
            const targetId = msg.targetId;
            if (!targetId || targetId === ws.horseId) return;

            // Name vor dem Entfernen sichern
            const targetName = lb.race.horses.get(targetId)?.playerName || 'Spieler';
            lb.race.removeHorse(targetId);

            // Gekickten Spieler benachrichtigen und aus der Lobby entfernen
            for (const c of wss.clients) {
                if (c.readyState === WebSocket.OPEN && c.horseId === targetId && c.lobbyId === ws.lobbyId) {
                    c.send(JSON.stringify({ type: 'kicked' }));
                    c.lobbyId = null;
                    c.horseId = null;
                    break;
                }
            }

            // Allen verbleibenden Spielern eine System-Nachricht schicken
            broadcastToLobby(ws.lobbyId, {
                type: 'chat',
                sender: 'System',
                message: `${targetName} wurde aus der Lobby entfernt.`
            });

            sendLobbyList();
            console.log(`[Kick] ${ws.horseId} hat "${targetName}" (${targetId}) aus ${ws.lobbyId} gekickt`);
        }

        // ── Chat ──────────────────────────────────────────────────────────────
        if (msg.type === 'chat' && ws.lobbyId && ws.horseId) {
            const lb     = lobbyMgr.get(ws.lobbyId);
            const horse  = lb?.race.horses.get(ws.horseId);
            const sender = horse?.playerName || 'Anon';
            const text   = String(msg.message || '').slice(0, 80).trim();
            if (text) {
                broadcastToLobby(ws.lobbyId, { type: 'chat', sender, message: text });
                console.log(`[Chat ${ws.lobbyId}] ${sender}: ${text}`);
            }
        }
    });

    ws.on('close', () => {
        if (!ws.lobbyId || !ws.horseId) return;
        const lb = lobbyMgr.get(ws.lobbyId);
        if (lb) {
            console.log(`[-] "${ws.horseId}" verlässt Lobby ${ws.lobbyId}`);
            lb.race.removeHorse(ws.horseId);

            // Leader-Nachfolge: nächsten verbleibenden Spieler zum Leader machen
            if (lb.leaderId === ws.horseId) {
                const next = lb.race.horses.keys().next().value || null;
                lb.leaderId = next;
                if (next) console.log(`[Leader] Neuer Leader in ${ws.lobbyId}: ${next}`);
            }

            if (lb.race.horses.size === 0) {
                lobbyMgr.remove(ws.lobbyId);
                console.log(`[X] Lobby ${ws.lobbyId} gelöscht (leer)`);
            }
        }
        sendLobbyList();
    });
});

httpServer.listen(PORT, () => {
    console.log(`Server läuft auf http://localhost:${PORT}`);
    console.log(`WebSocket auf  ws://localhost:${PORT}`);
});
loop.start();
