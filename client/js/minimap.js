const Minimap = (() => {
    const TRACK_A  = 55;
    const TRACK_B  = 28;
    const TW       = 11;
    const LANE_OFF = [-3.5, 0, 3.5];

    const W   = 195;
    const H   = 115;
    const PAD = 11;
    const CX  = W / 2;
    const CY  = H / 2;
    const SC  = Math.min(
        (W - PAD * 2) / (2 * (TRACK_A + TW / 2)),
        (H - PAD * 2) / (2 * (TRACK_B + TW / 2))
    );

    let _ctx = null;

    function init() {
        const c = document.getElementById('minimap');
        if (!c) return;
        c.width  = W;
        c.height = H;
        _ctx = c.getContext('2d');
    }

    // Welt-Fortschritt (0–1) + Lane-Offset → Canvas-Koordinaten
    function _tp(frac, laneOffset = 0) {
        const t   = frac * Math.PI * 2;
        const tx  = -Math.sin(t) * TRACK_A;
        const tz  =  Math.cos(t) * TRACK_B;
        const len = Math.sqrt(tx * tx + tz * tz);
        const wx  = Math.cos(t) * TRACK_A + (tz / len) * laneOffset;
        const wz  = Math.sin(t) * TRACK_B + (-tx / len) * laneOffset;
        return [CX + wx * SC, CY - wz * SC];
    }

    function _rrect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);     ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);     ctx.quadraticCurveTo(x,     y + h, x,     y + h - r);
        ctx.lineTo(x, y + r);         ctx.quadraticCurveTo(x,     y,     x + r, y);
        ctx.closePath();
    }

    function draw(state, playerId) {
        if (!_ctx) return;
        const ctx = _ctx;

        // ── Hintergrund ────────────────────────────────────────────────────
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(8,12,24,0.88)';
        _rrect(ctx, 0, 0, W, H, 10);
        ctx.fill();

        // ── Innenfeld (Gras) ───────────────────────────────────────────────
        ctx.beginPath();
        ctx.ellipse(CX, CY, (TRACK_A - TW/2) * SC, (TRACK_B - TW/2) * SC, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(22, 68, 22, 0.7)';
        ctx.fill();

        // ── Streckenoberfläche (Sand) ──────────────────────────────────────
        ctx.beginPath();
        ctx.ellipse(CX, CY, (TRACK_A + TW/2) * SC, (TRACK_B + TW/2) * SC, 0, 0, Math.PI * 2);
        ctx.ellipse(CX, CY, (TRACK_A - TW/2) * SC, (TRACK_B - TW/2) * SC, 0, Math.PI * 2, 0, true);
        ctx.fillStyle = 'rgba(175, 148, 90, 0.55)';
        ctx.fill('evenodd');

        // ── Spurtrennlinien (gelb, gestrichelt) ────────────────────────────
        ctx.strokeStyle = 'rgba(255,230,50,0.22)';
        ctx.lineWidth   = 0.7;
        ctx.setLineDash([3, 5]);
        for (const lo of [-1.75, 1.75]) {
            ctx.beginPath();
            for (let i = 0; i <= 128; i++) {
                const [sx, sy] = _tp(i / 128, lo);
                i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
            }
            ctx.closePath();
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // ── Streckenbegrenzungen ───────────────────────────────────────────
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth   = 0.8;
        for (const [ra, rb] of [
            [TRACK_A + TW/2, TRACK_B + TW/2],
            [TRACK_A - TW/2, TRACK_B - TW/2],
        ]) {
            ctx.beginPath();
            ctx.ellipse(CX, CY, ra * SC, rb * SC, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // ── Ziellinie ─────────────────────────────────────────────────────
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.moveTo(CX + (TRACK_A - TW/2) * SC, CY);
        ctx.lineTo(CX + (TRACK_A + TW/2) * SC, CY);
        ctx.stroke();

        // ── Hindernisse (kleine rote Rauten) ──────────────────────────────
        if (state.obstacles) {
            ctx.fillStyle = 'rgba(220,60,40,0.75)';
            for (const obs of state.obstacles) {
                const lo = obs.lane === -1 ? 0 : (LANE_OFF[obs.lane] ?? 0);
                const [sx, sy] = _tp(obs.progress / 1000, lo);
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(Math.PI / 4);
                ctx.fillRect(-2, -2, 4, 4);
                ctx.restore();
            }
        }

        // ── Power-Ups (farbige Punkte) ────────────────────────────────────
        if (state.powerups) {
            const PU_COLOR = { stamina:'#22ee55', turbo:'#ffd700', shield:'#44aaff' };
            for (const pu of state.powerups) {
                const lo = LANE_OFF[pu.lane] ?? 0;
                const [sx, sy] = _tp(pu.progress / 1000, lo);
                ctx.beginPath();
                ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
                ctx.fillStyle = PU_COLOR[pu.type] || '#fff';
                ctx.fill();
            }
        }

        // ── Pferde ────────────────────────────────────────────────────────
        for (const [id, h] of Object.entries(state.horses || {})) {
            const isMe = id === playerId;
            const lo   = LANE_OFF[h.lane ?? 1] ?? 0;
            const [sx, sy] = _tp(h.progress / 1000, lo);

            // Leuchtring für den Spieler
            if (isMe) {
                ctx.beginPath();
                ctx.arc(sx, sy, 8.5, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(255,215,0,0.3)';
                ctx.lineWidth   = 1.5;
                ctx.stroke();
            }

            // Dot
            ctx.beginPath();
            ctx.arc(sx, sy, isMe ? 5 : 3.5, 0, Math.PI * 2);
            ctx.fillStyle   = isMe ? '#ffd700' : (h.finished ? '#888' : '#ddd');
            ctx.strokeStyle = isMe ? 'rgba(255,250,200,0.9)' : 'rgba(0,0,0,0.55)';
            ctx.lineWidth   = 1;
            ctx.fill();
            ctx.stroke();
        }

        // ── Label ─────────────────────────────────────────────────────────
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.font      = 'bold 8px sans-serif';
        ctx.fillText('KARTE', 7, H - 5);
    }

    return { init, draw };
})();
