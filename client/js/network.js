const Network = (() => {
    let ws;
    let playerId      = null;
    let _horseType    = 'blitz';
    let onStateCb     = null;
    let onChatCb      = null;
    let onLobbyListCb = null;
    let onErrorCb     = null;
    let onInitCb      = null;
    let onKickedCb    = null;

    function connect(url, { onState, onChat, onLobbyList, onError, onInit, onKicked } = {}) {
        onStateCb     = onState     || null;
        onChatCb      = onChat      || null;
        onLobbyListCb = onLobbyList || null;
        onErrorCb     = onError     || null;
        onInitCb      = onInit      || null;
        onKickedCb    = onKicked    || null;

        ws = new WebSocket(url);

        ws.onopen  = () => setStatus('Verbunden', '#4caf50');
        ws.onclose = () => setStatus('Getrennt – neu laden', '#f44336');
        ws.onerror = () => setStatus('Verbindungsfehler', '#f44336');

        ws.onmessage = ({ data }) => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }

            switch (msg.type) {
                case 'init':
                    playerId = msg.id;
                    Renderer.setPlayerId(playerId);
                    setStatus('Im Rennen', '#4caf50');
                    onInitCb?.(msg);
                    break;
                case 'state':
                    onStateCb?.(msg);
                    break;
                case 'chat':
                    onChatCb?.(msg);
                    break;
                case 'lobbyList':
                    onLobbyListCb?.(msg.lobbies);
                    break;
                case 'error':
                    onErrorCb?.(msg);
                    break;
                case 'kicked':
                    onKickedCb?.();
                    break;
            }
        };
    }

    function sendCreateLobby(lobbyName, isPublic, horseType, playerName, riderConfig, totalLaps) {
        _horseType = horseType;
        _send({ type: 'createLobby', lobbyName, isPublic, horseType, playerName, rider: riderConfig, totalLaps: totalLaps || 2 });
    }

    function sendJoinLobby(lobbyId, horseType, playerName, riderConfig) {
        _horseType = horseType;
        _send({ type: 'joinLobby', lobbyId, horseType, playerName, rider: riderConfig });
    }

    function sendInput(input)            { _send({ type: 'input',         input }); }
    function sendChat(message)           { _send({ type: 'chat',          message }); }
    function sendReady(ready)            { _send({ type: 'ready',         ready }); }
    function sendStartGame()             { _send({ type: 'startGame' }); }
    function sendReturnToLobby()         { _send({ type: 'returnToLobby' }); }
    function sendKickPlayer(targetId)    { _send({ type: 'kickPlayer',    targetId }); }

    function getPlayerId()  { return playerId; }
    function getHorseType() { return _horseType; }

    function _send(obj) {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    function setStatus(text, color) {
        const el = document.getElementById('status');
        if (el) { el.textContent = text; el.style.color = color; }
    }

    return {
        connect,
        sendCreateLobby, sendJoinLobby,
        sendInput, sendChat, sendReady, sendStartGame, sendReturnToLobby, sendKickPlayer,
        getPlayerId, getHorseType,
    };
})();
