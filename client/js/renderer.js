const Renderer = (() => {
    const TRACK_LENGTH   = 1000;
    let   TRACK_A        = 55;
    let   TRACK_B        = 28;
    const LANE_OFFSETS   = [-3.5, 0, 3.5];
    const TW             = 11;

    let _currentMapId = 'meadow';
    let _envMeshes    = [];
    let _arcticLUT    = null;   // Spline-LUT für Arctic-Map

    // ── Frozen Circuit – Kontrollpunkte (identisch mit RaceManager.js) ────────
    const ARCTIC_PTS = [
        [ 70,  -2], [ 76, -18], [ 62, -36],
        [ 28, -44], [ -2, -44], [-30, -42],
        [-58, -30], [-76,  -6], [-62,  20],
        [-34,  36], [ -6,  38], [ 16,  28],
        [ 34,  36], [ 60,  20],
    ];

    function _crPt(p0, p1, p2, p3, t) {
        const t2=t*t, t3=t2*t;
        return [
            0.5*(2*p1[0]+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
            0.5*(2*p1[1]+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3),
        ];
    }

    function _buildSplineLUT(pts, N) {
        const n=pts.length;
        const xs=new Float32Array(N), zs=new Float32Array(N);
        for (let i=0; i<N; i++) {
            const u=(i/N)*n, seg=Math.floor(u)%n, t=u-Math.floor(u);
            const r=_crPt(pts[(seg-1+n)%n],pts[seg],pts[(seg+1)%n],pts[(seg+2)%n],t);
            xs[i]=r[0]; zs[i]=r[1];
        }
        const nx=new Float32Array(N), nz=new Float32Array(N), arc=new Float32Array(N);
        let s=0;
        for (let i=0; i<N; i++) {
            if (i>0) { const dx=xs[i]-xs[i-1], dz=zs[i]-zs[i-1]; s+=Math.sqrt(dx*dx+dz*dz); }
            arc[i]=s;
            const pi=(i-1+N)%N, ni=(i+1)%N;
            const dx=xs[ni]-xs[pi], dz=zs[ni]-zs[pi], len=Math.sqrt(dx*dx+dz*dz)||1;
            nx[i]=dz/len; nz[i]=-dx/len;
        }
        const wdx=xs[0]-xs[N-1], wdz=zs[0]-zs[N-1];
        return { xs, zs, nx, nz, arc, total: s+Math.sqrt(wdx*wdx+wdz*wdz), N };
    }

    function _splinePos(lut, progress, laneOff) {
        const s=((progress%TRACK_LENGTH+TRACK_LENGTH)%TRACK_LENGTH)/TRACK_LENGTH*lut.total;
        let lo=0, hi=lut.N-1;
        while (lo<hi-1) { const m=(lo+hi)>>1; if(lut.arc[m]<=s) lo=m; else hi=m; }
        const b=(lo+1)%lut.N;
        const segLen=(b?lut.arc[b]:lut.total)-lut.arc[lo];
        const t=segLen>0?(s-lut.arc[lo])/segLen:0;
        const ex=lut.xs[lo]+(lut.xs[b]-lut.xs[lo])*t;
        const ez=lut.zs[lo]+(lut.zs[b]-lut.zs[lo])*t;
        const enx=lut.nx[lo]+(lut.nx[b]-lut.nx[lo])*t;
        const enz=lut.nz[lo]+(lut.nz[b]-lut.nz[lo])*t;
        const el=Math.sqrt(enx*enx+enz*enz)||1;
        return { x: ex+(enx/el)*laneOff, z: ez+(enz/el)*laneOff };
    }

    let engine, scene, camera, followCam;
    let cameraMode   = 'follow';
    let _shadowGen   = null;
    let _particleTex = null;
    const horses         = {};
    const obstacleMeshes = {};
    const powerupMeshes  = {};
    let _playerId        = null;
    let _finishBanner    = null;
    let _shakeEnd        = 0;
    let _shakeIntensity  = 0;
    const _flagMeshes    = [];
    const _spectators    = [];       // { body, baseY, z }
    const _waves         = [];       // { z0, dir, startTime }

    // ── Wetter-State ──────────────────────────────────────────────────────────
    let _sun         = null;
    let _amb         = null;
    let _skyMat      = null;
    let _skyDome     = null;
    let _rainPs      = null;
    let _snowPs      = null;
    let _nightLights = [];

    const WEATHER_PRESETS = {
        sunny: {
            skyVisible: true, skyTurbidity: 8,  skyLuminance: 0.90, skyInclination: 0.42,  skyAzimuth: 0.30,
            sunIntensity: 1.4, sunColor:  [1.00, 0.98, 0.90],
            ambIntensity: 0.55, ambColor: [1.00, 1.00, 1.00],
            fogDensity: 0.004, fogColor: [0.70, 0.85, 1.00], clearColor: [0.40, 0.65, 0.90],
            night: false, rain: false,
        },
        sunset: {
            skyVisible: true, skyTurbidity: 16, skyLuminance: 1.00, skyInclination: 0.495, skyAzimuth: 0.22,
            sunIntensity: 1.1, sunColor:  [1.00, 0.55, 0.20],
            ambIntensity: 0.45, ambColor: [1.00, 0.70, 0.40],
            fogDensity: 0.005, fogColor: [0.85, 0.55, 0.30], clearColor: [0.70, 0.35, 0.15],
            night: false, rain: false,
        },
        night: {
            skyVisible: false,
            sunIntensity: 0.05, sunColor:  [0.30, 0.35, 0.60],
            ambIntensity: 0.12, ambColor:  [0.25, 0.27, 0.48],
            fogDensity: 0.006, fogColor: [0.04, 0.05, 0.14], clearColor: [0.04, 0.05, 0.14],
            night: true, rain: false,
        },
        dawn: {
            skyVisible: true, skyTurbidity: 6,  skyLuminance: 0.88, skyInclination: 0.485, skyAzimuth: 0.55,
            sunIntensity: 0.90, sunColor:  [1.00, 0.78, 0.55],
            ambIntensity: 0.40, ambColor:  [0.80, 0.70, 0.90],
            fogDensity: 0.008, fogColor: [0.60, 0.55, 0.65], clearColor: [0.42, 0.38, 0.58],
            night: false, rain: false,
        },
        rainy: {
            skyVisible: true, skyTurbidity: 12, skyLuminance: 0.65, skyInclination: 0.44,  skyAzimuth: 0.30,
            sunIntensity: 0.65, sunColor:  [0.80, 0.85, 0.95],
            ambIntensity: 0.70, ambColor:  [0.72, 0.76, 0.85],
            fogDensity: 0.010, fogColor: [0.52, 0.57, 0.62], clearColor: [0.33, 0.38, 0.48],
            night: false, rain: true,
        },
        foggy: {
            skyVisible: true, skyTurbidity: 3,  skyLuminance: 0.72, skyInclination: 0.43,  skyAzimuth: 0.30,
            sunIntensity: 0.75, sunColor:  [0.95, 0.95, 0.90],
            ambIntensity: 0.72, ambColor:  [0.90, 0.90, 0.88],
            fogDensity: 0.025, fogColor: [0.76, 0.78, 0.78], clearColor: [0.65, 0.68, 0.68],
            night: false, rain: false,
        },
        // Arktis-Preset — wird automatisch für die Arctic-Map gesetzt
        arctic: {
            skyVisible: true, skyTurbidity: 5,  skyLuminance: 0.82, skyInclination: 0.47,  skyAzimuth: 0.50,
            sunIntensity: 0.70, sunColor:  [0.88, 0.92, 1.00],
            ambIntensity: 0.80, ambColor:  [0.82, 0.90, 1.00],
            fogDensity: 0.007, fogColor: [0.72, 0.82, 0.94], clearColor: [0.52, 0.70, 0.88],
            night: false, rain: false, snow: true,
        },
    };

    // Canvas-basierte Weichzeichner-Textur für alle Partikel
    function createParticleTex() {
        const sz  = 32;
        const c   = document.createElement('canvas');
        c.width   = c.height = sz;
        const ctx = c.getContext('2d');
        const g   = ctx.createRadialGradient(sz/2, sz/2, 0, sz/2, sz/2, sz/2);
        g.addColorStop(0,   'rgba(255,255,255,1)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
        g.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, sz, sz);
        return new BABYLON.Texture(c.toDataURL(), scene);
    }

    // Gibt Position auf der Strecke zurück. laneOffset: float (-3.5 … +3.5)
    function trackPosition(progress, laneOffset = 0) {
        if (_arcticLUT) {
            const p = _splinePos(_arcticLUT, progress, laneOffset);
            return new BABYLON.Vector3(p.x, 0, p.z);
        }
        const t  = (progress / TRACK_LENGTH) * Math.PI * 2;
        const cx = Math.cos(t) * TRACK_A;
        const cz = Math.sin(t) * TRACK_B;
        if (laneOffset === 0) return new BABYLON.Vector3(cx, 0, cz);
        const tx  = -Math.sin(t) * TRACK_A;
        const tz  =  Math.cos(t) * TRACK_B;
        const len = Math.sqrt(tx * tx + tz * tz);
        return new BABYLON.Vector3(cx + (tz / len) * laneOffset, 0, cz + (-tx / len) * laneOffset);
    }

    // Ziellinien-Weltposition (erstes Spline-Sample oder Ellipsen-Scheitel)
    function _finishWorldPos() {
        if (_arcticLUT) {
            const p = _splinePos(_arcticLUT, 0, 0);
            return new BABYLON.Vector3(p.x, 0, p.z);
        }
        return new BABYLON.Vector3(TRACK_A, 0, 0);
    }

    function mat(scene, color) {
        const m = new BABYLON.StandardMaterial('m' + Math.random(), scene);
        m.diffuseColor = color;
        return m;
    }

    function createHorse(scene, bodyColor) {
        const root      = new BABYLON.TransformNode('horse', scene);
        const bodyMat   = mat(scene, bodyColor);
        const darkMat   = mat(scene, new BABYLON.Color3(bodyColor.r * 0.45, bodyColor.g * 0.35, bodyColor.b * 0.25));
        const hoofMat   = mat(scene, new BABYLON.Color3(0.15, 0.1, 0.08));
        const eyeMat    = mat(scene, new BABYLON.Color3(0.05, 0.03, 0.02));           // Pupille: fast schwarz
        const scleraMat = mat(scene, new BABYLON.Color3(0.72, 0.55, 0.38));           // Sklera: warmes Braun

        function part(name, size, pos, rotX, m) {
            const mesh = BABYLON.MeshBuilder.CreateBox(name, size, scene);
            mesh.position = new BABYLON.Vector3(...pos);
            if (rotX) mesh.rotation.x = rotX;
            mesh.material = m;
            mesh.parent   = root;
            return mesh;
        }

        // Körper — Brust etwas voluminöser als Hinterhand
        part('body',   { width: 1.7,  height: 1.5,  depth: 4.2 }, [0,  2.1,   0],    0,     bodyMat);
        part('chest',  { width: 1.95, height: 0.50, depth: 1.6 }, [0,  2.85,  0.8],  0,     bodyMat); // Brustmuskeln
        part('neck',   { width: 0.85, height: 1.7,  depth: 0.75}, [0,  3.2,   1.6], -0.45,  bodyMat);
        part('head',   { width: 0.8,  height: 0.9,  depth: 1.4 }, [0,  4.0,   2.55], -0.1,  bodyMat);
        part('snout',  { width: 0.55, height: 0.6,  depth: 0.8 }, [0,  3.65,  3.2],   0.2,  bodyMat);
        part('nlL',    { width: 0.12, height: 0.08, depth: 0.08}, [ 0.18, 3.45, 3.52], 0,   darkMat);
        part('nlR',    { width: 0.12, height: 0.08, depth: 0.08}, [-0.18, 3.45, 3.52], 0,   darkMat);
        // Ohren mit sichtbarer Innen-Fläche
        part('earL',   { width: 0.18, height: 0.38, depth: 0.14}, [ 0.28, 4.55, 2.3],  0,   bodyMat);
        part('earR',   { width: 0.18, height: 0.38, depth: 0.14}, [-0.28, 4.55, 2.3],  0,   bodyMat);
        part('earLi',  { width: 0.08, height: 0.26, depth: 0.06}, [ 0.28, 4.53, 2.3],  0,   darkMat);
        part('earRi',  { width: 0.08, height: 0.26, depth: 0.06}, [-0.28, 4.53, 2.3],  0,   darkMat);

        // Augen: Sklera (braun) + Pupille (schwarz), je eine pro Seite
        [0.405, -0.405].forEach((ex, i) => {
            const ew = BABYLON.MeshBuilder.CreateSphere('ew'+i, { diameter: 0.24, segments: 5 }, scene);
            ew.position = new BABYLON.Vector3(ex, 4.08, 2.72);
            ew.material = scleraMat; ew.parent = root;
            const ep = BABYLON.MeshBuilder.CreateSphere('ep'+i, { diameter: 0.15, segments: 4 }, scene);
            ep.position = new BABYLON.Vector3(ex * 1.06, 4.08, 2.80);
            ep.material = eyeMat; ep.parent = root;
        });

        // Mähne — 7 Strähnen entlang des Nackenkamms
        // Jede Strähne folgt dem Halswinkel (rotation.x = -0.45) und
        // fällt leicht zur Seite (rotation.z = +0.22).
        // [x, y, z, höhe, breite]
        const maneData = [
            [0.42, 4.18, 2.22, 0.48, 0.13],   // Stirnpartie
            [0.42, 3.97, 2.01, 0.56, 0.15],
            [0.41, 3.75, 1.80, 0.60, 0.16],   // Mitte – breiteste Strähne
            [0.40, 3.54, 1.60, 0.58, 0.16],
            [0.39, 3.34, 1.42, 0.52, 0.15],
            [0.38, 3.15, 1.25, 0.44, 0.13],
            [0.36, 2.98, 1.10, 0.36, 0.12],   // Widerrist
        ];
        for (let i = 0; i < maneData.length; i++) {
            const [mx, my, mz, mh, mw] = maneData[i];
            const strand = BABYLON.MeshBuilder.CreateBox('mane' + i,
                { width: mw, height: mh, depth: 0.19 }, scene);
            strand.position   = new BABYLON.Vector3(mx, my, mz);
            strand.rotation.x = -0.45;   // Halsneigung
            strand.rotation.z =  0.22;   // fällt nach rechts
            strand.material   = darkMat;
            strand.parent     = root;
        }

        // Schweif — zwei verbundene Zylinder
        // tail1: vom Rücken leicht nach oben/hinten  (Verbindungspunkt = +Y-Ende)
        // tail2: hängt vom Verbindungspunkt nach unten (Verbindungspunkt = +Y-Ende)
        //
        // Verbindungspunkt  = center_tail1 + 0.5*h1*(0, cos(-0.40), sin(-0.40))
        //                   = (0, 3.05, -2.15) + (0, +0.368, -0.156) = (0, 3.418, -2.306)
        // center_tail2      = junction    - 0.5*h2*(0, cos(+0.50), sin(+0.50))
        //                   = (0, 3.418, -2.306) - (0, +0.395, +0.216) = (0, 3.023, -2.522)
        // Durchmesser an der Verbindung: beide 0.16 → nahtlos.

        // tail1: rotation.x=-0.55 → weniger steil nach oben, mehr nach hinten
        // junction = (0,3.05,-2.15) + 0.4*(0, cos(-0.55), sin(-0.55))
        //          = (0, 3.05+0.341, -2.15-0.209) = (0, 3.391, -2.359)
        const tail1 = BABYLON.MeshBuilder.CreateCylinder('tail1',
            { diameterTop: 0.16, diameterBottom: 0.34, height: 0.80, tessellation: 6 }, scene);
        tail1.position   = new BABYLON.Vector3(0, 3.05, -2.15);
        tail1.rotation.x = -0.55;
        tail1.material   = darkMat; tail1.parent = root;

        // center_tail2 = junction - 0.45*(0, cos0.50, sin0.50)
        //              = (0, 3.391-0.395, -2.359-0.216) = (0, 2.996, -2.575)
        const tail2 = BABYLON.MeshBuilder.CreateCylinder('tail2',
            { diameterTop: 0.16, diameterBottom: 0.09, height: 0.90, tessellation: 5 }, scene);
        tail2.position   = new BABYLON.Vector3(0, 3.00, -2.58);
        tail2.rotation.x =  0.50;
        tail2.material   = darkMat; tail2.parent = root;

        // bottom_tail2 = (0,2.996,-2.575) + 0.45*(0,-cos0.50,-sin0.50)
        //              = (0, 2.601, -2.791)
        // center_tail3 = bottom_tail2 - 0.35*(0, cos0.15, sin0.15)
        //              = (0, 2.601-0.346, -2.791-0.053) = (0, 2.255, -2.844)
        const tail3 = BABYLON.MeshBuilder.CreateCylinder('tail3',
            { diameterTop: 0.09, diameterBottom: 0.03, height: 0.70, tessellation: 5 }, scene);
        tail3.position   = new BABYLON.Vector3(0, 2.26, -2.84);
        tail3.rotation.x =  0.15;
        tail3.material   = darkMat; tail3.parent = root;

        // Beine — Oberschenkel Quader, Unterschenkel Zylinder (runder Querschnitt)
        const legDefs = [
            { n:'FL', x: 0.58, z: 1.3,  phase: 0 },
            { n:'FR', x:-0.58, z: 1.3,  phase: Math.PI },
            { n:'BL', x: 0.58, z:-1.3,  phase: Math.PI },
            { n:'BR', x:-0.58, z:-1.3,  phase: 0 },
        ];
        const legMeshes = [];
        for (const d of legDefs) {
            const upper = BABYLON.MeshBuilder.CreateBox('u'+d.n, { width:0.38, height:0.9, depth:0.38 }, scene);
            upper.position = new BABYLON.Vector3(d.x, 1.35, d.z);
            upper.material = bodyMat; upper.parent = root;
            const lower = BABYLON.MeshBuilder.CreateCylinder('l'+d.n,
                { diameterTop: 0.22, diameterBottom: 0.28, height: 0.85, tessellation: 6 }, scene);
            lower.position = new BABYLON.Vector3(0, -0.85, 0);
            lower.material = bodyMat; lower.parent = upper;
            const hoof = BABYLON.MeshBuilder.CreateBox('h'+d.n, { width:0.35, height:0.22, depth:0.42 }, scene);
            hoof.position = new BABYLON.Vector3(0, -0.53, 0.06);
            hoof.material = hoofMat; hoof.parent = lower;
            legMeshes.push({ upper, lower, phase: d.phase, isFront: d.z > 0 });
        }

        // Treffanzeige (rote Umrandung)
        // Emissive-Farbe für Hit-Flash (wird im Render-Loop gesetzt)
        bodyMat.emissiveColor = new BABYLON.Color3(0, 0, 0);

        if (_shadowGen) root.getChildMeshes().forEach(m => _shadowGen.addShadowCaster(m));

        // Unsichtbares Anker-Mesh für Partikel (TransformNode funktioniert nicht als Emitter)
        const emitAnchor = BABYLON.MeshBuilder.CreateBox('ea_' + Math.random(), { size: 0.01 }, scene);
        emitAnchor.isVisible = false;
        emitAnchor.parent    = root;

        // ── Staub-Partikel (hinter den Hufen) ────────────────────────────────
        const dustPs = new BABYLON.ParticleSystem('dust_' + Math.random(), 60, scene);
        dustPs.particleTexture = _particleTex;
        dustPs.emitter         = emitAnchor;
        dustPs.minEmitBox      = new BABYLON.Vector3(-0.7, 0.05, -1.8);
        dustPs.maxEmitBox      = new BABYLON.Vector3( 0.7, 0.2,  -0.6);
        dustPs.color1          = new BABYLON.Color4(0.82, 0.72, 0.52, 0.9);
        dustPs.color2          = new BABYLON.Color4(0.65, 0.55, 0.38, 0.5);
        dustPs.colorDead       = new BABYLON.Color4(0.5,  0.4,  0.3,  0.0);
        dustPs.minSize         = 0.1;  dustPs.maxSize         = 0.5;
        dustPs.minLifeTime     = 0.2;  dustPs.maxLifeTime     = 0.6;
        dustPs.emitRate        = 0;
        dustPs.direction1      = new BABYLON.Vector3(-0.6,  0.4, -2.5);
        dustPs.direction2      = new BABYLON.Vector3( 0.6,  1.4, -0.4);
        dustPs.minEmitPower    = 0.5;  dustPs.maxEmitPower    = 1.8;
        dustPs.gravity         = new BABYLON.Vector3(0, -5, 0);
        dustPs.start();

        // ── Treffer-Funken (burst bei Hindernis) ─────────────────────────────
        const hitPs = new BABYLON.ParticleSystem('hitp_' + Math.random(), 50, scene);
        hitPs.particleTexture  = _particleTex;
        hitPs.emitter          = emitAnchor;
        hitPs.minEmitBox       = new BABYLON.Vector3(-1,  0.5, -1);
        hitPs.maxEmitBox       = new BABYLON.Vector3( 1,  2.5,  1);
        hitPs.color1           = new BABYLON.Color4(1.0, 0.8, 0.1, 1.0);
        hitPs.color2           = new BABYLON.Color4(1.0, 0.3, 0.0, 0.9);
        hitPs.colorDead        = new BABYLON.Color4(0.5, 0.1, 0.0, 0.0);
        hitPs.minSize          = 0.08; hitPs.maxSize          = 0.35;
        hitPs.minLifeTime      = 0.15; hitPs.maxLifeTime      = 0.45;
        hitPs.emitRate         = 0;
        hitPs.direction1       = new BABYLON.Vector3(-4, 1, -4);
        hitPs.direction2       = new BABYLON.Vector3( 4, 8,  4);
        hitPs.minEmitPower     = 2;    hitPs.maxEmitPower     = 6;
        hitPs.gravity          = new BABYLON.Vector3(0, -14, 0);
        hitPs.blendMode        = BABYLON.ParticleSystem.BLENDMODE_ADD;
        hitPs.start();

        // ── Schild-Aura (blaue Blase, pulsiert wenn Schild aktiv) ───────────────
        const shieldBubble = BABYLON.MeshBuilder.CreateSphere('shB_' + Math.random(),
            { diameter: 5.4, segments: 8 }, scene);
        const shieldMat = new BABYLON.StandardMaterial('shm_' + Math.random(), scene);
        shieldMat.diffuseColor    = new BABYLON.Color3(0.20, 0.55, 1.0);
        shieldMat.emissiveColor   = new BABYLON.Color3(0.08, 0.30, 0.90);
        shieldMat.alpha           = 0.22;
        shieldMat.backFaceCulling = false;
        shieldBubble.material     = shieldMat;
        shieldBubble.position.y   = 2.2;
        shieldBubble.parent       = root;
        shieldBubble.isVisible    = false;

        // ── Turbo-Flammen (Partikel hinter dem Pferd) ────────────────────────
        const turboPs = new BABYLON.ParticleSystem('turbo_' + Math.random(), 90, scene);
        turboPs.particleTexture = _particleTex;
        turboPs.emitter         = emitAnchor;
        turboPs.minEmitBox      = new BABYLON.Vector3(-0.55, 0.4, -2.2);
        turboPs.maxEmitBox      = new BABYLON.Vector3( 0.55, 2.6, -0.8);
        turboPs.color1          = new BABYLON.Color4(1.0, 0.82, 0.0, 1.0);
        turboPs.color2          = new BABYLON.Color4(1.0, 0.28, 0.0, 0.9);
        turboPs.colorDead       = new BABYLON.Color4(0.4, 0.05, 0.0, 0.0);
        turboPs.minSize         = 0.15;  turboPs.maxSize      = 0.55;
        turboPs.minLifeTime     = 0.10;  turboPs.maxLifeTime  = 0.30;
        turboPs.emitRate        = 0;
        turboPs.direction1      = new BABYLON.Vector3(-1.5, 0.5, -9);
        turboPs.direction2      = new BABYLON.Vector3( 1.5, 3.5, -4);
        turboPs.minEmitPower    = 3;     turboPs.maxEmitPower = 9;
        turboPs.gravity         = new BABYLON.Vector3(0, -6, 0);
        turboPs.blendMode       = BABYLON.ParticleSystem.BLENDMODE_ADD;
        turboPs.start();

        // ── Ziel-Konfetti am Pferd (einmaliger Burst beim Einlauf) ───────────
        const finishPs = new BABYLON.ParticleSystem('fin_' + Math.random(), 220, scene);
        finishPs.particleTexture = _particleTex;
        finishPs.emitter         = emitAnchor;
        finishPs.minEmitBox      = new BABYLON.Vector3(-1.0, 0.5, -1.0);
        finishPs.maxEmitBox      = new BABYLON.Vector3( 1.0, 3.0,  1.0);
        finishPs.color1          = new BABYLON.Color4(1.0, 0.90, 0.1, 1.0);
        finishPs.color2          = new BABYLON.Color4(0.2,  0.8, 1.0, 1.0);
        finishPs.colorDead       = new BABYLON.Color4(1.0,  0.5, 0.0, 0.0);
        finishPs.minSize         = 0.18;  finishPs.maxSize      = 0.50;
        finishPs.minLifeTime     = 1.2;   finishPs.maxLifeTime  = 3.0;
        finishPs.emitRate        = 0;
        finishPs.direction1      = new BABYLON.Vector3(-4,  6, -4);
        finishPs.direction2      = new BABYLON.Vector3( 4, 18,  4);
        finishPs.minEmitPower    = 2;     finishPs.maxEmitPower = 9;
        finishPs.gravity         = new BABYLON.Vector3(0, -7, 0);
        finishPs.blendMode       = BABYLON.ParticleSystem.BLENDMODE_ADD;
        finishPs.start();

        // ── Blitz-Stun-Funken (gelb, Burst wenn Pferd von Blitz getroffen) ───
        const blitzPs = new BABYLON.ParticleSystem('bltz_' + Math.random(), 100, scene);
        blitzPs.particleTexture = _particleTex;
        blitzPs.emitter         = emitAnchor;
        blitzPs.minEmitBox      = new BABYLON.Vector3(-1.5, 0.0, -1.5);
        blitzPs.maxEmitBox      = new BABYLON.Vector3( 1.5, 3.5,  1.5);
        blitzPs.color1          = new BABYLON.Color4(1.0, 1.0, 0.1, 1.0);
        blitzPs.color2          = new BABYLON.Color4(1.0, 0.55, 0.0, 0.9);
        blitzPs.colorDead       = new BABYLON.Color4(0.8, 0.7, 0.0, 0.0);
        blitzPs.minSize         = 0.18;  blitzPs.maxSize      = 0.70;
        blitzPs.minLifeTime     = 0.20;  blitzPs.maxLifeTime  = 0.70;
        blitzPs.emitRate        = 0;
        blitzPs.direction1      = new BABYLON.Vector3(-8,  4, -8);
        blitzPs.direction2      = new BABYLON.Vector3( 8, 14,  8);
        blitzPs.minEmitPower    = 4;     blitzPs.maxEmitPower = 13;
        blitzPs.gravity         = new BABYLON.Vector3(0, -16, 0);
        blitzPs.blendMode       = BABYLON.ParticleSystem.BLENDMODE_ADD;
        blitzPs.start();

        // ── Windschatten-Partikel (cyan, kontinuierlich im Slipstream) ───────
        const slipPs = new BABYLON.ParticleSystem('slip_' + Math.random(), 60, scene);
        slipPs.particleTexture = _particleTex;
        slipPs.emitter         = emitAnchor;
        slipPs.minEmitBox      = new BABYLON.Vector3(-0.5, 0.5, -0.5);
        slipPs.maxEmitBox      = new BABYLON.Vector3( 0.5, 2.5,  0.5);
        slipPs.color1          = new BABYLON.Color4(0.1, 1.0, 0.85, 0.8);
        slipPs.color2          = new BABYLON.Color4(0.0, 0.65, 1.0, 0.6);
        slipPs.colorDead       = new BABYLON.Color4(0.1, 0.5,  0.8, 0.0);
        slipPs.minSize         = 0.07;  slipPs.maxSize      = 0.26;
        slipPs.minLifeTime     = 0.18;  slipPs.maxLifeTime  = 0.44;
        slipPs.emitRate        = 0;
        slipPs.direction1      = new BABYLON.Vector3(-1.5, 1.0, -7);
        slipPs.direction2      = new BABYLON.Vector3( 1.5, 3.5, -2);
        slipPs.minEmitPower    = 2;     slipPs.maxEmitPower = 6;
        slipPs.gravity         = new BABYLON.Vector3(0, -4, 0);
        slipPs.blendMode       = BABYLON.ParticleSystem.BLENDMODE_ADD;
        slipPs.start();

        return { root, legMeshes, bodyMat, dustPs, hitPs, shieldBubble, turboPs, finishPs, blitzPs, slipPs };
    }

    function buildTree(x, z, h = 4, s = 1) {
        // Zufällig: lange Kiefer oder kurze Tanne (wie Arktis, aber grün)
        const longTrunk = Math.random() > 0.5;
        const trunkH    = longTrunk ? h * 0.40 : h * 0.12;
        const trunkD    = (0.20 + h * 0.018) * s;
        const trunk = BABYLON.MeshBuilder.CreateCylinder('tr_' + Math.random(),
            { height: trunkH, diameter: trunkD, tessellation: 6 }, scene);
        trunk.position = new BABYLON.Vector3(x, trunkH / 2, z);
        trunk.material = mat(scene, new BABYLON.Color3(0.36, 0.20, 0.08));
        if (_shadowGen) _shadowGen.addShadowCaster(trunk);

        const numL   = longTrunk ? 3 : 4;
        const step   = (h - trunkH) / numL;
        const gr     = 0.10 + Math.random() * 0.07;
        const gg     = 0.38 + Math.random() * 0.14;
        const greenM = mat(scene, new BABYLON.Color3(gr, gg, 0.08));

        for (let i = 0; i < numL; i++) {
            const t      = i / (numL - 1);
            const botD   = (h * (0.58 - t * 0.36)) * s;
            const layerH = step * 1.18;
            const layerY = trunkH + i * step + layerH * 0.38;
            const cone   = BABYLON.MeshBuilder.CreateCylinder('tp_' + Math.random(),
                { height: layerH, diameterTop: 0, diameterBottom: botD, tessellation: 7 }, scene);
            cone.position = new BABYLON.Vector3(x, layerY, z);
            cone.material = greenM;
            if (_shadowGen) _shadowGen.addShadowCaster(cone);
        }
    }

    function buildTrees() {
        // Tribünen-Sperrzone: linke Seite x < -62, |z| < 28 — rechte Seite x > 62, |z| < 22
        function inStandZone(x, z) {
            return (x < -62 && Math.abs(z) < 28) || (x > 62 && Math.abs(z) < 22);
        }
        // See-Sperrzone (nur das Wasser selbst, kein Extra-Puffer) + Angler-Sperrzone
        const MLK_CX = 0, MLK_CZ = 0, MLK_RX = 28, MLK_RZ = 12;
        function inLakeZone(x, z) {
            const dx = x - MLK_CX, dz = z - MLK_CZ;
            // Nur den Wasserkörper sperren (Bäume am Uferrand sind ok)
            if ((dx * dx) / (MLK_RX * MLK_RX) + (dz * dz) / (MLK_RZ * MLK_RZ) < 1.0) return true;
            // Angler-Positionen: (±(MLK_RX+1), MLK_CZ) – Sperrradius 3
            if ((x - (MLK_CX + MLK_RX + 1)) ** 2 + (z - MLK_CZ) ** 2 < 9) return true;
            if ((x - (MLK_CX - MLK_RX - 1)) ** 2 + (z - MLK_CZ) ** 2 < 9) return true;
            return false;
        }
        const count = 28;
        for (let i = 0; i < count; i++) {
            const t   = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
            const rx  = TRACK_A + 16 + Math.random() * 20;
            const rz  = TRACK_B + 16 + Math.random() * 20;
            const tx  = Math.cos(t) * rx;
            const tz  = Math.sin(t) * rz;
            if (inStandZone(tx, tz)) continue;
            buildTree(tx, tz, 3.5 + Math.random() * 3, 0.8 + Math.random() * 0.5);
        }
        // Innenseite: lockere Bäume zufällig über das Innenfeld verteilt
        const innerMaxX = TRACK_A - 12;  // bleibt innerhalb der Innenbahn
        const innerMaxZ = TRACK_B - 8;
        const placedInner = [];
        const TREE_MIN_DIST = 7; // Mindestabstand zwischen Bäumen
        let innerCount = 0, attempts = 0;
        while (innerCount < 25 && attempts < 600) {
            attempts++;
            const tx = (Math.random() * 2 - 1) * innerMaxX;
            const tz = (Math.random() * 2 - 1) * innerMaxZ;
            // Muss im Innenfeld liegen (Ellipse der Innenbahn)
            if ((tx * tx) / (innerMaxX * innerMaxX) + (tz * tz) / (innerMaxZ * innerMaxZ) > 0.92) continue;
            if (inLakeZone(tx, tz)) continue;
            // Kein anderer Baum zu nah
            if (placedInner.some(([px, pz]) => (tx-px)**2 + (tz-pz)**2 < TREE_MIN_DIST**2)) continue;
            placedInner.push([tx, tz]);
            buildTree(tx, tz, 2.5 + Math.random() * 2, 0.7 + Math.random() * 0.4);
            innerCount++;
        }
    }

    function buildStands() {
        const ROWS = 4, COLS = 16;
        const COL_SPACING = 2.8;
        const spectatorColors = [
            new BABYLON.Color3(1,0.2,0.2), new BABYLON.Color3(0.2,0.6,1),
            new BABYLON.Color3(1,0.85,0.2), new BABYLON.Color3(0.8,0.2,0.8),
            new BABYLON.Color3(1,0.55,0.1), new BABYLON.Color3(0.2,0.9,0.4),
        ];

        // Tribüne auf der Außenseite der linken Kurve – weit genug weg von der Strecke
        // Äußere Streckenkante links: x ≈ -(TRACK_A + 5.5) = -60.5
        // Reihe 0 startet bei x = -70 (9.5 Einheiten Sicherheitsabstand)
        const ROW0_X    = -(TRACK_A + 15);   // -70
        const ROW_STEP  = 3.2;               // Abstand pro Reihe (weg von Strecke)
        const ROW_RISE  = 1.6;               // Höhe pro Reihe
        const totalZ    = COL_SPACING * (COLS - 1);

        for (let row = 0; row < ROWS; row++) {
            const x        = ROW0_X - row * ROW_STEP;
            const stepY    = row * ROW_RISE;           // Oberkante der Stufe
            const platH    = stepY + 0.25;             // Plattform von Boden bis Stufenoberkante

            // Betonplattform (geht vom Boden bis zur Stufenhöhe)
            const plat = BABYLON.MeshBuilder.CreateBox(`plat${row}`, {
                width: ROW_STEP + 0.2, height: platH, depth: totalZ + COL_SPACING
            }, scene);
            plat.position     = new BABYLON.Vector3(x, platH / 2, 0);
            plat.material     = mat(scene, new BABYLON.Color3(0.48, 0.48, 0.52));
            plat.receiveShadows = true;

            for (let col = 0; col < COLS; col++) {
                const z       = -totalZ / 2 + col * COL_SPACING;
                const surface = platH;   // Y-Koordinate der Stufenoberfläche

                // Sitzfläche
                const seat = BABYLON.MeshBuilder.CreateBox(`st${row}_${col}`, {
                    width: 0.9, height: 0.18, depth: 0.72
                }, scene);
                seat.position     = new BABYLON.Vector3(x, surface + 0.09, z);
                seat.material     = mat(scene, new BABYLON.Color3(0.2, 0.25, 0.75));
                seat.receiveShadows = true;

                // Zuschauer
                if (Math.random() > 0.1) {
                    const bodyH = 0.82, headR = 0.19;
                    const bodyBottom = surface + 0.18;   // steht auf der Sitzfläche
                    const bY = bodyBottom + bodyH / 2;

                    const body = BABYLON.MeshBuilder.CreateBox(`sp${row}_${col}`, {
                        width: 0.52, height: bodyH, depth: 0.4
                    }, scene);
                    body.position     = new BABYLON.Vector3(x, bY, z);
                    body.material     = mat(scene, spectatorColors[Math.floor(Math.random() * spectatorColors.length)]);
                    body.receiveShadows = true;
                    _spectators.push({ body, baseY: bY, z });

                    const head = BABYLON.MeshBuilder.CreateSphere(`hd${row}_${col}`, {
                        diameter: headR * 2, segments: 4
                    }, scene);
                    head.position     = new BABYLON.Vector3(x, bodyBottom + bodyH + headR + 0.04, z);
                    head.material     = mat(scene, new BABYLON.Color3(0.87, 0.67, 0.5));
                    head.receiveShadows = true;
                }
            }
        }
    }

    // ── Zweite Tribüne (rechts / positives X) ─────────────────────────────────
    function buildStandsRight() {
        const ROWS = 3, COLS = 12, COL_SPACING = 2.8;
        const spectColors = [
            new BABYLON.Color3(1,0.2,0.2),   new BABYLON.Color3(0.2,0.6,1),
            new BABYLON.Color3(1,0.85,0.2),  new BABYLON.Color3(0.8,0.2,0.8),
            new BABYLON.Color3(1,0.55,0.1),  new BABYLON.Color3(0.2,0.9,0.4),
        ];
        const ROW0_X   = TRACK_A + 15;
        const ROW_STEP = 3.2, ROW_RISE = 1.6;
        const totalZ   = COL_SPACING * (COLS - 1);

        for (let row = 0; row < ROWS; row++) {
            const x      = ROW0_X + row * ROW_STEP;
            const stepY  = row * ROW_RISE;
            const platH  = stepY + 0.25;

            const plat = BABYLON.MeshBuilder.CreateBox(`platr${row}`, {
                width: ROW_STEP + 0.2, height: platH, depth: totalZ + COL_SPACING
            }, scene);
            plat.position = new BABYLON.Vector3(x, platH / 2, 0);
            plat.material = mat(scene, new BABYLON.Color3(0.48, 0.48, 0.52));
            plat.receiveShadows = true;

            for (let col = 0; col < COLS; col++) {
                const z = -totalZ / 2 + col * COL_SPACING;
                const seat = BABYLON.MeshBuilder.CreateBox(`str${row}_${col}`,
                    { width: 0.9, height: 0.18, depth: 0.72 }, scene);
                seat.position = new BABYLON.Vector3(x, platH + 0.09, z);
                seat.material = mat(scene, new BABYLON.Color3(0.72, 0.18, 0.18));
                seat.receiveShadows = true;

                if (Math.random() > 0.12) {
                    const bH = 0.82, hR = 0.19;
                    const bBot = platH + 0.18;
                    const bY2 = bBot + bH / 2;
                    const body = BABYLON.MeshBuilder.CreateBox(`spr${row}_${col}`,
                        { width: 0.52, height: bH, depth: 0.4 }, scene);
                    body.position = new BABYLON.Vector3(x, bY2, z);
                    body.material = mat(scene, spectColors[Math.floor(Math.random() * spectColors.length)]);
                    body.receiveShadows = true;
                    _spectators.push({ body, baseY: bY2, z });

                    const head = BABYLON.MeshBuilder.CreateSphere(`hdr${row}_${col}`,
                        { diameter: hR * 2, segments: 4 }, scene);
                    head.position = new BABYLON.Vector3(x, bBot + bH + hR + 0.04, z);
                    head.material = mat(scene, new BABYLON.Color3(0.87, 0.67, 0.5));
                }
            }
        }
    }

    // ── Rot-weiße Absperrbanden (Innenlinie) ───────────────────────────────────
    function buildBarriers() {
        const redMat   = mat(scene, new BABYLON.Color3(0.9, 0.1, 0.08));
        const whiteMat = mat(scene, new BABYLON.Color3(1, 1, 1));
        const count    = 32;
        for (let i = 0; i < count; i++) {
            const progress = (i / count) * TRACK_LENGTH + 4;
            const pos = trackPosition(progress, -(TW / 2 + 1.2));
            const nxt = trackPosition(progress + 6, -(TW / 2 + 1.2));
            const board = BABYLON.MeshBuilder.CreateBox('br_' + i,
                { width: 0.22, height: 1.1, depth: 3.0 }, scene);
            board.position = new BABYLON.Vector3(pos.x, 0.65, pos.z);
            board.lookAt(new BABYLON.Vector3(nxt.x, 0.65, nxt.z));
            board.material = i % 2 === 0 ? redMat : whiteMat;
            board.receiveShadows = true;
        }
    }

    // ── Bunte Fahnen rund um die Außenbahn ─────────────────────────────────────
    function buildFlags() {
        const colors = [
            [1, 0.12, 0.12], [1, 0.88, 0.05], [0.18, 0.5, 1.0],
            [0.12, 0.85, 0.28], [1, 0.42, 0.0], [0.85, 0.12, 0.85],
        ];
        const poleMat = mat(scene, new BABYLON.Color3(0.82, 0.82, 0.82));
        const count   = 22;
        for (let i = 0; i < count; i++) {
            const t  = (i / count) * Math.PI * 2;
            const ox = Math.cos(t) * (TRACK_A + TW / 2 + 4.5);
            const oz = Math.sin(t) * (TRACK_B + TW / 2 + 4.5);

            const poleH = 6.5;
            const pole  = BABYLON.MeshBuilder.CreateCylinder('fp_' + i,
                { height: poleH, diameter: 0.16, tessellation: 6 }, scene);
            pole.position = new BABYLON.Vector3(ox, poleH / 2, oz);
            pole.material = poleMat;

            const rgb  = colors[i % colors.length];
            const flag = BABYLON.MeshBuilder.CreateBox('ff_' + i,
                { width: 2.0, height: 0.88, depth: 0.07 }, scene);
            flag.position = new BABYLON.Vector3(ox + 1.0, poleH - 0.44, oz);
            const fm = new BABYLON.StandardMaterial('ffm_' + i, scene);
            fm.diffuseColor    = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
            fm.emissiveColor   = new BABYLON.Color3(rgb[0] * 0.3, rgb[1] * 0.3, rgb[2] * 0.3);
            fm.backFaceCulling = false;
            flag.material = fm;
            flag._phase   = i * 0.71;
            _flagMeshes.push(flag);
        }
    }

    // ── Flutlichtmasten an den vier Kurvenecken ────────────────────────────────
    function buildFloodlights() {
        const poleH  = 17;
        const spots  = [
            [ TRACK_A + TW/2 + 7,  TRACK_B * 0.65],
            [ TRACK_A + TW/2 + 7, -TRACK_B * 0.65],
            [-(TRACK_A + TW/2 + 7),  TRACK_B * 0.65],
            [-(TRACK_A + TW/2 + 7), -TRACK_B * 0.65],
        ];
        const poleMat = mat(scene, new BABYLON.Color3(0.55, 0.55, 0.6));
        const lampMat = new BABYLON.StandardMaterial('lmpm', scene);
        lampMat.diffuseColor  = new BABYLON.Color3(0.95, 0.95, 0.8);
        lampMat.emissiveColor = new BABYLON.Color3(0.6, 0.6, 0.42);

        for (const [x, z] of spots) {
            const pole = BABYLON.MeshBuilder.CreateCylinder('lp_'+x,
                { height: poleH, diameter: 0.45, tessellation: 8 }, scene);
            pole.position = new BABYLON.Vector3(x, poleH / 2, z);
            pole.material = poleMat;
            if (_shadowGen) _shadowGen.addShadowCaster(pole);

            // 3 Scheinwerfer nebeneinander am Mastenkopf
            for (let j = 0; j < 3; j++) {
                const head = BABYLON.MeshBuilder.CreateBox('lh_'+x+'_'+j,
                    { width: 1.1, height: 0.42, depth: 0.85 }, scene);
                head.position = new BABYLON.Vector3(x + (j - 1) * 1.3, poleH + 0.2, z);
                head.material = lampMat;
            }
        }
    }

    // ── Hilfsfunktion: Mesh als Environment registrieren (für späteres Dispose) ─
    function _envMesh(mesh) { _envMeshes.push(mesh); return mesh; }

    // ── Arktis-Umgebung (Frozen Circuit) ─────────────────────────────────────
    function buildArcticEnvironment() {
        if (!_arcticLUT) _arcticLUT = _buildSplineLUT(ARCTIC_PTS, 512);
        const iceMat = (r, g, b) => {
            const m = new BABYLON.StandardMaterial('im' + Math.random(), scene);
            m.diffuseColor  = new BABYLON.Color3(r, g, b);
            m.specularColor = new BABYLON.Color3(0.6, 0.7, 0.8);
            m.specularPower = 32;
            return _envMesh(m);
        };
        const snowMat = () => iceMat(0.88, 0.93, 0.98);
        const darkIce = () => iceMat(0.40, 0.60, 0.80);

        // Schnee-Boden
        const ground = _envMesh(BABYLON.MeshBuilder.CreateGround('ground',
            { width: 420, height: 260 }, scene));
        ground.material = snowMat();
        ground.receiveShadows = true;

        // Strecken-Ribbon entlang des Spline-Pfades (256 Segmente)
        const SAMPLES = 256;
        const inner = [], outer = [];
        for (let i = 0; i <= SAMPLES; i++) {
            const prog = (i / SAMPLES) * TRACK_LENGTH;
            const pi = _splinePos(_arcticLUT, prog, -(TW/2));
            const po = _splinePos(_arcticLUT, prog,  (TW/2));
            inner.push(new BABYLON.Vector3(pi.x, 0.06, pi.z));
            outer.push(new BABYLON.Vector3(po.x, 0.06, po.z));
        }
        const ribbon = _envMesh(BABYLON.MeshBuilder.CreateRibbon('track',
            { pathArray: [inner, outer], closePath: true }, scene));
        const trackMat = new BABYLON.StandardMaterial('iceTrack', scene);
        trackMat.diffuseColor    = new BABYLON.Color3(0.62, 0.82, 0.95);
        trackMat.specularColor   = new BABYLON.Color3(0.5, 0.65, 0.80);
        trackMat.specularPower   = 48;
        trackMat.backFaceCulling = false;
        ribbon.material = _envMesh(trackMat);
        ribbon.receiveShadows = true;

        // Begrenzungslinien (weiß)
        for (const path of [inner, outer]) {
            const b = _envMesh(BABYLON.MeshBuilder.CreateTube('border',
                { path, radius: 0.2, tessellation: 6 }, scene));
            b.material = snowMat();
        }

        // Spurtrennlinien (hellblau)
        for (const offset of [-1.75, 1.75]) {
            const path = [];
            for (let i = 0; i <= SAMPLES; i++) {
                const p = _splinePos(_arcticLUT, (i / SAMPLES) * TRACK_LENGTH, offset);
                path.push(new BABYLON.Vector3(p.x, 0.08, p.z));
            }
            const t = _envMesh(BABYLON.MeshBuilder.CreateTube('lane',
                { path, radius: 0.12, tessellation: 4 }, scene));
            t.material = _envMesh(iceMat(0.80, 0.92, 1.0));
        }

        // Eisblock-Absperrungen entlang der Innenbahn
        const iceBlockMat = _envMesh(iceMat(0.55, 0.78, 0.95));
        const wallCount = 40;
        for (let i = 0; i < wallCount; i++) {
            const progress = (i / wallCount) * TRACK_LENGTH + 2;
            const pos = _splinePos(_arcticLUT, progress, -(TW/2 + 1.2));
            const nxt = _splinePos(_arcticLUT, progress + 5, -(TW/2 + 1.2));
            const block = _envMesh(BABYLON.MeshBuilder.CreateBox('ib_' + i,
                { width: 0.28, height: 0.75, depth: 2.6 }, scene));
            block.position = new BABYLON.Vector3(pos.x, 0.37, pos.z);
            block.lookAt(new BABYLON.Vector3(nxt.x, 0.37, nxt.z));
            block.material = iceBlockMat;
            block.receiveShadows = true;
        }

        // ── Zugefrorener See im Innenfeld ─────────────────────────────────────
        const LAKE_CX = 4, LAKE_CZ = -4;
        const LAKE_RX = 22, LAKE_RZ = 13;

        // Eis-Oberfläche
        const lakeM = new BABYLON.StandardMaterial('lakeM', scene);
        lakeM.diffuseColor  = new BABYLON.Color3(0.50, 0.74, 0.92);
        lakeM.specularColor = new BABYLON.Color3(0.85, 0.93, 1.00);
        lakeM.specularPower = 90;
        _envMesh(lakeM);
        const lakeDisc = _envMesh(BABYLON.MeshBuilder.CreateCylinder('lake',
            { diameter: LAKE_RX * 2, height: 0.12, tessellation: 40 }, scene));
        lakeDisc.scaling.z = LAKE_RZ / LAKE_RX;
        lakeDisc.position  = new BABYLON.Vector3(LAKE_CX, 0.06, LAKE_CZ);
        lakeDisc.material  = lakeM;
        lakeDisc.receiveShadows = true;

        // Schneerand (kleine Blöcke rund um den See)
        const rimM = _envMesh(iceMat(0.88, 0.93, 0.98));
        for (let i = 0; i < 36; i++) {
            const a  = (i / 36) * Math.PI * 2;
            const rx = LAKE_RX + 1.0, rz = LAKE_RZ + 1.0;
            const rim = _envMesh(BABYLON.MeshBuilder.CreateBox('rim_' + i,
                { width: 1.1, height: 0.28, depth: 1.1 }, scene));
            rim.position = new BABYLON.Vector3(
                LAKE_CX + Math.cos(a) * rx, 0.14, LAKE_CZ + Math.sin(a) * rz);
            rim.material = rimM;
        }

        // Eisspalten (dunkle dünne Kästen auf der Oberfläche)
        const crackM = _envMesh(iceMat(0.28, 0.48, 0.72));
        [[0, 0, 16, 1.2], [-6, 3, 11, 0.9], [7, -5, 13, 1.0]].forEach(([cx, cz, len, ang], i) => {
            const crack = _envMesh(BABYLON.MeshBuilder.CreateBox('crack_' + i,
                { width: 0.07, height: 0.13, depth: len }, scene));
            crack.position  = new BABYLON.Vector3(LAKE_CX + cx, 0.13, LAKE_CZ + cz);
            crack.rotation.y = ang;
            crack.material  = crackM;
        });

        // ── Figuren auf dem See ────────────────────────────────────────────────
        function buildSkater(sx, sz, jacketR, jacketG, jacketB) {
            const skinM   = _envMesh(iceMat(0.90, 0.72, 0.56));
            const jacketM = _envMesh(iceMat(jacketR, jacketG, jacketB));
            const pantM   = _envMesh(iceMat(0.12, 0.12, 0.20));
            // Beine (leicht gespreizt)
            [-0.14, 0.14].forEach((lx, i) => {
                const leg = _envMesh(BABYLON.MeshBuilder.CreateCylinder('sleg'+i+'_'+sx,
                    { diameter: 0.16, height: 0.65, tessellation: 5 }, scene));
                leg.position  = new BABYLON.Vector3(sx + lx, 0.43, sz);
                leg.rotation.z = lx * 0.35;
                leg.material  = pantM;
            });
            // Körper
            const body = _envMesh(BABYLON.MeshBuilder.CreateBox('sbdy_'+sx,
                { width: 0.44, height: 0.58, depth: 0.30 }, scene));
            body.position = new BABYLON.Vector3(sx, 1.07, sz);
            body.material = jacketM;
            // Arme ausgestreckt
            [-0.42, 0.42].forEach((ax, i) => {
                const arm = _envMesh(BABYLON.MeshBuilder.CreateBox('sarm'+i+'_'+sx,
                    { width: 0.40, height: 0.13, depth: 0.13 }, scene));
                arm.position = new BABYLON.Vector3(sx + ax, 1.10, sz);
                arm.material = jacketM;
            });
            // Kopf
            const head = _envMesh(BABYLON.MeshBuilder.CreateSphere('shd_'+sx,
                { diameter: 0.30, segments: 5 }, scene));
            head.position = new BABYLON.Vector3(sx, 1.53, sz);
            head.material = skinM;
            // Mütze
            const hat = _envMesh(BABYLON.MeshBuilder.CreateCylinder('shat_'+sx,
                { diameter: 0.28, height: 0.22, tessellation: 10 }, scene));
            hat.position = new BABYLON.Vector3(sx, 1.72, sz);
            hat.material = jacketM;
        }

        function buildFisherman(fx, fz, rotY = 0) {
            const root   = new BABYLON.TransformNode('fish_'+fx+fz, scene);
            root.position = new BABYLON.Vector3(fx, 0, fz);
            root.rotation.y = rotY;

            const skinM  = _envMesh(iceMat(0.90, 0.72, 0.56));
            const coatM  = _envMesh(iceMat(0.16, 0.20, 0.34));
            const pantM  = _envMesh(iceMat(0.20, 0.20, 0.28));
            const woodM  = _envMesh(iceMat(0.40, 0.26, 0.12));
            const hatM   = _envMesh(iceMat(0.72, 0.12, 0.10));  // rote Wintermütze

            // Hocker mit 4 Beinen
            const seat = _envMesh(BABYLON.MeshBuilder.CreateBox('fseat_'+fx,
                { width: 0.54, height: 0.08, depth: 0.54 }, scene));
            seat.position = new BABYLON.Vector3(0, 0.36, 0); seat.material = woodM; seat.parent = root;
            [[-0.20,-0.20],[0.20,-0.20],[-0.20,0.20],[0.20,0.20]].forEach(([lx,lz],i) => {
                const leg = _envMesh(BABYLON.MeshBuilder.CreateCylinder('fsl'+i+'_'+fx,
                    { diameter: 0.07, height: 0.36, tessellation: 4 }, scene));
                leg.position = new BABYLON.Vector3(lx, 0.18, lz); leg.material = woodM; leg.parent = root;
            });

            // Oberschenkel (waagrecht nach vorne)
            [-0.13, 0.13].forEach((lx, i) => {
                const thigh = _envMesh(BABYLON.MeshBuilder.CreateBox('fth'+i+'_'+fx,
                    { width: 0.15, height: 0.14, depth: 0.52 }, scene));
                thigh.position = new BABYLON.Vector3(lx, 0.40, 0.26); thigh.material = pantM; thigh.parent = root;
                // Unterschenkel hängend
                const shin = _envMesh(BABYLON.MeshBuilder.CreateCylinder('fsh'+i+'_'+fx,
                    { diameter: 0.13, height: 0.52, tessellation: 5 }, scene));
                shin.position = new BABYLON.Vector3(lx, 0.09, 0.50); shin.material = pantM; shin.parent = root;
            });

            // Körper + Schultern
            const body = _envMesh(BABYLON.MeshBuilder.CreateBox('fbdy_'+fx,
                { width: 0.44, height: 0.56, depth: 0.30 }, scene));
            body.position = new BABYLON.Vector3(0, 0.72, 0.04); body.rotation.x = 0.32;
            body.material = coatM; body.parent = root;
            const shl = _envMesh(BABYLON.MeshBuilder.CreateBox('fshl_'+fx,
                { width: 0.60, height: 0.16, depth: 0.26 }, scene));
            shl.position = new BABYLON.Vector3(0, 1.01, 0.00); shl.material = coatM; shl.parent = root;

            // Arme (nach vorne geneigt zur Rute)
            [-0.24, 0.24].forEach((ax, i) => {
                const arm = _envMesh(BABYLON.MeshBuilder.CreateBox('farm'+i+'_'+fx,
                    { width: 0.14, height: 0.42, depth: 0.14 }, scene));
                arm.position = new BABYLON.Vector3(ax, 0.84, 0.16); arm.rotation.x = 0.55;
                arm.material = coatM; arm.parent = root;
            });

            // Kopf
            const head = _envMesh(BABYLON.MeshBuilder.CreateSphere('fhd_'+fx,
                { diameter: 0.29, segments: 6 }, scene));
            head.position = new BABYLON.Vector3(0, 1.22, -0.04); head.material = skinM; head.parent = root;

            // Wintermütze (Krempe + Körper + Pompom)
            const hbrim = _envMesh(BABYLON.MeshBuilder.CreateCylinder('fhbr_'+fx,
                { diameter: 0.34, height: 0.07, tessellation: 12 }, scene));
            hbrim.position = new BABYLON.Vector3(0, 1.35, -0.04); hbrim.material = hatM; hbrim.parent = root;
            const hbody = _envMesh(BABYLON.MeshBuilder.CreateCylinder('fhbd_'+fx,
                { diameterBottom: 0.31, diameterTop: 0.24, height: 0.24, tessellation: 12 }, scene));
            hbody.position = new BABYLON.Vector3(0, 1.49, -0.04); hbody.material = hatM; hbody.parent = root;
            const pompom = _envMesh(BABYLON.MeshBuilder.CreateSphere('fpom_'+fx,
                { diameter: 0.11, segments: 4 }, scene));
            pompom.position = new BABYLON.Vector3(0, 1.63, -0.04);
            pompom.material = _envMesh(iceMat(0.95, 0.95, 0.95)); pompom.parent = root;

            // Angelrute (nach vorne/unten zum Loch)
            const rod = _envMesh(BABYLON.MeshBuilder.CreateCylinder('frod_'+fx,
                { diameter: 0.045, height: 1.6, tessellation: 4 }, scene));
            rod.position = new BABYLON.Vector3(0.20, 0.92, 0.18); rod.rotation.x = -0.60;
            rod.material = woodM; rod.parent = root;

            // Angel-Loch
            const hole = _envMesh(BABYLON.MeshBuilder.CreateCylinder('fhole_'+fx,
                { diameter: 0.34, height: 0.15, tessellation: 16 }, scene));
            hole.position = new BABYLON.Vector3(0.22, 0.07, 0.70);
            hole.material = _envMesh(iceMat(0.10, 0.22, 0.48)); hole.parent = root;

            // Kleiner roter Eimer
            const bucket = _envMesh(BABYLON.MeshBuilder.CreateCylinder('fbkt_'+fx,
                { diameterTop: 0.24, diameterBottom: 0.18, height: 0.26, tessellation: 10 }, scene));
            bucket.position = new BABYLON.Vector3(-0.44, 0.13, 0.18);
            bucket.material = _envMesh(iceMat(0.72, 0.14, 0.10)); bucket.parent = root;
        }

        // 3 Eisläufer (verschiedene Farben), 2 Angler
        buildSkater(LAKE_CX,      LAKE_CZ,      0.82, 0.15, 0.18); // rote Jacke
        buildSkater(LAKE_CX - 8,  LAKE_CZ + 5,  0.15, 0.25, 0.72); // blaue Jacke
        buildSkater(LAKE_CX + 7,  LAKE_CZ - 4,  0.15, 0.58, 0.22); // grüne Jacke
        buildFisherman(LAKE_CX - 3,  LAKE_CZ - 9,  0.3);
        buildFisherman(LAKE_CX + 10, LAKE_CZ + 4, -1.1);

        // Eissäulen außerhalb der Strecke — positioniert mit LUT-Normalen
        function buildIceSpire(x, z, h) {
            const base = _envMesh(BABYLON.MeshBuilder.CreateCylinder('ispB_' + Math.random(),
                { diameterTop: 0.3, diameterBottom: 1.4 + h*0.04, height: h*0.55, tessellation: 6 }, scene));
            base.position = new BABYLON.Vector3(x, h*0.275, z);
            base.material = darkIce();
            const top = _envMesh(BABYLON.MeshBuilder.CreateCylinder('ispT_' + Math.random(),
                { diameterTop: 0, diameterBottom: 0.8, height: h*0.65, tessellation: 6 }, scene));
            top.position = new BABYLON.Vector3(x, h*0.55 + h*0.325, z);
            top.material = _envMesh(iceMat(0.65, 0.85, 0.98));
            if (_shadowGen) { _shadowGen.addShadowCaster(base); _shadowGen.addShadowCaster(top); }
        }

        // ── Schneetannen ──────────────────────────────────────────────────────
        function buildSnowTree(x, z, h) {
            const trunkMat  = _envMesh(iceMat(0.68, 0.74, 0.82));  // hellgrauer Eisstamm
            const coneMat   = () => {
                const v = Math.random() * 0.12;
                return _envMesh(iceMat(0.38 + v, 0.58 + v, 0.80 + v * 0.5)); // mittleres Eisblau
            };

            // Zufällig: lange Kiefer oder kurze Tanne
            const longTrunk = Math.random() > 0.5;
            const trunkH    = longTrunk ? h * 0.42 : h * 0.13;
            const trunkD    = 0.20 + h * 0.016;
            const trunk = _envMesh(BABYLON.MeshBuilder.CreateCylinder('stt_' + Math.random(),
                { diameter: trunkD, height: trunkH, tessellation: 7 }, scene));
            trunk.position = new BABYLON.Vector3(x, trunkH / 2, z);
            trunk.material = trunkMat;
            if (_shadowGen) _shadowGen.addShadowCaster(trunk);

            // 3 Etagen (Kiefer) oder 4 Etagen (Tanne) – alles weiß
            const numL = longTrunk ? 3 : 4;
            const step = (h - trunkH) / numL;

            for (let i = 0; i < numL; i++) {
                const t        = i / (numL - 1);
                const layerBot = h * (0.56 - t * 0.36);
                const layerH   = step * 1.15;
                const layerY   = trunkH + i * step + layerH * 0.40;
                const cone = _envMesh(BABYLON.MeshBuilder.CreateCylinder('stc_' + Math.random(),
                    { diameterBottom: layerBot, diameterTop: 0, height: layerH, tessellation: 8 }, scene));
                cone.position = new BABYLON.Vector3(x, layerY, z);
                cone.material = coneMat();
                if (_shadowGen) _shadowGen.addShadowCaster(cone);
            }
        }

        // Schneetannen: Abstand-Check + See-Ausschlusszone
        const _treePos  = [];
        const MIN_TREE_GAP = 7.5;
        for (let i = 0; i < 36; i++) {
            const prog   = (i / 36) * TRACK_LENGTH + 3;
            const inside = i % 2 === 0;
            const offset = inside
                ? -(TW/2 + 9  + Math.random() * 10)
                :  (TW/2 + 9  + Math.random() * 12);
            const tp = _splinePos(_arcticLUT, prog, offset);
            // Nicht auf dem See oder in dessen Nähe platzieren
            const dLx = (tp.x - LAKE_CX) / (LAKE_RX + 6);
            const dLz = (tp.z - LAKE_CZ) / (LAKE_RZ + 6);
            if (dLx * dLx + dLz * dLz < 1.0) continue;
            // Nicht zu nah an anderen Bäumen
            const tooClose = _treePos.some(p => {
                const dx = p[0] - tp.x, dz = p[1] - tp.z;
                return dx*dx + dz*dz < MIN_TREE_GAP * MIN_TREE_GAP;
            });
            if (tooClose) continue;
            _treePos.push([tp.x, tp.z]);
            buildSnowTree(tp.x, tp.z, 4 + Math.random() * 5);
        }

        // (Eissäulen entfernt – durch Schneetannen ersetzt)

        // Ziellinie entlang der Spline-Normalen bei progress=0
        {
            const fp   = _splinePos(_arcticLUT, 0, 0);
            const fnxt = _splinePos(_arcticLUT, 4, 0);
            const fnx  = _splinePos(_arcticLUT, 0, -TW/2 - 0.5);
            const dir  = new BABYLON.Vector3(fnxt.x - fp.x, 0, fnxt.z - fp.z).normalize();
            for (let i = 0; i < 5; i++) {
                const lo = (i - 2) * 2.4;
                const tp = _splinePos(_arcticLUT, 0, lo);
                const tile = _envMesh(BABYLON.MeshBuilder.CreateBox('ft'+i,
                    { width: 0.8, height: 0.18, depth: 2.2 }, scene));
                tile.position = new BABYLON.Vector3(tp.x, 0.18, tp.z);
                tile.lookAt(new BABYLON.Vector3(tp.x + dir.x, 0.18, tp.z + dir.z));
                const tm = new BABYLON.StandardMaterial('ftm'+i, scene);
                tm.diffuseColor  = i%2===0 ? new BABYLON.Color3(0.85,0.95,1.0) : new BABYLON.Color3(0.3,0.55,0.75);
                tm.emissiveColor = i%2===0 ? new BABYLON.Color3(0.25,0.35,0.45) : new BABYLON.Color3(0.08,0.18,0.28);
                tile.material = _envMesh(tm);
            }
        }

        // Zieltor — Eis-Pfosten bei progress=0
        const gateH  = 9;
        const _gp1   = _splinePos(_arcticLUT, 0, -(TW/2 + 1.5));
        const _gp2   = _splinePos(_arcticLUT, 0,  (TW/2 + 1.5));
        const gateX1 = _gp1.x, gateZ1 = _gp1.z;
        const gateX2 = _gp2.x, gateZ2 = _gp2.z;
        const gateMat = () => {
            const m = new BABYLON.StandardMaterial('igm_' + Math.random(), scene);
            m.diffuseColor  = new BABYLON.Color3(0.55, 0.82, 1.0);
            m.emissiveColor = new BABYLON.Color3(0.12, 0.28, 0.45);
            m.specularColor = new BABYLON.Color3(0.8, 0.9, 1.0);
            m.specularPower = 64;
            return _envMesh(m);
        };
        const gateBeamLen = Math.sqrt((gateX2-gateX1)**2+(gateZ2-gateZ1)**2) + 0.4;
        for (const [gx, gz] of [[gateX1, gateZ1], [gateX2, gateZ2]]) {
            const pole = _envMesh(BABYLON.MeshBuilder.CreateCylinder('igp_' + gx,
                { height: gateH, diameter: 0.4, tessellation: 8 }, scene));
            pole.position = new BABYLON.Vector3(gx, gateH / 2, gz);
            pole.material = gateMat();
        }
        const gateMidX = (gateX1 + gateX2) / 2, gateMidZ = (gateZ1 + gateZ2) / 2;
        const beam = _envMesh(BABYLON.MeshBuilder.CreateBox('igbeam',
            { width: 0.45, height: 0.45, depth: gateBeamLen }, scene));
        beam.position = new BABYLON.Vector3(gateMidX, gateH, gateMidZ);
        const beamDir = new BABYLON.Vector3(gateX2 - gateX1, 0, gateZ2 - gateZ1);
        beam.lookAt(beam.position.add(beamDir));
        beam.material = gateMat();

        // FINISH-Banner (blau-weiß für Arktis)
        const bannerPlane = _envMesh(BABYLON.MeshBuilder.CreatePlane('banner',
            { width: 9.0, height: 1.5 }, scene));
        bannerPlane.position = new BABYLON.Vector3(gateMidX, gateH + 1.6, gateMidZ);
        bannerPlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE;
        // Banner parallel zum Balken ausrichten:
        // lookAt mit dem Vektor senkrecht zu beamDir → Banneroberfläche liegt parallel zum Balken
        const perpDir = new BABYLON.Vector3(-beamDir.z, 0, beamDir.x);
        bannerPlane.lookAt(bannerPlane.position.add(perpDir));
        const banTex = new BABYLON.DynamicTexture('bantex', { width: 512, height: 80 }, scene, false);
        const bCtx   = banTex.getContext();
        bCtx.fillStyle = 'rgba(12, 28, 55, 0.90)';
        bCtx.fillRect(0, 0, 512, 80);
        const checkSize = 20;
        for (let ci = 0; ci < 4; ci++) {
            bCtx.fillStyle = ci % 2 === 0 ? '#cce8ff' : '#2266aa';
            bCtx.fillRect(ci * checkSize, 0, checkSize, 80);
            bCtx.fillStyle = ci % 2 === 0 ? '#2266aa' : '#cce8ff';
            bCtx.fillRect(512 - (ci + 1) * checkSize, 0, checkSize, 80);
        }
        bCtx.font = 'bold 48px Arial, sans-serif';
        bCtx.textAlign = 'center'; bCtx.textBaseline = 'middle';
        bCtx.shadowColor = 'rgba(0,0,0,0.9)'; bCtx.shadowBlur = 8;
        bCtx.fillStyle = '#88ddff';
        bCtx.fillText('FINISH', 256, 42);
        banTex.update();
        const banMat = new BABYLON.StandardMaterial('banm', scene);
        banMat.diffuseTexture = banTex;
        banMat.emissiveTexture = banTex;
        banMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
        banMat.useAlphaFromDiffuseTexture = true;
        banMat.disableLighting = true;
        banMat.backFaceCulling = false;
        bannerPlane.material = _envMesh(banMat);
        _finishBanner = bannerPlane;
    }

    // ── Map wechseln: ALLE Szenen-Meshes außer Pferden + Himmel entfernen ────
    function setMap(mapId) {
        if (!scene || mapId === _currentMapId) return;
        _currentMapId = mapId;

        // Pferde-Meshes und Skydom merken → dürfen nicht disposed werden
        const keepIds = new Set();
        if (_skyDome) keepIds.add(_skyDome.uniqueId);
        for (const h of Object.values(horses)) {
            h.root.getChildMeshes().forEach(m => keepIds.add(m.uniqueId));
        }

        // ALLE anderen Meshes löschen (Boden, Strecke, Bäume, Tribünen, Tore …)
        for (const m of [...scene.meshes]) {
            if (!keepIds.has(m.uniqueId) && !m.isDisposed()) m.dispose();
        }

        // Partikel-Systeme der Umgebung stoppen
        if (_rainPs) { _rainPs.stop(); _rainPs.dispose(); _rainPs = null; }
        if (_snowPs) { _snowPs.stop(); _snowPs.dispose(); _snowPs = null; }

        // Tracking-Arrays zurücksetzen
        _envMeshes = [];
        _spectators.length = 0;
        _flagMeshes.length = 0;
        _finishBanner = null;

        // Spline-LUT setzen / zurücksetzen
        if (mapId === 'arctic') {
            _arcticLUT = _buildSplineLUT(ARCTIC_PTS, 512);
            TRACK_A = 0; TRACK_B = 0;
        } else {
            _arcticLUT = null;
            TRACK_A = 55; TRACK_B = 28;
        }

        // Neues Environment aufbauen
        if (mapId === 'arctic') {
            buildArcticEnvironment();
            setWeather('arctic');
        } else {
            _buildMeadowEnvironment();
            setWeather('sunny');
        }

        Minimap.setTrackConfig(mapId);
        console.log(`[Renderer] Map gewechselt → ${mapId}, ${scene.meshes.length} Meshes total`);
    }

    // ── Standard-Wiese-Environment (ausgelagert für Wiederverwendung) ─────────
    function _buildMeadowEnvironment() {
        // Boden
        const ground = _envMesh(BABYLON.MeshBuilder.CreateGround('ground',
            { width: 340, height: 220 }, scene));
        ground.material = _envMesh(mat(scene, new BABYLON.Color3(0.22, 0.55, 0.22)));
        ground.receiveShadows = true;

        // Strecken-Ribbon
        const inner = [], outer = [];
        for (let i = 0; i <= 128; i++) {
            const t = (i / 128) * Math.PI * 2;
            inner.push(new BABYLON.Vector3(Math.cos(t) * (TRACK_A - TW/2), 0.06, Math.sin(t) * (TRACK_B - TW/2)));
            outer.push(new BABYLON.Vector3(Math.cos(t) * (TRACK_A + TW/2), 0.06, Math.sin(t) * (TRACK_B + TW/2)));
        }
        const ribbon = _envMesh(BABYLON.MeshBuilder.CreateRibbon('track',
            { pathArray: [inner, outer], closePath: true }, scene));
        ribbon.material = _envMesh(mat(scene, new BABYLON.Color3(0.83, 0.73, 0.53)));
        ribbon.material.backFaceCulling = false;
        ribbon.receiveShadows = true;

        for (const path of [inner, outer]) {
            const b = _envMesh(BABYLON.MeshBuilder.CreateTube('border',
                { path, radius: 0.2, tessellation: 6 }, scene));
            b.material = _envMesh(mat(scene, new BABYLON.Color3(1, 1, 1)));
        }

        for (const offset of [-1.75, 1.75]) {
            const path = [];
            for (let i = 0; i <= 128; i++) {
                const p = trackPosition(i / 128 * TRACK_LENGTH, offset);
                path.push(new BABYLON.Vector3(p.x, 0.08, p.z));
            }
            const t = _envMesh(BABYLON.MeshBuilder.CreateTube('lane',
                { path, radius: 0.12, tessellation: 4 }, scene));
            t.material = _envMesh(mat(scene, new BABYLON.Color3(1, 0.95, 0.2)));
        }

        // ── See im Innenfeld ──────────────────────────────────────────────────
        const MLK_CX = 0, MLK_CZ = 0, MLK_RX = 28, MLK_RZ = 12;

        // Sandiges Ufer – glatte ovale Fläche (etwas größer als das Wasser)
        const sandM = _envMesh(mat(scene, new BABYLON.Color3(0.76, 0.64, 0.40)));
        const shoreDisc = _envMesh(BABYLON.MeshBuilder.CreateCylinder('mshore',
            { diameter: (MLK_RX + 4) * 2, height: 0.10, tessellation: 40 }, scene));
        shoreDisc.scaling.z = (MLK_RZ + 4) / (MLK_RX + 4);
        shoreDisc.position  = new BABYLON.Vector3(MLK_CX, 0.05, MLK_CZ);
        shoreDisc.material  = sandM;
        shoreDisc.receiveShadows = true;

        // Wasseroberfläche (liegt obendrauf, etwas kleiner → Sandrand sichtbar)
        const waterM = new BABYLON.StandardMaterial('waterM', scene);
        waterM.diffuseColor  = new BABYLON.Color3(0.08, 0.32, 0.78);
        waterM.emissiveColor = new BABYLON.Color3(0.03, 0.12, 0.28);  // verhindert Grünstich durch Umgebungslicht
        waterM.specularColor = new BABYLON.Color3(0.5, 0.75, 1.0);
        waterM.specularPower = 90;
        _envMesh(waterM);
        const waterDisc = _envMesh(BABYLON.MeshBuilder.CreateCylinder('mlake',
            { diameter: MLK_RX * 2, height: 0.10, tessellation: 40 }, scene));
        waterDisc.scaling.z = MLK_RZ / MLK_RX;
        waterDisc.position  = new BABYLON.Vector3(MLK_CX, 0.08, MLK_CZ);
        waterDisc.material  = waterM;
        waterDisc.receiveShadows = true;


        // ── Angler (Sommer-Outfit) ─────────────────────────────────────────
        function buildMeadowFisherman(fx, fz, rotY) {
            const root   = new BABYLON.TransformNode('mfish_'+fx+fz, scene);
            root.position = new BABYLON.Vector3(fx, 0, fz);
            root.rotation.y = rotY;
            const skinM  = _envMesh(mat(scene, new BABYLON.Color3(0.90, 0.72, 0.56)));
            const shirtM = _envMesh(mat(scene, new BABYLON.Color3(0.88, 0.88, 0.92)));
            const pantM  = _envMesh(mat(scene, new BABYLON.Color3(0.24, 0.36, 0.62)));
            const hatM   = _envMesh(mat(scene, new BABYLON.Color3(0.82, 0.68, 0.30)));
            const rodM   = _envMesh(mat(scene, new BABYLON.Color3(0.38, 0.22, 0.08)));
            // Beine (sitzend, nach vorne gestreckt)
            [-0.13, 0.13].forEach((lx, i) => {
                const thigh = _envMesh(BABYLON.MeshBuilder.CreateBox('mth'+i+fx,
                    { width: 0.15, height: 0.14, depth: 0.52 }, scene));
                thigh.position = new BABYLON.Vector3(lx, 0.20, 0.26); thigh.material = pantM; thigh.parent = root;
                const shin = _envMesh(BABYLON.MeshBuilder.CreateCylinder('msh'+i+fx,
                    { diameter: 0.13, height: 0.44, tessellation: 5 }, scene));
                shin.position = new BABYLON.Vector3(lx, 0.20, 0.50); shin.material = pantM; shin.parent = root;
            });
            // Körper
            const body = _envMesh(BABYLON.MeshBuilder.CreateBox('mbdy_'+fx,
                { width: 0.44, height: 0.54, depth: 0.28 }, scene));
            body.position = new BABYLON.Vector3(0, 0.54, 0.02); body.rotation.x = 0.28;
            body.material = shirtM; body.parent = root;
            const shl = _envMesh(BABYLON.MeshBuilder.CreateBox('mshl_'+fx,
                { width: 0.58, height: 0.15, depth: 0.26 }, scene));
            shl.position = new BABYLON.Vector3(0, 0.82, 0); shl.material = shirtM; shl.parent = root;
            // Kopf
            const head = _envMesh(BABYLON.MeshBuilder.CreateSphere('mhd_'+fx,
                { diameter: 0.29, segments: 6 }, scene));
            head.position = new BABYLON.Vector3(0, 1.02, -0.02); head.material = skinM; head.parent = root;
            // Strohhut (breit + flach)
            const brim = _envMesh(BABYLON.MeshBuilder.CreateCylinder('mhb_'+fx,
                { diameter: 0.58, height: 0.06, tessellation: 14 }, scene));
            brim.position = new BABYLON.Vector3(0, 1.16, -0.02); brim.material = hatM; brim.parent = root;
            const crown = _envMesh(BABYLON.MeshBuilder.CreateCylinder('mhc_'+fx,
                { diameterBottom: 0.30, diameterTop: 0.26, height: 0.18, tessellation: 12 }, scene));
            crown.position = new BABYLON.Vector3(0, 1.25, -0.02); crown.material = hatM; crown.parent = root;
            // Arme + Rute
            const arm = _envMesh(BABYLON.MeshBuilder.CreateBox('marm_'+fx,
                { width: 0.40, height: 0.12, depth: 0.12 }, scene));
            arm.position = new BABYLON.Vector3(0.22, 0.76, 0.14); arm.rotation.x = 0.5;
            arm.material = shirtM; arm.parent = root;
            const rod = _envMesh(BABYLON.MeshBuilder.CreateCylinder('mrod_'+fx,
                { diameter: 0.04, height: 1.8, tessellation: 4 }, scene));
            rod.position = new BABYLON.Vector3(0.24, 0.78, 0.22); rod.rotation.x = -0.52;
            rod.material = rodM; rod.parent = root;
            // Eimer
            const bkt = _envMesh(BABYLON.MeshBuilder.CreateCylinder('mbkt_'+fx,
                { diameterTop: 0.24, diameterBottom: 0.18, height: 0.26, tessellation: 10 }, scene));
            bkt.position = new BABYLON.Vector3(-0.40, 0.13, 0.15);
            bkt.material = _envMesh(mat(scene, new BABYLON.Color3(0.72, 0.14, 0.10))); bkt.parent = root;
        }

        // ── Schwimmer ─────────────────────────────────────────────────────
        function buildSwimmer(sx, sz, rotY, capR, capG, capB) {
            const root  = new BABYLON.TransformNode('swim_'+sx+sz, scene);
            root.position = new BABYLON.Vector3(sx, 0, sz);
            root.rotation.y = rotY;
            const skinM = _envMesh(mat(scene, new BABYLON.Color3(0.90, 0.72, 0.56)));
            const capM  = _envMesh(mat(scene, new BABYLON.Color3(capR, capG, capB)));
            // Kopf (knapp über Wasser)
            const head = _envMesh(BABYLON.MeshBuilder.CreateSphere('swh_'+sx+sz,
                { diameter: 0.32, segments: 6 }, scene));
            head.position = new BABYLON.Vector3(0, 0.22, 0); head.material = skinM; head.parent = root;
            // Badekappe
            const cap = _envMesh(BABYLON.MeshBuilder.CreateSphere('swc_'+sx+sz,
                { diameter: 0.30, segments: 5 }, scene));
            cap.scaling.y = 0.55; cap.position = new BABYLON.Vector3(0, 0.30, 0);
            cap.material = capM; cap.parent = root;
            // Arme (gestreckt, im Wasser)
            [-0.55, 0.55].forEach((ax, i) => {
                const arm = _envMesh(BABYLON.MeshBuilder.CreateBox('swa'+i+'_'+sx,
                    { width: 0.52, height: 0.10, depth: 0.14 }, scene));
                arm.position = new BABYLON.Vector3(ax, 0.08, 0.10);
                arm.rotation.z = (ax > 0 ? -0.35 : 0.35);
                arm.material = skinM; arm.parent = root;
            });
        }

        // Platzierung
        // Angler ans Ufer setzen (Punkt knapp außerhalb der See-Ellipse)
        // Ost-Ufer: angle ≈ 0.25 rad → x = (28+3)*cos(0.25)=30.1, z = (12+3)*sin(0.25)=3.7
        // Angler direkt am Wasserrand (1 Einheit Abstand vom Seerand)
        buildMeadowFisherman(MLK_CX + MLK_RX + 1, MLK_CZ, -Math.PI / 2); // Ost-Ufer → schaut nach Westen (−X)
        buildMeadowFisherman(MLK_CX - MLK_RX - 1, MLK_CZ,  Math.PI / 2); // West-Ufer → schaut nach Osten (+X)
        buildSwimmer(MLK_CX + 6,  MLK_CZ + 2,  0.4,  0.85, 0.12, 0.12); // rote Kappe
        buildSwimmer(MLK_CX - 8,  MLK_CZ - 3, -0.8,  0.12, 0.25, 0.82); // blaue Kappe
        buildSwimmer(MLK_CX + 2,  MLK_CZ - 5,  1.2,  0.15, 0.72, 0.22); // grüne Kappe

        // Ziellinie
        for (let i = 0; i < 4; i++) {
            const tile = _envMesh(BABYLON.MeshBuilder.CreateBox('ft' + i,
                { width: 2.5, height: 0.18, depth: 0.8 }, scene));
            tile.position = new BABYLON.Vector3(TRACK_A - 3.75 + i * 2.5, 0.18, 0);
            const tm = new BABYLON.StandardMaterial('ftm' + i, scene);
            if (i % 2 === 0) {
                tm.diffuseColor = new BABYLON.Color3(1, 1, 1);
                tm.emissiveColor = new BABYLON.Color3(0.45, 0.45, 0.0);
            } else {
                tm.diffuseColor = new BABYLON.Color3(0, 0, 0);
                tm.emissiveColor = new BABYLON.Color3(0.05, 0.05, 0.05);
            }
            tile.material = _envMesh(tm);
        }

        // Zieltor
        const gateH  = 9;
        const gateX1 = TRACK_A - TW / 2 - 1.5;
        const gateX2 = TRACK_A + TW / 2 + 1.5;
        const mGate = () => {
            const m = new BABYLON.StandardMaterial('gm_' + Math.random(), scene);
            m.diffuseColor  = new BABYLON.Color3(1, 0.85, 0);
            m.emissiveColor = new BABYLON.Color3(0.3, 0.25, 0);
            return _envMesh(m);
        };
        for (const gx of [gateX1, gateX2]) {
            const pole = _envMesh(BABYLON.MeshBuilder.CreateCylinder('gp_' + gx,
                { height: gateH, diameter: 0.4, tessellation: 8 }, scene));
            pole.position = new BABYLON.Vector3(gx, gateH / 2, 0);
            pole.material = mGate();
        }
        const beam = _envMesh(BABYLON.MeshBuilder.CreateBox('gbeam',
            { width: gateX2 - gateX1 + 0.4, height: 0.45, depth: 0.45 }, scene));
        beam.position = new BABYLON.Vector3(TRACK_A, gateH, 0);
        beam.material = mGate();

        // FINISH-Banner
        const bannerPlane = _envMesh(BABYLON.MeshBuilder.CreatePlane('banner',
            { width: 9.0, height: 1.5 }, scene));
        bannerPlane.position = new BABYLON.Vector3(TRACK_A, gateH + 1.6, 0);
        bannerPlane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_NONE;
        const banTex = new BABYLON.DynamicTexture('bantex', { width: 512, height: 80 }, scene, false);
        const bCtx   = banTex.getContext();
        bCtx.fillStyle = 'rgba(8,4,0,0.88)'; bCtx.fillRect(0, 0, 512, 80);
        const checkSize = 20;
        for (let ci = 0; ci < 4; ci++) {
            bCtx.fillStyle = ci % 2 === 0 ? '#ffffff' : '#000000';
            bCtx.fillRect(ci * checkSize, 0, checkSize, 80);
            bCtx.fillStyle = ci % 2 === 0 ? '#000000' : '#ffffff';
            bCtx.fillRect(512 - (ci + 1) * checkSize, 0, checkSize, 80);
        }
        bCtx.font = 'bold 48px Arial, sans-serif';
        bCtx.textAlign = 'center'; bCtx.textBaseline = 'middle';
        bCtx.shadowColor = 'rgba(0,0,0,0.9)'; bCtx.shadowBlur = 8;
        bCtx.fillStyle = '#ffd700';
        bCtx.fillText('FINISH', 256, 42);
        banTex.update();
        const banMat = new BABYLON.StandardMaterial('banm', scene);
        banMat.diffuseTexture = banTex;
        banMat.emissiveTexture = banTex;
        banMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
        banMat.useAlphaFromDiffuseTexture = true;
        banMat.disableLighting = true;
        banMat.backFaceCulling = false;
        bannerPlane.material = _envMesh(banMat);
        _finishBanner = bannerPlane;

        // Kulisse
        _buildMeadowKulisse();
    }

    function _buildMeadowKulisse() {
        buildTrees();
        buildStands();
        buildStandsRight();
        buildBarriers();
        buildFlags();
        buildFloodlights();
    }

    function triggerSpectatorWave(z0 = 0, dir = 1) {
        _waves.push({ z0, dir, startTime: performance.now() / 1000 });
    }

    // ── Wetter anwenden ───────────────────────────────────────────────────────
    function setWeather(name) {
        const p = WEATHER_PRESETS[name] || WEATHER_PRESETS.sunny;

        // Sky-Material
        if (_skyDome) _skyDome.isVisible = p.skyVisible !== false;
        if (_skyMat && p.skyVisible !== false) {
            _skyMat.turbidity   = p.skyTurbidity;
            _skyMat.luminance   = p.skyLuminance;
            _skyMat.inclination = p.skyInclination;
            _skyMat.azimuth     = p.skyAzimuth;
        }

        // Hintergrundfarbe
        if (scene && p.clearColor) {
            const c = p.clearColor;
            scene.clearColor = new BABYLON.Color4(c[0], c[1], c[2], 1);
        }

        // Sonnenlicht
        if (_sun) {
            _sun.intensity = p.sunIntensity;
            const sc = p.sunColor;
            _sun.diffuse = new BABYLON.Color3(sc[0], sc[1], sc[2]);
        }

        // Umgebungslicht
        if (_amb) {
            _amb.intensity = p.ambIntensity;
            const ac = p.ambColor;
            _amb.diffuse = new BABYLON.Color3(ac[0], ac[1], ac[2]);
        }

        // Nebel
        if (scene) {
            scene.fogDensity = p.fogDensity;
            const fc = p.fogColor;
            scene.fogColor = new BABYLON.Color3(fc[0], fc[1], fc[2]);
        }

        // Nacht-Scheinwerfer – PointLights + Material-Limit erhöhen
        _nightLights.forEach(l => l.dispose());
        _nightLights = [];
        if (p.night && scene) {
            // Babylon.js erlaubt per Material nur 4 Lichter gleichzeitig (Standard).
            // Alle Materialien auf 14 hochsetzen, damit alle Nacht-Lichter greifen.
            scene.materials.forEach(m => {
                if (typeof m.maxSimultaneousLights === 'number')
                    m.maxSimultaneousLights = 14;
            });

            // 8 Lichter hoch über dem Innenfeld – decken den gesamten Kurs ab
            // (Abstand zu äußerstem Streckenpunkt < 95 Einheiten bei range=110)
            const innerPositions = [
                [ 32,  14], [ 0,  20], [-32,  14],
                [-32, -14], [ 0, -20], [ 32, -14],
                [ 55,   0], [-55,   0],          // zusätzlich an den Längsenden
            ];
            innerPositions.forEach(([px, pz], i) => {
                const pl = new BABYLON.PointLight('nl_' + i,
                    new BABYLON.Vector3(px, 22, pz), scene);
                pl.diffuse   = new BABYLON.Color3(1.0, 0.97, 0.88);
                pl.specular  = new BABYLON.Color3(0.45, 0.43, 0.35);
                pl.intensity = 0.85;
                pl.range     = 95;
                _nightLights.push(pl);
            });
        } else if (scene) {
            // Aus dem Nachtmodus zurück: Limit wieder auf Standard
            scene.materials.forEach(m => {
                if (typeof m.maxSimultaneousLights === 'number')
                    m.maxSimultaneousLights = 4;
            });
        }

        // Regen
        if (_rainPs) { _rainPs.stop(); _rainPs.dispose(); _rainPs = null; }
        if (p.rain && scene) {
            _rainPs = new BABYLON.ParticleSystem('rain', 3200, scene);
            _rainPs.particleTexture = _particleTex;
            _rainPs.emitter    = new BABYLON.Vector3(0, 20, 0);
            _rainPs.minEmitBox = new BABYLON.Vector3(-130, 0, -65);
            _rainPs.maxEmitBox = new BABYLON.Vector3( 130, 0,  65);
            _rainPs.color1     = new BABYLON.Color4(0.72, 0.78, 0.92, 0.75);
            _rainPs.color2     = new BABYLON.Color4(0.60, 0.65, 0.82, 0.50);
            _rainPs.colorDead  = new BABYLON.Color4(0.50, 0.55, 0.72, 0.00);
            _rainPs.minSize    = 0.05;  _rainPs.maxSize      = 0.11;
            _rainPs.minLifeTime = 0.7;  _rainPs.maxLifeTime  = 1.3;
            _rainPs.emitRate   = 2800;
            _rainPs.direction1 = new BABYLON.Vector3(-0.4, -1, -0.2);
            _rainPs.direction2 = new BABYLON.Vector3( 0.4, -1,  0.2);
            _rainPs.minEmitPower = 16;  _rainPs.maxEmitPower = 20;
            _rainPs.gravity    = new BABYLON.Vector3(0, -2, 0);
            _rainPs.blendMode  = BABYLON.ParticleSystem.BLENDMODE_ADD;
            _rainPs.start();
        }

        // Schnee (Arktis-Map)
        if (_snowPs) { _snowPs.stop(); _snowPs.dispose(); _snowPs = null; }
        if (p.snow && scene) {
            _snowPs = new BABYLON.ParticleSystem('snow', 1800, scene);
            _snowPs.particleTexture = _particleTex;
            _snowPs.emitter    = new BABYLON.Vector3(0, 18, 0);
            _snowPs.minEmitBox = new BABYLON.Vector3(-150, 0, -50);
            _snowPs.maxEmitBox = new BABYLON.Vector3( 150, 0,  50);
            _snowPs.color1     = new BABYLON.Color4(0.92, 0.96, 1.00, 0.85);
            _snowPs.color2     = new BABYLON.Color4(0.80, 0.88, 0.98, 0.60);
            _snowPs.colorDead  = new BABYLON.Color4(0.85, 0.90, 0.98, 0.00);
            _snowPs.minSize    = 0.08;  _snowPs.maxSize     = 0.22;
            _snowPs.minLifeTime = 2.2;  _snowPs.maxLifeTime = 4.5;
            _snowPs.emitRate   = 800;
            _snowPs.direction1 = new BABYLON.Vector3(-0.5, -1,  0.1);
            _snowPs.direction2 = new BABYLON.Vector3( 0.5, -1, -0.1);
            _snowPs.minEmitPower = 2.5; _snowPs.maxEmitPower = 5.5;
            _snowPs.gravity    = new BABYLON.Vector3(0, -1.2, 0);
            _snowPs.blendMode  = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
            _snowPs.start();
        }
    }

    function init(canvas) {
        engine = new BABYLON.Engine(canvas, true, { adaptToDeviceRatio: true });
        scene  = new BABYLON.Scene(engine);
        scene.clearColor = new BABYLON.Color4(0.4, 0.65, 0.9, 1);

        // Atmosphärischer Nebel
        scene.fogMode    = BABYLON.Scene.FOGMODE_EXP2;
        scene.fogDensity = 0.004;
        scene.fogColor   = new BABYLON.Color3(0.7, 0.85, 1.0);

        camera = new BABYLON.ArcRotateCamera('cam', -Math.PI/2, 0.72, 45, BABYLON.Vector3.Zero(), scene);
        camera.lowerRadiusLimit = 20;  camera.upperRadiusLimit = 120;
        camera.lowerBetaLimit   = 0.1; camera.upperBetaLimit   = 1.42; // nie unter den Horizont
        camera.attachControl(canvas, true);

        followCam = new BABYLON.FreeCamera('followCam', new BABYLON.Vector3(0, 8, -20), scene);
        followCam.minZ = 0.1;

        // Sonne mit Schatten
        _sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-1, -2, -0.5), scene);
        _sun.position  = new BABYLON.Vector3(80, 120, 60);
        _sun.intensity = 1.4;
        const shadowGen = new BABYLON.ShadowGenerator(1024, _sun);
        shadowGen.useBlurExponentialShadowMap = true;
        shadowGen.blurKernel = 8;
        _shadowGen = shadowGen;

        _amb = new BABYLON.HemisphericLight('amb', new BABYLON.Vector3(0,1,0), scene);
        _amb.intensity    = 0.55;
        _amb.groundColor  = new BABYLON.Color3(0.3, 0.4, 0.2);

        // Prozeduraler Himmel
        _skyMat = new BABYLON.SkyMaterial('sky', scene);
        _skyMat.backFaceCulling = false;
        _skyMat.turbidity       = 8;
        _skyMat.luminance       = 0.9;
        _skyMat.inclination     = 0.42;
        _skyMat.azimuth         = 0.3;
        _skyDome = BABYLON.MeshBuilder.CreateSphere('skyDome', { diameter: 600, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
        _skyDome.material  = _skyMat;
        _skyDome.isPickable = false;

        // Partikel-Textur initialisieren
        _particleTex = createParticleTex();

        // Initiales Wiesen-Environment aufbauen
        _buildMeadowEnvironment();
        _finishBanner = scene.getMeshByName('banner') || null;

        // Render-Loop
        scene.registerBeforeRender(() => {
            for (const [id, h] of Object.entries(horses)) {
                // Unbounded interpolation — kein Modulo-Wrapping nötig
                h.displayProgress += (h.targetProgress - h.displayProgress) * 0.25;

                h.displayLane += (h.targetLane - h.displayLane) * 0.18;
                const laneOff = -3.5 + h.displayLane * 3.5;

                const pos  = trackPosition(h.displayProgress, laneOff);
                const posY = new BABYLON.Vector3(pos.x, 0.15 + h.jumpHeight, pos.z);
                h.root.position = posY;

                const nxt = trackPosition(h.displayProgress + 8, laneOff);
                h.root.lookAt(new BABYLON.Vector3(nxt.x, 0.15, nxt.z));

                // Beinanimation
                const swing = Math.min(h.speed * 0.06, 0.75);
                const dt    = engine.getDeltaTime() / 1000;

                if (h.jumpHeight > 0.05) {
                    // Sprung-Pose: Oberschenkel + Kniebeuge (Unterschenkel)
                    // Vorne: Bein nach vorne gestreckt + Knie angewinkelt
                    // Hinten: Bein nach hinten + Hinterknie hochgezogen (von hinten sichtbar)
                    for (const leg of h.legMeshes) {
                        const uTarget = leg.isFront ?  0.72 : -0.68;
                        const lTarget = leg.isFront ?  0.55 :  0.70; // Knie/Hock angewinkelt
                        leg.upper.rotation.x += (uTarget - leg.upper.rotation.x) * 0.16;
                        if (leg.lower) leg.lower.rotation.x += (lTarget - leg.lower.rotation.x) * 0.16;
                    }
                } else {
                    // Lauf-Animation: zeitbasierter Akkumulator
                    const hz = Math.min(h.speed * 0.09, 1.8);
                    h._legCycle += hz * Math.PI * 2 * dt;
                    for (const leg of h.legMeshes) {
                        leg.upper.rotation.x = Math.sin(h._legCycle + leg.phase) * swing;
                        // Unterschenkel zurück auf 0 lerpen (nach Sprung)
                        if (leg.lower && Math.abs(leg.lower.rotation.x) > 0.01)
                            leg.lower.rotation.x += (0 - leg.lower.rotation.x) * 0.16;
                    }
                }

                // Treffer-Highlight
                // Hit-Flash: Pferd leuchtet kurz rot auf, zieht dann aus
                if (h.penalized && !h._wasPenalized) h._hitFlash = 1.0;
                if (h._hitFlash > 0) {
                    h._hitFlash = Math.max(0, h._hitFlash - 0.045);
                    if (h.bodyMat) h.bodyMat.emissiveColor.set(h._hitFlash * 0.9, 0, 0);
                } else if (h.bodyMat && h.bodyMat.emissiveColor.r > 0) {
                    h.bodyMat.emissiveColor.set(0, 0, 0);
                }

                // Staub (Tempo-abhängig)
                if (h.dustPs) h.dustPs.emitRate = h.speed > 8 ? Math.min(90, h.speed * 2.2) : 0;

                // Funken-Burst bei Treffer (steigende Flanke)
                if (h.penalized && !h._wasPenalized && h.hitPs) {
                    h.hitPs.emitRate = 500;
                    setTimeout(() => { if (h.hitPs) h.hitPs.emitRate = 0; }, 130);
                }
                h._wasPenalized = h.penalized;

                // Schild-Aura (blaue Blase pulsiert)
                if (h.shieldBubble) {
                    h.shieldBubble.isVisible = h.shieldActive;
                    if (h.shieldActive) {
                        const pulse = 1.0 + 0.06 * Math.sin(performance.now() * 0.0035);
                        h.shieldBubble.scaling.setAll(pulse);
                    }
                }

                // Turbo-Flammen-Schweif
                if (h.turboPs) h.turboPs.emitRate = h.turboActive ? 75 : 0;

                // Ziel-Konfetti am Pferd (steigende Flanke: Pferd erreicht Ziel)
                if (h.finished && !h._wasFinished && h.finishPs) {
                    h.finishPs.emitRate = 200;
                    setTimeout(() => { if (h.finishPs) h.finishPs.emitRate = 0; }, 900);
                }
                h._wasFinished = h.finished;

                // Windschatten-Partikel (cyan, kontinuierlich wenn in Slipstream)
                if (h.slipPs) h.slipPs.emitRate = h.slipstream ? 35 : 0;

                // Blitz-Stun-Funken (großer Burst + Dauerfunken solange betäubt)
                if (h.blitzPs) {
                    if (h.blitzStunned && !h._wasBlitzStunned) {
                        // Steigende Flanke: kräftiger Burst
                        h.blitzPs.emitRate = 320;
                        setTimeout(() => { if (h.blitzPs) h.blitzPs.emitRate = h.blitzStunned ? 28 : 0; }, 1000);
                    } else if (!h.blitzStunned && h._wasBlitzStunned) {
                        // Fallende Flanke: Partikel stoppen
                        h.blitzPs.emitRate = 0;
                    }
                    h._wasBlitzStunned = h.blitzStunned;
                }

                if (id === _playerId) {
                    if (cameraMode === 'overview') {
                        // Je näher rangezoomt, desto schneller folgt die Kamera
                        camera.target = posY.clone();
                    } else {
                        // Vorwärtsrichtung des Pferdes in World-Space
                        const fwd = BABYLON.Vector3.TransformNormal(
                            new BABYLON.Vector3(0, 0, 1), h.root.getWorldMatrix()).normalize();
                        const targetCamPos = posY
                            .subtract(fwd.scale(14))
                            .add(new BABYLON.Vector3(0, 6, 0));
                        if (targetCamPos.y < 2.5) targetCamPos.y = 2.5;   // Zielposition nie unter Boden
                        followCam.position = BABYLON.Vector3.Lerp(followCam.position, targetCamPos, 0.07);
                        if (followCam.position.y < 2.0) followCam.position.y = 2.0; // tatsächliche Position auch sichern
                        const lookAt = posY.add(fwd.scale(8)).add(new BABYLON.Vector3(0, 1, 0));
                        followCam.setTarget(BABYLON.Vector3.Lerp(followCam.target, lookAt, 0.1));

                        // Kamera-Shake nach Blitz-Treffer
                        if (performance.now() < _shakeEnd) {
                            const decay = (_shakeEnd - performance.now()) / 500;
                            followCam.position.addInPlace(new BABYLON.Vector3(
                                (Math.random() - 0.5) * _shakeIntensity * decay,
                                (Math.random() - 0.5) * _shakeIntensity * 0.35 * decay,
                                0
                            ));
                        }
                    }
                }

                // ── Label Proximity-Fade ──────────────────────────────────────
                if (h.labelPlane && h.labelPlane.material) {
                    let target = 0;
                    if (id === _playerId) {
                        // Eigenes Label: nur in Übersicht leicht einblenden
                        target = cameraMode === 'overview' ? 0.40 : 0;
                    } else if (_playerId && horses[_playerId]) {
                        const dist = BABYLON.Vector3.Distance(
                            horses[_playerId].root.position, h.root.position);
                        // Einblenden 6–22 Einheiten, voll sichtbar unter 6
                        target = dist < 6  ? 0.88
                               : dist > 22 ? 0
                               : 0.88 * (22 - dist) / 16;
                    }
                    // Sanftes Überblenden
                    const cur = h.labelPlane.material.alpha;
                    h.labelPlane.material.alpha = cur + (target - cur) * 0.10;
                }
            }

            // Power-Up-Animation (außerhalb des Pferde-Loops)
            const puNow = performance.now() / 1000;
            for (const pm of Object.values(powerupMeshes)) {
                pm.rotation.y += 0.04;
                pm.position.y  = 1.8 + Math.sin(puNow * 2.2 + (pm._phase || 0)) * 0.3;
            }

            // Zuschauer-Welle
            if (_waves.length > 0) {
                const wNow = performance.now() / 1000;
                _spectators.forEach(sp => { sp._dy = 0; });
                for (let wi = _waves.length - 1; wi >= 0; wi--) {
                    const w = _waves[wi];
                    const el = wNow - w.startTime;
                    if (el > 3.5) { _waves.splice(wi, 1); continue; }
                    const front = w.z0 + w.dir * el * 14;
                    for (const sp of _spectators) {
                        const phase = Math.max(0, 1 - Math.abs(sp.z - front) / 6.5);
                        sp._dy = Math.max(sp._dy, Math.sin(phase * Math.PI) * 0.52);
                    }
                }
                _spectators.forEach(sp => {
                    sp.body.position.y = sp.baseY + (sp._dy || 0);
                });
            }

            // FINISH-Banner pulsiert
            if (_finishBanner) {
                const glow = 0.65 + 0.35 * Math.abs(Math.sin(puNow * 1.8));
                _finishBanner.material.emissiveColor = new BABYLON.Color3(glow, glow * 0.88, glow * 0.55);
            }

            // Fahnen-Flattern
            for (const f of _flagMeshes) {
                f.scaling.x  = 1.0 + 0.18 * Math.sin(puNow * 3.4 + f._phase);
                f.rotation.y = 0.07 * Math.sin(puNow * 2.0 + f._phase * 1.3);
            }
        });

        engine.runRenderLoop(() => scene.render());
        window.addEventListener('resize', () => engine.resize());

        // Follow-Kamera als Standard aktivieren
        camera.detachControl();
        scene.activeCamera = followCam;
    }

    // ── Jockey-Charakter auf dem Pferd ────────────────────────────────────────
    function createRider(horseRoot, cfg) {
        // 8 Hautfarben
        const SKIN = [
            [0.99,0.91,0.80], [0.94,0.78,0.62], [0.91,0.71,0.54], [0.82,0.61,0.43],
            [0.75,0.50,0.31], [0.67,0.47,0.28], [0.55,0.38,0.26], [0.36,0.22,0.11],
        ];
        // 10 Oberteil-Farben
        const SHIRT = [
            [0.85,0.15,0.15], [0.20,0.45,0.85], [0.15,0.72,0.25], [0.95,0.82,0.10],
            [0.65,0.18,0.82], [0.92,0.92,0.92], [0.91,0.47,0.13], [0.08,0.78,0.78],
            [0.91,0.16,0.53], [0.15,0.15,0.15],
        ];
        // 6 Hosen-Farben
        const PANTS = [
            [0.12,0.12,0.15], [0.15,0.25,0.50], [0.42,0.28,0.18],
            [0.55,0.55,0.58], [0.24,0.43,0.16], [0.50,0.00,0.13],
        ];

        const sk = SKIN [(cfg.face   || 0) % SKIN.length];
        const sh = SHIRT[(cfg.shirt  || 0) % SHIRT.length];
        const pa = PANTS[(cfg.pants  || 0) % PANTS.length];
        const helmetIdx = (cfg.helmet || 0) % 4;

        const skinM  = mat(scene, new BABYLON.Color3(sk[0], sk[1], sk[2]));
        const shirtM = mat(scene, new BABYLON.Color3(sh[0], sh[1], sh[2]));
        const pantsM = mat(scene, new BABYLON.Color3(pa[0], pa[1], pa[2]));
        const bootM  = mat(scene, new BABYLON.Color3(0.18, 0.10, 0.05));
        const visorM = mat(scene, new BABYLON.Color3(0.07, 0.07, 0.09));

        // Unsichtbarer Root-Mesh
        const rRoot = BABYLON.MeshBuilder.CreateBox('rider_' + Math.random(), {size:0.01}, scene);
        rRoot.isVisible  = false;
        rRoot.parent     = horseRoot;
        rRoot.position   = new BABYLON.Vector3(0, 3.05, 0.1);
        rRoot.rotation.x = 0.28;

        function rp(sz, pos, m, rx, rz) {
            const mesh = BABYLON.MeshBuilder.CreateBox('rm_' + Math.random(), sz, scene);
            mesh.position = new BABYLON.Vector3(pos[0], pos[1], pos[2]);
            if (rx) mesh.rotation.x = rx;
            if (rz) mesh.rotation.z = rz;
            mesh.material = m; mesh.parent = rRoot;
            if (_shadowGen) _shadowGen.addShadowCaster(mesh);
            return mesh;
        }
        function rc(opt, pos, m) {
            const mesh = BABYLON.MeshBuilder.CreateCylinder('rc_' + Math.random(), opt, scene);
            mesh.position = new BABYLON.Vector3(pos[0], pos[1], pos[2]);
            mesh.material = m; mesh.parent = rRoot;
            if (_shadowGen) _shadowGen.addShadowCaster(mesh);
            return mesh;
        }

        // ── Körper ────────────────────────────────────────────────────────────
        rp({width:0.65, height:0.78, depth:0.42}, [ 0,    0.37,  0    ], shirtM);
        rp({width:0.50, height:0.50, depth:0.50}, [ 0,    0.96,  0.04 ], skinM);   // Kopf

        // ── Gesicht ───────────────────────────────────────────────────────────
        // Kopf-Vorderfläche liegt bei z = 0.04 + 0.25 = 0.29 (rRoot-Lokalraum)
        const eyeM   = mat(scene, new BABYLON.Color3(0.08, 0.05, 0.03));
        const browM  = mat(scene, new BABYLON.Color3(sk[0]*0.28, sk[1]*0.17, sk[2]*0.08));
        const mouthM = mat(scene, new BABYLON.Color3(0.48, 0.18, 0.14));
        const noseM  = mat(scene, new BABYLON.Color3(sk[0]*0.78, sk[1]*0.60, sk[2]*0.42));
        // Augen
        rp({width:0.09, height:0.07, depth:0.03}, [ 0.11, 1.01, 0.295], eyeM);
        rp({width:0.09, height:0.07, depth:0.03}, [-0.11, 1.01, 0.295], eyeM);
        // Augenbrauen — leicht schräg für Ausdruck
        rp({width:0.09, height:0.03, depth:0.02}, [ 0.11, 1.07, 0.290], browM, 0, -0.18);
        rp({width:0.09, height:0.03, depth:0.02}, [-0.11, 1.07, 0.290], browM, 0,  0.18);
        // Nase — kleiner vorstehender Block
        rp({width:0.07, height:0.09, depth:0.06}, [0,     0.94, 0.305], noseM);
        // Mund
        rp({width:0.14, height:0.04, depth:0.02}, [0,     0.83, 0.290], mouthM);
        rp({width:0.20, height:0.44, depth:0.20}, [ 0.43, 0.48, 0.16 ], shirtM, -1.10);
        rp({width:0.20, height:0.44, depth:0.20}, [-0.43, 0.48, 0.16 ], shirtM, -1.10);
        rp({width:1.78, height:0.24, depth:0.38}, [ 0,   -0.05,  0    ], pantsM);
        rp({width:0.26, height:0.36, depth:0.28}, [ 0.90,-0.26,  0    ], pantsM);
        rp({width:0.26, height:0.36, depth:0.28}, [-0.90,-0.26,  0    ], pantsM);
        rp({width:0.23, height:0.30, depth:0.23}, [ 0.90,-0.52, -0.08 ], pantsM, -0.30);
        rp({width:0.23, height:0.30, depth:0.23}, [-0.90,-0.52, -0.08 ], pantsM, -0.30);
        rp({width:0.27, height:0.15, depth:0.34}, [ 0.90,-0.70, -0.06 ], bootM);
        rp({width:0.27, height:0.15, depth:0.34}, [-0.90,-0.70, -0.06 ], bootM);

        // ── Kopfbedeckung ─────────────────────────────────────────────────────
        if (helmetIdx === 0) {
            // Jockey-Cap — glatte Helmkuppel, kleiner Schirm vorne, kein Visier
            const helmM = mat(scene, new BABYLON.Color3(0.15, 0.35, 0.75));
            const rimM  = mat(scene, new BABYLON.Color3(0.08, 0.20, 0.52));
            // Hauptkuppel: etwas größer + mehr Segmente = glatter
            const dome = BABYLON.MeshBuilder.CreateSphere('hd_' + Math.random(),
                { diameter: 0.64, segments: 9 }, scene);
            dome.scaling.y = 0.74;
            dome.position  = new BABYLON.Vector3(0, 1.29, 0.12);
            dome.material  = helmM; dome.parent = rRoot;
            if (_shadowGen) _shadowGen.addShadowCaster(dome);
            // Schirm: flacher Zylinder, Mitte an Kuppelvorderkante (z=0.40) →
            // hintere Hälfte steckt im Dome, vordere Hälfte = Halbkreis-Schirm
            const _brim = BABYLON.MeshBuilder.CreateCylinder('br_' + Math.random(),
                { diameter: 0.36, height: 0.05, tessellation: 16 }, scene);
            _brim.position  = new BABYLON.Vector3(0, 1.17, 0.40);
            _brim.rotation.x = 0.10;
            _brim.material  = rimM; _brim.parent = rRoot;
            if (_shadowGen) _shadowGen.addShadowCaster(_brim);

        } else if (helmetIdx === 1) {
            // 🤠 Cowboyhut — immer warmbraun, Krone läuft oben natürlich aus
            const hatM  = mat(scene, new BABYLON.Color3(0.52, 0.30, 0.11));
            const bandM = mat(scene, new BABYLON.Color3(0.28, 0.14, 0.04)); // dunkles Hutband
            rc({diameter:1.04, height:0.06, tessellation:14},                         [0, 1.19, 0.04], hatM);  // Krempe
            rc({diameterTop:0.40, diameterBottom:0.46, height:0.12, tessellation:10},[0, 1.28, 0.04], hatM);  // unterer Kronenzylinder
            // Gewölbtes Oberteil: abgeflachte Halbkugel gibt die typische Stetson-Wölbung
            const _cd = BABYLON.MeshBuilder.CreateSphere('chd_'+Math.random(), {diameter:0.42, segments:7}, scene);
            _cd.scaling.y = 0.58;
            _cd.position  = new BABYLON.Vector3(0, 1.40, 0.04);
            _cd.material  = hatM; _cd.parent = rRoot;
            if (_shadowGen) _shadowGen.addShadowCaster(_cd);
            rc({diameter:0.47, height:0.05, tessellation:10},                         [0, 1.22, 0.04], bandM); // Hutband

        } else if (helmetIdx === 2) {
            // 🎩 Zylinder — schmaler Korpus + breite Krempe
            const topM  = mat(scene, new BABYLON.Color3(0.09, 0.07, 0.07));
            const bandM = mat(scene, new BABYLON.Color3(0.82, 0.08, 0.08));
            rc({diameter:0.88, height:0.07, tessellation:12}, [0, 1.19, 0.04], topM);
            rc({diameter:0.44, height:0.38, tessellation:12}, [0, 1.41, 0.04], topM);
            rc({diameter:0.46, height:0.11, tessellation:12},  [0, 1.27, 0.04], bandM);

        } else {
            // Keine Kopfbedeckung — gestaffelte Haare (oben breit, unten schmal)
            const hairM = mat(scene, new BABYLON.Color3(sk[0]*0.28, sk[1]*0.18, sk[2]*0.09));
            // Obere Kappe
            rp({width:0.54, height:0.13, depth:0.55}, [0,  1.25,  0.03], hairM);
            // Hinterkopf — 3 Schichten werden schmaler nach unten
            rp({width:0.50, height:0.12, depth:0.11}, [0,  1.13, -0.23], hairM);
            rp({width:0.42, height:0.11, depth:0.10}, [0,  1.02, -0.23], hairM);
            rp({width:0.30, height:0.10, depth:0.09}, [0,  0.92, -0.22], hairM);
            // Seiten links & rechts
            rp({width:0.09, height:0.26, depth:0.46}, [ 0.29, 1.04, 0.02], hairM);
            rp({width:0.09, height:0.26, depth:0.46}, [-0.29, 1.04, 0.02], hairM);
            // Stirnfransen
            rp({width:0.48, height:0.11, depth:0.09}, [0,     1.18,  0.28], hairM);
        }
    }

    // ── Name-Label als Billboard über dem Pferd ───────────────────────────────
    // Klein und schlicht — Sichtbarkeit wird im Render-Loop per Distanz gesteuert.
    function _createLabel(name, isPlayer, horseType) {
        const W = 192, H = 36;
        const plane = BABYLON.MeshBuilder.CreatePlane('lbl_' + name,
            { width: 2.8, height: 0.52 }, scene);
        plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        plane.isPickable    = false;
        plane.position.y    = 5.6;   // etwas niedriger als vorher

        const tex = new BABYLON.DynamicTexture('lbtex_' + name,
            { width: W, height: H }, scene, false);
        tex.hasAlpha = true;

        const ctx2d = tex.getContext();
        ctx2d.clearRect(0, 0, W, H);

        // Minimaler Hintergrund — kein Rahmen, kaum sichtbar
        ctx2d.fillStyle = 'rgba(0,0,0,0.32)';
        ctx2d.fillRect(0, 0, W, H);

        // Nur der Name, klares Weiß / helles Gold für eigenen Spieler
        ctx2d.font         = `${isPlayer ? '600' : '500'} 18px Arial, sans-serif`;
        ctx2d.textAlign    = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillStyle    = isPlayer ? 'rgba(255,228,110,1.0)' : 'rgba(255,255,255,0.97)';
        ctx2d.fillText((name || '?').slice(0, 14), W / 2, H / 2 + 1);
        tex.update();

        const lm = new BABYLON.StandardMaterial('lbmat_' + name, scene);
        lm.diffuseTexture             = tex;
        lm.emissiveTexture            = tex;
        lm.useAlphaFromDiffuseTexture = true;
        lm.disableLighting            = true;
        lm.backFaceCulling            = false;
        lm.alpha = 0;   // startet unsichtbar, Render-Loop regelt Proximity-Fade
        plane.material = lm;

        return plane;
    }

    function setPlayerId(id) { _playerId = id; }

    function setCameraMode(mode) {
        cameraMode = mode;
        if (mode === 'follow') {
            camera.detachControl();
            scene.activeCamera = followCam;
        } else {
            scene.activeCamera = camera;
            camera.attachControl(engine.getRenderingCanvas(), true);
            // Sofort auf aktuelle Pferdeposition springen, nicht langsam hinlerpen
            if (_playerId && horses[_playerId]) {
                const pos = horses[_playerId].root.position;
                camera.target = new BABYLON.Vector3(pos.x, pos.y + 1, pos.z);
            }
        }
    }

    function updateHorse(id, progress, speed, lane, jumpHeight, penalized, isPlayer, rgbArr, name, riderCfg, horseType, laps, shieldActive, turboActive, finished, slipstream, blitzStunned) {
        const lapCount  = laps || 0;
        const unbound   = progress + lapCount * TRACK_LENGTH;   // nie wrappen → kein Jitter
        if (!horses[id]) {
            const color = rgbArr
                ? new BABYLON.Color3(rgbArr[0], rgbArr[1], rgbArr[2])
                : isPlayer
                    ? new BABYLON.Color3(0.85, 0.55, 0.15)
                    : new BABYLON.Color3(0.3+Math.random()*0.5, 0.2+Math.random()*0.3, 0.1+Math.random()*0.4);
            const { root, legMeshes, bodyMat, shieldBubble, turboPs, finishPs, blitzPs, slipPs } = createHorse(scene, color);
            createRider(root, riderCfg || { face:0, shirt:0, pants:0 });
            const labelPlane = _createLabel(name || '?', isPlayer, horseType);
            labelPlane.parent = root;
            horses[id] = { root, legMeshes, bodyMat, labelPlane,
                shieldBubble, turboPs, finishPs, blitzPs, slipPs,
                displayProgress: unbound, targetProgress: unbound,
                _trackedLaps: lapCount, _legCycle: 0,
                speed: 0, displayLane: lane, targetLane: lane, jumpHeight: 0, penalized: false,
                shieldActive: false, turboActive: false, finished: false, _wasFinished: false,
                slipstream: false, blitzStunned: false, _wasBlitzStunned: false };
        }
        const h = horses[id];
        // Rennen neu gestartet? (laps zurückgesprungen) → displayProgress direkt setzen
        if (lapCount < h._trackedLaps) h.displayProgress = unbound;
        h._trackedLaps   = lapCount;
        h.targetProgress = unbound;
        h.speed          = speed;
        h.targetLane     = lane;
        h.jumpHeight     = jumpHeight;
        h.penalized      = penalized;
        h.shieldActive   = !!shieldActive;
        h.turboActive    = !!turboActive;
        h.finished       = !!finished;
        h.slipstream     = !!slipstream;
        h.blitzStunned   = !!blitzStunned;
    }

    function updateObstacles(list) {
        if (!list || list.length === 0) return;
        for (const obs of list) {

            const isArcticMap = !!_arcticLUT;

            // ── Bewegliches Hindernis (Heuwagen / Eisscholle) ─────────────────
            if (obs.type === 'haycart') {
                const laneIdx = obs.laneFloat !== undefined ? obs.laneFloat : obs.lane;
                const laneOff = -3.5 + Math.max(0, Math.min(2, laneIdx)) * 3.5;
                const pos     = trackPosition(obs.progress, laneOff);

                if (obstacleMeshes[obs.id]) {
                    obstacleMeshes[obs.id].position.x = pos.x;
                    obstacleMeshes[obs.id].position.z = pos.z;
                } else {
                    const cNxt = trackPosition(obs.progress + 5, 0);
                    const root = new BABYLON.TransformNode('obs'+obs.id, scene);
                    root.position = new BABYLON.Vector3(pos.x, 0, pos.z);

                    if (isArcticMap) {
                        // ❄️ Eisschlitten
                        const sledMat  = mat(scene, new BABYLON.Color3(0.55, 0.78, 0.95));
                        const iceMat2  = mat(scene, new BABYLON.Color3(0.72, 0.90, 1.00));
                        const darkIce  = mat(scene, new BABYLON.Color3(0.35, 0.58, 0.80));
                        // Kufen (zwei flache Bögen)
                        [-0.85, 0.85].forEach((x, i) => {
                            const runner = BABYLON.MeshBuilder.CreateBox('run'+i+'_'+obs.id,
                                { width: 0.14, height: 0.18, depth: 3.2 }, scene);
                            runner.position = new BABYLON.Vector3(x, 0.09, 0);
                            runner.material = darkIce; runner.parent = root;
                        });
                        // Plattform
                        const deck = BABYLON.MeshBuilder.CreateBox('deck_'+obs.id,
                            { width: 2.0, height: 0.22, depth: 2.8 }, scene);
                        deck.position.y = 0.30; deck.material = sledMat; deck.parent = root;
                        // Eisblöcke obenauf
                        [[-0.55,0.88,0.5],[0.55,0.88,0.5],[0,0.88,-0.55],[0,1.55,0]].forEach(([bx,by,bz],i) => {
                            const blk = BABYLON.MeshBuilder.CreateBox('blk'+i+'_'+obs.id,
                                { width: 0.85, height: 0.75, depth: 0.85 }, scene);
                            blk.position = new BABYLON.Vector3(bx, by, bz);
                            blk.material = iceMat2; blk.parent = root;
                        });
                    } else {
                        // 🌾 Heuwagen
                        const body = BABYLON.MeshBuilder.CreateBox('cbody'+obs.id, { width: 3.4, height: 0.55, depth: 2.0 }, scene);
                        body.position.y = 0.45;
                        body.material   = mat(scene, new BABYLON.Color3(0.58, 0.36, 0.13));
                        body.parent     = root;
                        const hay = BABYLON.MeshBuilder.CreateBox('chay'+obs.id, { width: 2.8, height: 1.85, depth: 1.5 }, scene);
                        hay.position.y = 1.65;
                        hay.material   = mat(scene, new BABYLON.Color3(0.90, 0.72, 0.12));
                        hay.parent     = root;
                        [-1.55, 1.55].forEach((x, i) => {
                            const plank = BABYLON.MeshBuilder.CreateBox('cplk'+i+'_'+obs.id, { width: 0.14, height: 1.4, depth: 1.9 }, scene);
                            plank.position = new BABYLON.Vector3(x, 0.95, 0);
                            plank.material = mat(scene, new BABYLON.Color3(0.50, 0.30, 0.10));
                            plank.parent   = root;
                        });
                    }

                    root.lookAt(new BABYLON.Vector3(cNxt.x, 0, cNxt.z));
                    root.getChildMeshes().forEach(m => { m.receiveShadows = true; if (_shadowGen) _shadowGen.addShadowCaster(m); });
                    obstacleMeshes[obs.id] = root;
                }
                continue;
            }

            // ── Statische Hindernisse ─────────────────────────────────────────
            if (obstacleMeshes[obs.id]) continue;
            const laneOff = obs.lane === -1 ? 0 : LANE_OFFSETS[obs.lane];
            const pos     = trackPosition(obs.progress, laneOff);
            const nxt     = trackPosition(obs.progress + 5, laneOff);

            // ── Heuballen / Schneehaufen ──────────────────────────────────────
            if (obs.type === 'haybale') {
                const root = new BABYLON.TransformNode('obs'+obs.id, scene);
                root.position = new BABYLON.Vector3(pos.x, 0, pos.z);

                if (isArcticMap) {
                    // ☃️ Schneemann mit Möhre, Augen und Knöpfen
                    const snowM   = mat(scene, new BABYLON.Color3(0.96, 0.98, 1.00));
                    const blackM  = mat(scene, new BABYLON.Color3(0.06, 0.06, 0.10));
                    const carrotM = mat(scene, new BABYLON.Color3(1.00, 0.42, 0.02));

                    // Unterkugel (leicht abgeflacht)
                    const bot = BABYLON.MeshBuilder.CreateSphere('smb_'+obs.id,
                        { diameter: 1.70, segments: 8 }, scene);
                    bot.scaling.y = 0.88; bot.position.y = 0.75;
                    bot.material = snowM; bot.parent = root;

                    // Mittelkugel
                    const mid = BABYLON.MeshBuilder.CreateSphere('smm_'+obs.id,
                        { diameter: 1.20, segments: 8 }, scene);
                    mid.position.y = 1.90; mid.material = snowM; mid.parent = root;

                    // Kopf
                    const head = BABYLON.MeshBuilder.CreateSphere('smh_'+obs.id,
                        { diameter: 0.88, segments: 7 }, scene);
                    head.position.y = 2.80; head.material = snowM; head.parent = root;

                    // Möhre (Nase) – Kegelspitze zeigt nach -Z (zur Kamera / entgegen Fahrtrichtung)
                    const carrot = BABYLON.MeshBuilder.CreateCylinder('smc_'+obs.id,
                        { diameterTop: 0, diameterBottom: 0.17, height: 0.52, tessellation: 8 }, scene);
                    carrot.rotation.x = -Math.PI / 2;  // Spitze zeigt nach -Z
                    carrot.position   = new BABYLON.Vector3(0, 2.80, -0.46);
                    carrot.material = carrotM; carrot.parent = root;

                    // Augen (2 schwarze Kugeln)
                    [-0.20, 0.20].forEach((x, i) => {
                        const eye = BABYLON.MeshBuilder.CreateSphere('sme'+i+'_'+obs.id,
                            { diameter: 0.13, segments: 4 }, scene);
                        eye.position = new BABYLON.Vector3(x, 2.92, -0.40);
                        eye.material = blackM; eye.parent = root;
                    });

                    // Mund – 4 kleine Kugeln in einem Bogen
                    [-0.22, -0.10, 0.10, 0.22].forEach((x, i) => {
                        const tooth = BABYLON.MeshBuilder.CreateSphere('smt'+i+'_'+obs.id,
                            { diameter: 0.09, segments: 4 }, scene);
                        tooth.position = new BABYLON.Vector3(x, 2.62 + Math.abs(x) * 0.4, -0.42);
                        tooth.material = blackM; tooth.parent = root;
                    });

                    // Knöpfe auf dem Bauch (3 Stück)
                    [0.25, 0, -0.25].forEach((dy, i) => {
                        const btn = BABYLON.MeshBuilder.CreateSphere('smbt'+i+'_'+obs.id,
                            { diameter: 0.14, segments: 4 }, scene);
                        btn.position = new BABYLON.Vector3(0, 1.90 + dy, -0.58);
                        btn.material = blackM; btn.parent = root;
                    });

                    // Zylinderhut (Krempe + Korpus)
                    const hatM = mat(scene, new BABYLON.Color3(0.08, 0.06, 0.10));
                    const brim = BABYLON.MeshBuilder.CreateCylinder('smhb_'+obs.id,
                        { diameter: 1.10, height: 0.10, tessellation: 16 }, scene);
                    brim.position.y = 3.26; brim.material = hatM; brim.parent = root;
                    const hatBody = BABYLON.MeshBuilder.CreateCylinder('smhc_'+obs.id,
                        { diameter: 0.66, height: 0.70, tessellation: 14 }, scene);
                    hatBody.position.y = 3.63; hatBody.material = hatM; hatBody.parent = root;
                } else {
                    // 🌾 Strohballen
                    const bale = BABYLON.MeshBuilder.CreateCylinder('bale'+obs.id,
                        { diameter: 1.85, height: 1.75, tessellation: 14 }, scene);
                    bale.rotation.z = Math.PI / 2;
                    bale.position.y = 0.9;
                    bale.material   = mat(scene, new BABYLON.Color3(0.88, 0.68, 0.10));
                    bale.parent     = root;
                    const twine = BABYLON.MeshBuilder.CreateTorus('twn'+obs.id,
                        { diameter: 1.88, thickness: 0.10, tessellation: 24 }, scene);
                    twine.rotation.y = Math.PI / 2;
                    twine.position.y = 0.9;
                    twine.material   = mat(scene, new BABYLON.Color3(0.45, 0.28, 0.06));
                    twine.parent     = root;
                }

                root.lookAt(new BABYLON.Vector3(nxt.x, 0, nxt.z));
                root.getChildMeshes().forEach(m => { m.receiveShadows = true; if (_shadowGen) _shadowGen.addShadowCaster(m); });
                obstacleMeshes[obs.id] = root;
                continue;
            }

            // ── Holzzaun / Eiswand ────────────────────────────────────────────
            if (obs.type === 'fence') {
                const root = new BABYLON.TransformNode('obs'+obs.id, scene);
                root.position = new BABYLON.Vector3(pos.x, 0, pos.z);

                if (isArcticMap) {
                    // 🧊 Eiswand – drei gestapelte Eisblöcke
                    const wallIce  = mat(scene, new BABYLON.Color3(0.55, 0.80, 0.98));
                    const darkIce2 = mat(scene, new BABYLON.Color3(0.38, 0.62, 0.88));
                    wallIce.specularColor  = new BABYLON.Color3(0.7, 0.85, 1.0);
                    wallIce.specularPower  = 48;
                    darkIce2.specularColor = new BABYLON.Color3(0.6, 0.75, 0.95);
                    // 3 Reihen Eisblöcke nebeneinander
                    for (let row = 0; row < 3; row++) {
                        const y = 0.55 + row * 1.05;
                        for (let col = -2; col <= 2; col++) {
                            const blk = BABYLON.MeshBuilder.CreateBox('ib'+row+'_'+col+'_'+obs.id,
                                { width: 1.95, height: 1.0, depth: 0.55 }, scene);
                            blk.position = new BABYLON.Vector3(col * 2.0, y, 0);
                            blk.material = (row + col) % 2 === 0 ? wallIce : darkIce2;
                            blk.parent   = root;
                        }
                    }
                } else {
                    // 🏇 Holzzaun
                    [-4.8, 4.8].forEach((x, i) => {
                        const post = BABYLON.MeshBuilder.CreateCylinder('post'+i+'_'+obs.id,
                            { diameter: 0.28, height: 3.2, tessellation: 7 }, scene);
                        post.position = new BABYLON.Vector3(x, 1.6, 0);
                        post.material = mat(scene, new BABYLON.Color3(0.62, 0.40, 0.16));
                        post.parent   = root;
                    });
                    [0.75, 1.75].forEach((y, i) => {
                        const rail = BABYLON.MeshBuilder.CreateBox('rail'+i+'_'+obs.id,
                            { width: 10.5, height: 0.22, depth: 0.22 }, scene);
                        rail.position = new BABYLON.Vector3(0, y, 0);
                        rail.material = mat(scene, new BABYLON.Color3(0.80, 0.52, 0.20));
                        rail.parent   = root;
                    });
                }

                root.lookAt(new BABYLON.Vector3(nxt.x, 0, nxt.z));
                root.getChildMeshes().forEach(m => { m.receiveShadows = true; if (_shadowGen) _shadowGen.addShadowCaster(m); });
                obstacleMeshes[obs.id] = root;
                continue;
            }
        }
    }

    function clearObstacles() {
        for (const m of Object.values(obstacleMeshes)) {
            if (m.getChildMeshes) m.getChildMeshes().forEach(c => c.dispose());
            m.dispose();
        }
        Object.keys(obstacleMeshes).forEach(k => delete obstacleMeshes[k]);
    }

    function updatePowerups(list) {
        if (!list) return;

        // Aufgesammelte entfernen
        const activeIds = new Set(list.map(p => p.id));
        for (const id of Object.keys(powerupMeshes)) {
            if (!activeIds.has(id)) {
                const root = powerupMeshes[id];
                root.getChildMeshes().forEach(m => m.dispose());
                root.dispose();
                delete powerupMeshes[id];
            }
        }

        for (const pu of list) {
            if (powerupMeshes[pu.id]) continue;

            const laneOff = LANE_OFFSETS[pu.lane] !== undefined ? LANE_OFFSETS[pu.lane] : 0;
            const pos     = trackPosition(pu.progress, laneOff);

            // Root-Node für Gruppe (Animation läuft auf Root)
            const root    = new BABYLON.TransformNode('pur_' + pu.id, scene);
            root.position = new BABYLON.Vector3(pos.x, 1.8, pos.z);
            root._phase   = pu.progress * 0.05;

            function childMat(diff, emissive, alpha) {
                const m = new BABYLON.StandardMaterial('pm_' + Math.random(), scene);
                m.diffuseColor  = diff;
                m.emissiveColor = emissive;
                if (alpha !== undefined) m.alpha = alpha;
                m.backFaceCulling = false;
                return m;
            }
            function childMesh(mesh) { mesh.parent = root; return mesh; }

            // ── 🛡️ Schild: aufrechter Ring + Hexagon-Fläche ─────────────────────
            if (pu.type === 'shield') {
                const faceM = childMat(
                    new BABYLON.Color3(0.18, 0.50, 1.0),
                    new BABYLON.Color3(0.06, 0.22, 0.65), 0.80);
                const rimM  = childMat(
                    new BABYLON.Color3(0.35, 0.70, 1.0),
                    new BABYLON.Color3(0.18, 0.45, 0.95));

                // Hexagon-Fläche (stehend)
                const face = BABYLON.MeshBuilder.CreateCylinder('psf_'+pu.id,
                    { diameter: 1.55, height: 0.10, tessellation: 6 }, scene);
                face.rotation.x = Math.PI / 2;
                face.material   = faceM;
                childMesh(face);

                // Leuchtender Rand
                const rim = BABYLON.MeshBuilder.CreateTorus('psr_'+pu.id,
                    { diameter: 1.55, thickness: 0.20, tessellation: 32 }, scene);
                rim.rotation.x = Math.PI / 2;
                rim.material   = rimM;
                childMesh(rim);

                // Schildbuckel in der Mitte
                const boss = BABYLON.MeshBuilder.CreateSphere('psb_'+pu.id,
                    { diameter: 0.44, segments: 6 }, scene);
                boss.scaling.z = 0.45;
                boss.rotation.x = Math.PI / 2;
                boss.material   = rimM;
                childMesh(boss);
            }

            // ── ⚡ Turbo: 3 leuchtende Pfeil-Chevrons (">>>") ────────────────
            else if (pu.type === 'turbo') {
                const arrowM = childMat(
                    new BABYLON.Color3(1.0, 0.88, 0.0),
                    new BABYLON.Color3(0.7, 0.55, 0.0));

                for (let i = 0; i < 3; i++) {
                    const xOff = (i - 1) * 0.55;
                    const h2   = 0.65 - i * 0.04;

                    // Oberer Arm "\"
                    const top = BABYLON.MeshBuilder.CreateBox('pta_'+i+'_'+pu.id,
                        { width: 0.14, height: h2, depth: 0.16 }, scene);
                    top.rotation.z = -Math.PI / 4;
                    top.position   = new BABYLON.Vector3(xOff,  h2 * 0.34, 0);
                    top.material   = arrowM;
                    childMesh(top);

                    // Unterer Arm "/"
                    const bot = BABYLON.MeshBuilder.CreateBox('ptb_'+i+'_'+pu.id,
                        { width: 0.14, height: h2, depth: 0.16 }, scene);
                    bot.rotation.z = Math.PI / 4;
                    bot.position   = new BABYLON.Vector3(xOff, -h2 * 0.34, 0);
                    bot.material   = arrowM;
                    childMesh(bot);
                }
            }

            // ── 💚 Stamina: grünes Kreuz (Gesundheits-Symbol) ────────────────
            else if (pu.type === 'stamina') {
                const crossM = childMat(
                    new BABYLON.Color3(0.08, 0.92, 0.28),
                    new BABYLON.Color3(0.04, 0.50, 0.14));

                // Horizontaler Balken
                const hBar = BABYLON.MeshBuilder.CreateBox('psh_'+pu.id,
                    { width: 1.50, height: 0.44, depth: 0.22 }, scene);
                hBar.material = crossM;
                childMesh(hBar);

                // Vertikaler Balken
                const vBar = BABYLON.MeshBuilder.CreateBox('psv_'+pu.id,
                    { width: 0.44, height: 1.50, depth: 0.22 }, scene);
                vBar.material = crossM;
                childMesh(vBar);

            }

            // ── ⚡ Blitz: leuchtender Blitz-Zickzack ──────────────────────────
            else if (pu.type === 'blitz') {
                const boltM = childMat(
                    new BABYLON.Color3(1.0, 0.96, 0.0),
                    new BABYLON.Color3(0.85, 0.65, 0.0));
                const coreM = childMat(
                    new BABYLON.Color3(1.0, 1.0, 0.6),
                    new BABYLON.Color3(1.0, 0.90, 0.0));

                // Zickzack aus 3 Segmenten (Blitzform)
                const segs = [
                    { x:  0.18, y:  0.58, rot: -0.85 },
                    { x: -0.18, y:  0.00, rot:  0.85 },
                    { x:  0.18, y: -0.58, rot: -0.85 },
                ];
                segs.forEach((s, i) => {
                    const seg = BABYLON.MeshBuilder.CreateBox('pbl_'+i+'_'+pu.id,
                        { width: 0.20, height: 0.68, depth: 0.20 }, scene);
                    seg.rotation.z = s.rot;
                    seg.position.x = s.x;
                    seg.position.y = s.y;
                    seg.material   = boltM;
                    childMesh(seg);
                });

                // Leuchtender Kern in der Mitte
                const core = BABYLON.MeshBuilder.CreateSphere('pbc_'+pu.id,
                    { diameter: 0.42, segments: 5 }, scene);
                core.material = coreM;
                childMesh(core);
            }

            powerupMeshes[pu.id] = root;
        }
    }

    function clearPowerups() {
        for (const root of Object.values(powerupMeshes)) {
            root.getChildMeshes().forEach(m => m.dispose());
            root.dispose();
        }
        Object.keys(powerupMeshes).forEach(k => delete powerupMeshes[k]);
    }

    function removeHorse(id) {
        if (!horses[id]) return;
        const h = horses[id];
        if (h.dustPs)      h.dustPs.dispose();
        if (h.hitPs)       h.hitPs.dispose();
        if (h.turboPs)     h.turboPs.dispose();
        if (h.finishPs)    h.finishPs.dispose();
        if (h.blitzPs)     h.blitzPs.dispose();
        if (h.slipPs)      h.slipPs.dispose();
        if (h.labelPlane)  h.labelPlane.dispose();
        h.root.getChildMeshes().forEach(m => m.dispose());
        h.root.dispose();
        delete horses[id];
    }

    function triggerFinishConfetti() {
        if (!scene) return;
        const fp = _finishWorldPos();
        const emitPos = new BABYLON.Vector3(fp.x, 4, fp.z);

        function _burst(colors1, colors2, delay) {
            setTimeout(() => {
                const ps = new BABYLON.ParticleSystem('confetti_' + delay, 600, scene);
                ps.particleTexture = _particleTex;
                ps.emitter         = emitPos;
                ps.minEmitBox      = new BABYLON.Vector3(-9, 0, -7);
                ps.maxEmitBox      = new BABYLON.Vector3( 9, 3,  7);
                ps.color1          = colors1;
                ps.color2          = colors2;
                ps.colorDead       = new BABYLON.Color4(0.8, 0.7, 0.0, 0.0);
                ps.minSize         = 0.18; ps.maxSize      = 0.60;
                ps.minLifeTime     = 1.8;  ps.maxLifeTime  = 4.0;
                ps.emitRate        = 500;
                ps.direction1      = new BABYLON.Vector3(-7, 10, -6);
                ps.direction2      = new BABYLON.Vector3( 7, 26,  6);
                ps.minEmitPower    = 3;    ps.maxEmitPower = 12;
                ps.gravity         = new BABYLON.Vector3(0, -5, 0);
                ps.blendMode       = BABYLON.ParticleSystem.BLENDMODE_ADD;
                ps.start();
                setTimeout(() => {
                    ps.emitRate = 0;
                    setTimeout(() => ps.dispose(), 5000);
                }, 900);
            }, delay);
        }

        // Erster Burst: rot & blau
        _burst(new BABYLON.Color4(1.0, 0.15, 0.15, 1.0), new BABYLON.Color4(0.2, 0.6, 1.0, 1.0), 0);
        // Zweiter Burst (leicht versetzt): gold & grün
        _burst(new BABYLON.Color4(1.0, 0.90, 0.1, 1.0),  new BABYLON.Color4(0.1, 0.9, 0.3, 1.0), 400);
    }

    // ── Sieger-Kamera: zoomt dramatisch auf die Ziellinie ─────────────────────
    let _victoryMode = false;
    let _victoryObserver = null;

    function triggerVictoryCamera() {
        if (_victoryMode || !scene) return;
        _victoryMode = true;

        // Arc-Kamera auf die Ziellinie richten
        const fp = _finishWorldPos();
        camera.detachControl();
        scene.activeCamera = camera;
        camera.target      = new BABYLON.Vector3(fp.x, 2, fp.z);
        camera.alpha       = Math.PI * 1.35;
        camera.beta        = 0.65;
        camera.radius      = 38;

        let elapsed = 0;
        _victoryObserver = scene.onBeforeRenderObservable.add(() => {
            elapsed += engine.getDeltaTime() / 1000;
            // Langsam reinzoomen + leicht um das Ziel kreisen
            camera.radius = Math.max(18, 38 - elapsed * 4.5);
            camera.alpha += 0.003;
        });
    }

    function triggerBlitzFlash() {
        _shakeEnd       = performance.now() + 500;
        _shakeIntensity = 1.4;
    }

    function resetVictoryCamera() {
        if (!_victoryMode) return;
        _victoryMode = false;
        if (_victoryObserver) {
            scene.onBeforeRenderObservable.remove(_victoryObserver);
            _victoryObserver = null;
        }
        camera.detachControl();
        scene.activeCamera = followCam;
    }

    return { init, setPlayerId, setCameraMode, setWeather, setMap,
             triggerSpectatorWave,
             updateHorse, updateObstacles, clearObstacles,
             updatePowerups, clearPowerups,
             triggerFinishConfetti, triggerVictoryCamera, resetVictoryCamera,
             triggerBlitzFlash,
             removeHorse };
})();
