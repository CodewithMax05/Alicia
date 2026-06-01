const Minimap = (() => {
    let _trackA = 55;
    let _trackB = 28;
    const TW       = 11;
    const LANE_OFF = [-3.5, 0, 3.5];

    const W   = 195;
    const H   = 115;
    const PAD = 11;
    const CX  = W / 2;
    const CY  = H / 2;
    let SC = _calcSC(_trackA, _trackB);
    let _splineLUT  = null;   // gesetzt wenn Arctic aktiv

    // ── Frozen Circuit – identische Kontrollpunkte wie renderer.js ──────────
    const ARCTIC_PTS = [
        [ 70,  -2], [ 76, -18], [ 62, -36],
        [ 28, -44], [ -2, -44], [-30, -42],
        [-58, -30], [-76,  -6], [-62,  20],
        [-34,  36], [ -6,  38], [ 16,  28],
        [ 34,  36], [ 60,  20],
    ];

    function _crPt(p0,p1,p2,p3,t){
        const t2=t*t,t3=t2*t;
        return[0.5*(2*p1[0]+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
               0.5*(2*p1[1]+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)];
    }
    function _buildLUT(pts,N){
        const n=pts.length;
        const xs=new Float32Array(N),zs=new Float32Array(N);
        for(let i=0;i<N;i++){
            const u=(i/N)*n,seg=Math.floor(u)%n,t=u-Math.floor(u);
            const r=_crPt(pts[(seg-1+n)%n],pts[seg],pts[(seg+1)%n],pts[(seg+2)%n],t);
            xs[i]=r[0];zs[i]=r[1];
        }
        const nx=new Float32Array(N),nz=new Float32Array(N),arc=new Float32Array(N);
        let s=0;
        for(let i=0;i<N;i++){
            if(i>0){const dx=xs[i]-xs[i-1],dz=zs[i]-zs[i-1];s+=Math.sqrt(dx*dx+dz*dz);}
            arc[i]=s;
            const pi=(i-1+N)%N,ni=(i+1)%N;
            const dx=xs[ni]-xs[pi],dz=zs[ni]-zs[pi],len=Math.sqrt(dx*dx+dz*dz)||1;
            nx[i]=dz/len;nz[i]=-dx/len;
        }
        const wdx=xs[0]-xs[N-1],wdz=zs[0]-zs[N-1];
        return{xs,zs,nx,nz,arc,total:s+Math.sqrt(wdx*wdx+wdz*wdz),N};
    }
    function _lutPt(lut,progress,laneOff){
        const s=((progress%1000+1000)%1000)/1000*lut.total;
        let lo=0,hi=lut.N-1;
        while(lo<hi-1){const m=(lo+hi)>>1;if(lut.arc[m]<=s)lo=m;else hi=m;}
        const b=(lo+1)%lut.N;
        const sl=(b?lut.arc[b]:lut.total)-lut.arc[lo];
        const t=sl>0?(s-lut.arc[lo])/sl:0;
        const ex=lut.xs[lo]+(lut.xs[b]-lut.xs[lo])*t;
        const ez=lut.zs[lo]+(lut.zs[b]-lut.zs[lo])*t;
        const enx=lut.nx[lo]+(lut.nx[b]-lut.nx[lo])*t;
        const enz=lut.nz[lo]+(lut.nz[b]-lut.nz[lo])*t;
        const el=Math.sqrt(enx*enx+enz*enz)||1;
        return[CX+(ex+(enx/el)*laneOff)*SC, CY-(ez+(enz/el)*laneOff)*SC];
    }

    function _calcSC(a, b) {
        return Math.min(
            (W - PAD * 2) / (2 * (a + TW / 2)),
            (H - PAD * 2) / (2 * (b + TW / 2))
        );
    }

    /** Wird aufgerufen wenn die Map wechselt. mapId = 'meadow' | 'arctic' */
    function setTrackConfig(mapId) {
        if (mapId === 'arctic') {
            _trackA = 82; _trackB = 48;   // Bounding-Box des Splines (für SC-Berechnung)
            SC = _calcSC(_trackA, _trackB);
            _splineLUT = _buildLUT(ARCTIC_PTS, 256);
        } else {
            _trackA = 55; _trackB = 28;
            SC = _calcSC(_trackA, _trackB);
            _splineLUT = null;
        }
    }

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
        if (_splineLUT) return _lutPt(_splineLUT, frac * 1000, laneOffset);
        const t   = frac * Math.PI * 2;
        const tx  = -Math.sin(t) * _trackA;
        const tz  =  Math.cos(t) * _trackB;
        const len = Math.sqrt(tx * tx + tz * tz);
        const wx  = Math.cos(t) * _trackA + (tz / len) * laneOffset;
        const wz  = Math.sin(t) * _trackB + (-tx / len) * laneOffset;
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

        const isArctic = !!_splineLUT;
        const STEPS = 128;

        if (isArctic) {
            // ── Arctic: Streckenband als ausgefüllter Pfad ─────────────────
            ctx.beginPath();
            for (let i = 0; i <= STEPS; i++) {
                const [sx, sy] = _tp(i / STEPS, TW/2);
                i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
            }
            for (let i = STEPS; i >= 0; i--) {
                const [sx, sy] = _tp(i / STEPS, -TW/2);
                ctx.lineTo(sx, sy);
            }
            ctx.closePath();
            ctx.fillStyle = 'rgba(140, 200, 240, 0.65)';
            ctx.fill();

            // ── Innenfeld ──────────────────────────────────────────────────
            ctx.beginPath();
            for (let i = 0; i <= STEPS; i++) {
                const [sx, sy] = _tp(i / STEPS, -TW/2);
                i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
            }
            ctx.closePath();
            ctx.fillStyle = 'rgba(180, 210, 240, 0.45)';
            ctx.fill();
        } else {
            // ── Meadow: Ellipsen wie bisher ────────────────────────────────
            ctx.beginPath();
            ctx.ellipse(CX, CY, (_trackA - TW/2) * SC, (_trackB - TW/2) * SC, 0, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(22, 68, 22, 0.7)';
            ctx.fill();

            ctx.beginPath();
            ctx.ellipse(CX, CY, (_trackA + TW/2) * SC, (_trackB + TW/2) * SC, 0, 0, Math.PI * 2);
            ctx.ellipse(CX, CY, (_trackA - TW/2) * SC, (_trackB - TW/2) * SC, 0, Math.PI * 2, 0, true);
            ctx.fillStyle = 'rgba(175, 148, 90, 0.55)';
            ctx.fill('evenodd');
        }

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
        if (isArctic) {
            for (const lo of [-TW/2, TW/2]) {
                ctx.beginPath();
                for (let i = 0; i <= STEPS; i++) {
                    const [sx, sy] = _tp(i / STEPS, lo);
                    i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
                }
                ctx.closePath();
                ctx.stroke();
            }
        } else {
            for (const [ra, rb] of [[_trackA+TW/2, _trackB+TW/2], [_trackA-TW/2, _trackB-TW/2]]) {
                ctx.beginPath();
                ctx.ellipse(CX, CY, ra*SC, rb*SC, 0, 0, Math.PI*2);
                ctx.stroke();
            }
        }

        // ── Ziellinie ─────────────────────────────────────────────────────
        ctx.strokeStyle = isArctic ? '#88ddff' : '#ffd700';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        if (isArctic) {
            const [x1,y1] = _tp(0, -TW/2);
            const [x2,y2] = _tp(0,  TW/2);
            ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        } else {
            ctx.moveTo(CX + (_trackA - TW/2) * SC, CY);
            ctx.lineTo(CX + (_trackA + TW/2) * SC, CY);
        }
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
        ctx.fillText(isArctic ? 'ARKTIS' : 'WIESE', 7, H - 5);
    }

    return { init, draw, setTrackConfig };
})();
