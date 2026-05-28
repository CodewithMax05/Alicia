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
    let urlPath = req.url === '/' ? '/index.html' : req.url;
    const filePath = path.join(CLIENT_DIR, urlPath);
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

/** Lobby-Liste an alle Clients schicken, die noch in keiner Lobby sind. */
function sendLobbyList(onlyTo) {
    const payload = JSON.stringify({ type: 'lobbyList', lobbies: lobbyMgr.publicList() });
    const pool    = onlyTo ? [onlyTo] : wss.clients;
    for (const c of pool)
        if (c.readyState === WebSocket.OPEN && !c.lobbyId) c.send(payload);
}

/** Nachricht an alle Clients einer Lobby senden. */
function broadcastToLobby(lobbyId, obj) {
    const payload = JSON.stringify(obj);
    for (const c of wss.clients)
        if (c.readyState === WebSocket.OPEN && c.lobbyId === lobbyId) c.send(payload);
}

// ── Globaler Game-Loop: alle Lobbys gleichzeitig ticken ───────────────────────
const loop = new GameLoop(20, (_tick, dt) => {
    for (const lb of lobbyMgr.lobbies.values()) {
        lb.race.update(dt);
        const payload = JSON.stringify({ type: 'state', ...lb.race.getState() });
        for (const c of wss.clients)
            if (c.readyState === WebSocket.OPEN && c.lobbyId === lb.id) c.send(payload);
    }
});

// Lobby-Liste alle 4 s an Browse-Clients senden (hält State-Anzeigen aktuell)
setInterval(() => sendLobbyList(), 4000);

// ── WebSocket-Handler ─────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
    ws.horseId = null;
    ws.lobbyId = null;

    sendLobbyList(ws);   // Willkommen — hier sind die offenen Lobbys

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // ── Lobby erstellen ──────────────────────────────────────────────────
        if (msg.type === 'createLobby' && !ws.lobbyId) {
            const lb = lobbyMgr.create(msg.lobbyName, msg.isPublic !== false);
            const id = Math.random().toString(36).substr(2, 8);
            ws.horseId = id;
            ws.lobbyId = lb.id;
            lb.race.addHorse(id, msg.horseType || 'blitz', msg.playerName || 'Fahrer', msg.rider || {});
            ws.send(JSON.stringify({ type: 'init', id, lobbyId: lb.id, lobbyName: lb.name }));
            sendLobbyList();
            console.log(`[+] Lobby ${lb.id} "${lb.name}" erstellt von "${msg.playerName}" (${msg.horseType})`);
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
