const Renderer = (() => {
    const TRACK_LENGTH   = 1000;
    const TRACK_A        = 55;
    const TRACK_B        = 28;
    const LANE_OFFSETS   = [-3.5, 0, 3.5];   // innen, mitte, außen
    const TW             = 11;

    let engine, scene, camera, followCam;
    let cameraMode   = 'follow';
    let _shadowGen   = null;
    let _particleTex = null;
    const horses         = {};
    const obstacleMeshes = {};
    const powerupMeshes  = {};
    let _playerId        = null;
    const _flagMeshes    = [];
    const _spectators    = [];       // { body, baseY, z }
    const _waves         = [];       // { z0, dir, startTime }

    // ── Wetter-State ──────────────────────────────────────────────────────────
    let _sun         = null;
    let _amb         = null;
    let _skyMat      = null;
    let _skyDome     = null;
    let _rainPs      = null;
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
        const t  = (progress / TRACK_LENGTH) * Math.PI * 2;
        const cx = Math.cos(t) * TRACK_A;
        const cz = Math.sin(t) * TRACK_B;
        if (laneOffset === 0) return new BABYLON.Vector3(cx, 0, cz);
        // Senkrechte zur Tangente
        const tx  = -Math.sin(t) * TRACK_A;
        const tz  =  Math.cos(t) * TRACK_B;
        const len = Math.sqrt(tx * tx + tz * tz);
        return new BABYLON.Vector3(cx + (tz / len) * laneOffset, 0, cz + (-tx / len) * laneOffset);
    }

    function mat(scene, color) {
        const m = new BABYLON.StandardMaterial('m' + Math.random(), scene);
        m.diffuseColor = color;
        return m;
    }

    function createHorse(scene, bodyColor) {
        const root    = new BABYLON.TransformNode('horse', scene);
        const bodyMat = mat(scene, bodyColor);
        const darkMat = mat(scene, new BABYLON.Color3(bodyColor.r * 0.45, bodyColor.g * 0.35, bodyColor.b * 0.25));
        const hoofMat = mat(scene, new BABYLON.Color3(0.15, 0.1, 0.08));

        function part(name, size, pos, rotX, m) {
            const mesh = BABYLON.MeshBuilder.CreateBox(name, size, scene);
            mesh.position = new BABYLON.Vector3(...pos);
            if (rotX) mesh.rotation.x = rotX;
            mesh.material = m;
            mesh.parent   = root;
            return mesh;
        }

        part('body',   { width: 1.7, height: 1.5, depth: 4.2 }, [0, 2.1,  0],    0,     bodyMat);
        part('neck',   { width: 0.85,height: 1.7, depth: 0.75}, [0, 3.2,  1.6], -0.45,  bodyMat);
        part('head',   { width: 0.8, height: 0.9, depth: 1.4 }, [0, 4.0,  2.55], -0.1,  bodyMat);
        part('snout',  { width: 0.55,height: 0.6, depth: 0.8 }, [0, 3.65, 3.2],   0.2,  bodyMat);
        part('nlL',    { width: 0.12,height: 0.08,depth: 0.08}, [ 0.18, 3.45, 3.52], 0, darkMat);
        part('nlR',    { width: 0.12,height: 0.08,depth: 0.08}, [-0.18, 3.45, 3.52], 0, darkMat);
        part('earL',   { width: 0.18,height: 0.38,depth: 0.14}, [ 0.28, 4.55, 2.3],  0, bodyMat);
        part('earR',   { width: 0.18,height: 0.38,depth: 0.14}, [-0.28, 4.55, 2.3],  0, bodyMat);
        for (let i = 0; i < 5; i++)
            part('mane'+i,{ width:0.15,height:0.55-i*0.05,depth:0.22},[0.4,4.1-i*0.3,2.0-i*0.3],0,darkMat);
        part('tail1',  { width: 0.28,height: 1.1, depth: 0.28}, [0, 2.6, -2.35], -0.55, darkMat);
        part('tail2',  { width: 0.18,height: 0.9, depth: 0.18}, [0, 1.8, -2.85], -0.35, darkMat);

        const legDefs = [
            { n:'FL', x: 0.58, z: 1.3,  phase: 0 },
            { n:'FR', x:-0.58, z: 1.3,  phase: Math.PI },
            { n:'BL', x: 0.58, z:-1.3,  phase: Math.PI },
            { n:'BR', x:-0.58, z:-1.3,  phase: 0 },
        ];
        const legMeshes = [];
        for (const d of legDefs) {
            const upper = BABYLON.MeshBuilder.CreateBox('u'+d.n,{width:0.38,height:0.9,depth:0.38},scene);
            upper.position = new BABYLON.Vector3(d.x, 1.35, d.z);
            upper.material = bodyMat; upper.parent = root;
            const lower = BABYLON.MeshBuilder.CreateBox('l'+d.n,{width:0.3,height:0.85,depth:0.3},scene);
            lower.position = new BABYLON.Vector3(0, -0.85, 0);
            lower.material = bodyMat; lower.parent = upper;
            const hoof = BABYLON.MeshBuilder.CreateBox('h'+d.n,{width:0.35,height:0.22,depth:0.42},scene);
            hoof.position = new BABYLON.Vector3(0, -0.53, 0.06);
            hoof.material = hoofMat; hoof.parent = lower;
            legMeshes.push({ upper, phase: d.phase });
        }

        // Treffanzeige (rote Umrandung)
        const hit = BABYLON.MeshBuilder.CreateBox('hit',{width:2.2,height:3.2,depth:5.2},scene);
        hit.material = mat(scene, new BABYLON.Color3(1,0.1,0.1));
        hit.material.alpha = 0;
        hit.material.wireframe = true;
        hit.position.y = 2.1;
        hit.parent = root;

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

        return { root, legMeshes, hitMesh: hit, dustPs, hitPs };
    }

    function buildTree(x, z, h = 4, s = 1) {
        const trunkH = h * 0.35;
        const topH   = h * 0.85;
        const trunk  = BABYLON.MeshBuilder.CreateCylinder('tr', { height: trunkH, diameter: 0.55 * s, tessellation: 6 }, scene);
        trunk.position = new BABYLON.Vector3(x, trunkH / 2, z);
        trunk.material = mat(scene, new BABYLON.Color3(0.38, 0.22, 0.09));
        const top = BABYLON.MeshBuilder.CreateCylinder('tp', { height: topH, diameterTop: 0, diameterBottom: 3.2 * s, tessellation: 7 }, scene);
        top.position = new BABYLON.Vector3(x, trunkH + topH * 0.35, z);
        top.material = mat(scene, new BABYLON.Color3(0.12 + Math.random()*0.08, 0.42 + Math.random()*0.14, 0.09));
        if (_shadowGen) { _shadowGen.addShadowCaster(trunk); _shadowGen.addShadowCaster(top); }
    }

    function buildTrees() {
        const count = 28;
        for (let i = 0; i < count; i++) {
            const t   = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
            const rx  = TRACK_A + 16 + Math.random() * 20;
            const rz  = TRACK_B + 16 + Math.random() * 20;
            buildTree(Math.cos(t) * rx, Math.sin(t) * rz, 3.5 + Math.random() * 3, 0.8 + Math.random() * 0.5);
        }
        // Innenseite: lockere Bäume
        for (let i = 0; i < 10; i++) {
            const t  = (i / 10) * Math.PI * 2;
            const rx = TRACK_A - 20 - Math.random() * 12;
            const rz = TRACK_B - 10 - Math.random() * 8;
            if (rx > 5 && rz > 5)
                buildTree(Math.cos(t) * rx, Math.sin(t) * rz, 2.5 + Math.random() * 2, 0.7 + Math.random() * 0.4);
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
    }

    function init(canvas) {
        engine = new BABYLON.Engine(canvas, true, { adaptToDeviceRatio: true });
        scene  = new BABYLON.Scene(engine);
        scene.clearColor = new BABYLON.Color4(0.4, 0.65, 0.9, 1);

        // Atmosphärischer Nebel
        scene.fogMode    = BABYLON.Scene.FOGMODE_EXP2;
        scene.fogDensity = 0.004;
        scene.fogColor   = new BABYLON.Color3(0.7, 0.85, 1.0);

        camera = new BABYLON.ArcRotateCamera('cam', -Math.PI/2, 0.7, 130, BABYLON.Vector3.Zero(), scene);
        camera.lowerRadiusLimit = 40; camera.upperRadiusLimit = 250;
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

        // Boden
        const ground = BABYLON.MeshBuilder.CreateGround('ground',{width:340,height:220},scene);
        ground.material       = mat(scene, new BABYLON.Color3(0.22, 0.55, 0.22));
        ground.receiveShadows = true;

        // Strecken-Ribbon
        const inner = [], outer = [];
        for (let i = 0; i <= 128; i++) {
            const t = (i/128)*Math.PI*2;
            inner.push(new BABYLON.Vector3(Math.cos(t)*(TRACK_A-TW/2), 0.06, Math.sin(t)*(TRACK_B-TW/2)));
            outer.push(new BABYLON.Vector3(Math.cos(t)*(TRACK_A+TW/2), 0.06, Math.sin(t)*(TRACK_B+TW/2)));
        }
        const ribbon = BABYLON.MeshBuilder.CreateRibbon('track',{pathArray:[inner,outer],closePath:true},scene);
        ribbon.material = mat(scene, new BABYLON.Color3(0.83, 0.73, 0.53));
        ribbon.material.backFaceCulling = false;
        ribbon.receiveShadows = true;

        // Begrenzungslinien
        for (const path of [inner, outer]) {
            const b = BABYLON.MeshBuilder.CreateTube('border',{path,radius:0.2,tessellation:6},scene);
            b.material = mat(scene, new BABYLON.Color3(1,1,1));
        }

        // Spurtrennlinien (gelb, bei ±1.75 Offset)
        for (const offset of [-1.75, 1.75]) {
            const path = [];
            for (let i = 0; i <= 128; i++) {
                const p = trackPosition(i/128*TRACK_LENGTH, offset);
                path.push(new BABYLON.Vector3(p.x, 0.08, p.z));
            }
            const t = BABYLON.MeshBuilder.CreateTube('lane',{path,radius:0.12,tessellation:4},scene);
            t.material = mat(scene, new BABYLON.Color3(1, 0.95, 0.2));
        }

        // Partikel-Textur initialisieren
        _particleTex = createParticleTex();

        // Ziellinie (leuchtend) — quer zur Fahrtrichtung (X-Richtung)
        for (let i = 0; i < 4; i++) {
            const tile = BABYLON.MeshBuilder.CreateBox('ft'+i,{width:2.5,height:0.18,depth:0.8},scene);
            tile.position = new BABYLON.Vector3(TRACK_A - 3.75 + i*2.5, 0.18, 0);
            const tm = new BABYLON.StandardMaterial('ftm'+i, scene);
            if (i % 2 === 0) {
                tm.diffuseColor  = new BABYLON.Color3(1, 1, 1);
                tm.emissiveColor = new BABYLON.Color3(0.45, 0.45, 0.0);
            } else {
                tm.diffuseColor  = new BABYLON.Color3(0, 0, 0);
                tm.emissiveColor = new BABYLON.Color3(0.05, 0.05, 0.05);
            }
            tile.material = tm;
        }

        // Zieltor — quer zur Fahrtrichtung (Pferd fährt am Ziel in Z, Tor spannt in X)
        const gateH   = 9;          // Pfostenhöhe
        const gateX1  = TRACK_A - TW / 2 - 1.5;   // außen links
        const gateX2  = TRACK_A + TW / 2 + 1.5;   // außen rechts
        const gateMat = () => {
            const m = new BABYLON.StandardMaterial('gm_' + Math.random(), scene);
            m.diffuseColor  = new BABYLON.Color3(1, 0.85, 0);
            m.emissiveColor = new BABYLON.Color3(0.3, 0.25, 0);
            return m;
        };
        for (const gx of [gateX1, gateX2]) {
            const pole = BABYLON.MeshBuilder.CreateCylinder('gp_' + gx,
                { height: gateH, diameter: 0.4, tessellation: 8 }, scene);
            pole.position = new BABYLON.Vector3(gx, gateH / 2, 0);
            pole.material  = gateMat();
        }
        const beam = BABYLON.MeshBuilder.CreateBox('gbeam',
            { width: gateX2 - gateX1 + 0.4, height: 0.45, depth: 0.45 }, scene);
        beam.position = new BABYLON.Vector3(TRACK_A, gateH, 0);
        beam.material  = gateMat();

        // Kulisse
        buildTrees();
        buildStands();
        buildStandsRight();
        buildBarriers();
        buildFlags();
        buildFloodlights();

        // Render-Loop
        scene.registerBeforeRender(() => {
            for (const [id, h] of Object.entries(horses)) {
                let diff = h.targetProgress - h.displayProgress;
                if (diff < -TRACK_LENGTH/2) diff += TRACK_LENGTH;
                if (diff >  TRACK_LENGTH/2) diff -= TRACK_LENGTH;
                h.displayProgress += diff * 0.25;

                h.displayLane += (h.targetLane - h.displayLane) * 0.18;
                const laneOff = -3.5 + h.displayLane * 3.5;

                const pos  = trackPosition(h.displayProgress, laneOff);
                const posY = new BABYLON.Vector3(pos.x, 0.15 + h.jumpHeight, pos.z);
                h.root.position = posY;

                const nxt = trackPosition(h.displayProgress + 8, laneOff);
                h.root.lookAt(new BABYLON.Vector3(nxt.x, 0.15, nxt.z));

                // Beinanimation
                const swing = Math.min(h.speed * 0.06, 0.75);
                const cycle = h.displayProgress * 0.18;
                for (const leg of h.legMeshes) {
                    leg.upper.rotation.x = Math.sin(cycle + leg.phase) * swing;
                }

                // Treffer-Highlight
                if (h.hitMesh) h.hitMesh.material.alpha = h.penalized ? 0.6 : 0;

                // Staub (Tempo-abhängig)
                if (h.dustPs) h.dustPs.emitRate = h.speed > 8 ? Math.min(90, h.speed * 2.2) : 0;

                // Funken-Burst bei Treffer (steigende Flanke)
                if (h.penalized && !h._wasPenalized && h.hitPs) {
                    h.hitPs.emitRate = 500;
                    setTimeout(() => { if (h.hitPs) h.hitPs.emitRate = 0; }, 130);
                }
                h._wasPenalized = h.penalized;

                if (id === _playerId) {
                    if (cameraMode === 'overview') {
                        camera.target = BABYLON.Vector3.Lerp(camera.target, posY, 0.06);
                    } else {
                        // Vorwärtsrichtung des Pferdes in World-Space
                        const fwd = BABYLON.Vector3.TransformNormal(
                            new BABYLON.Vector3(0, 0, 1), h.root.getWorldMatrix()).normalize();
                        const targetCamPos = posY
                            .subtract(fwd.scale(14))
                            .add(new BABYLON.Vector3(0, 6, 0));
                        followCam.position = BABYLON.Vector3.Lerp(followCam.position, targetCamPos, 0.07);
                        const lookAt = posY.add(fwd.scale(8)).add(new BABYLON.Vector3(0, 1, 0));
                        followCam.setTarget(BABYLON.Vector3.Lerp(followCam.target, lookAt, 0.1));
                    }
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
        const SKIN  = [[0.95,0.78,0.62],[0.82,0.61,0.43],[0.55,0.38,0.26],[0.88,0.67,0.48]];
        const SHIRT = [[0.85,0.15,0.15],[0.20,0.45,0.85],[0.15,0.72,0.25],
                       [0.95,0.82,0.10],[0.65,0.18,0.82],[0.92,0.92,0.92]];
        const PANTS = [[0.12,0.12,0.15],[0.15,0.25,0.50],[0.42,0.28,0.18],[0.55,0.55,0.58]];

        const sk = SKIN [( cfg.face  || 0) % SKIN.length];
        const sh = SHIRT[(cfg.shirt  || 0) % SHIRT.length];
        const pa = PANTS[(cfg.pants  || 0) % PANTS.length];

        const skinM  = mat(scene, new BABYLON.Color3(sk[0], sk[1], sk[2]));
        const shirtM = mat(scene, new BABYLON.Color3(sh[0], sh[1], sh[2]));
        const pantsM = mat(scene, new BABYLON.Color3(pa[0], pa[1], pa[2]));
        const bootM  = mat(scene, new BABYLON.Color3(0.18, 0.10, 0.05));
        const helmM  = mat(scene, new BABYLON.Color3(sh[0]*0.55, sh[1]*0.55, sh[2]*0.55));
        const visorM = mat(scene, new BABYLON.Color3(0.07, 0.07, 0.09));

        // Unsichtbarer Root-Mesh (damit dispose() via getChildMeshes() greift)
        const rRoot = BABYLON.MeshBuilder.CreateBox('rider_' + Math.random(), {size:0.01}, scene);
        rRoot.isVisible  = false;
        rRoot.parent     = horseRoot;
        rRoot.position   = new BABYLON.Vector3(0, 3.05, 0.1);
        rRoot.rotation.x = 0.28;    // Jockey lehnt nach vorne

        function rp(sz, pos, m, rx, rz) {
            const mesh = BABYLON.MeshBuilder.CreateBox('rm_' + Math.random(), sz, scene);
            mesh.position = new BABYLON.Vector3(pos[0], pos[1], pos[2]);
            if (rx) mesh.rotation.x = rx;
            if (rz) mesh.rotation.z = rz;
            mesh.material = m;
            mesh.parent   = rRoot;
            if (_shadowGen) _shadowGen.addShadowCaster(mesh);
            return mesh;
        }

        // Torso
        rp({width:0.65, height:0.78, depth:0.42}, [ 0,     0.37,  0    ], shirtM);
        // Kopf
        rp({width:0.50, height:0.50, depth:0.50}, [ 0,     0.96,  0.04 ], skinM);
        // Helm
        rp({width:0.56, height:0.20, depth:0.56}, [ 0,     1.26,  0.04 ], helmM);
        // Visier
        rp({width:0.52, height:0.09, depth:0.08}, [ 0,     1.06,  0.26 ], visorM);
        // Arme (Zügel halten, nach vorne geneigt)
        rp({width:0.20, height:0.44, depth:0.20}, [ 0.43,  0.35,  0.14 ], shirtM, 0.52);
        rp({width:0.20, height:0.44, depth:0.20}, [-0.43,  0.35,  0.14 ], shirtM, 0.52);
        // Hüftblock – verbindet Torso mit Beinen über die Pferdebreite
        rp({width:1.78, height:0.24, depth:0.38}, [ 0,    -0.05,  0    ], pantsM);
        // Oberschenkel (kürzer als vorher)
        rp({width:0.26, height:0.36, depth:0.28}, [ 0.90, -0.26,  0    ], pantsM);
        rp({width:0.26, height:0.36, depth:0.28}, [-0.90, -0.26,  0    ], pantsM);
        // Unterschenkel – leicht nach hinten geneigt (Kniebeuge-Effekt)
        rp({width:0.23, height:0.30, depth:0.23}, [ 0.90, -0.52, -0.08 ], pantsM, -0.30);
        rp({width:0.23, height:0.30, depth:0.23}, [-0.90, -0.52, -0.08 ], pantsM, -0.30);
        // Stiefel (kurz & kompakt)
        rp({width:0.27, height:0.15, depth:0.34}, [ 0.90, -0.70, -0.06 ], bootM);
        rp({width:0.27, height:0.15, depth:0.34}, [-0.90, -0.70, -0.06 ], bootM);
    }

    // ── Name-Label als Billboard über dem Pferd ───────────────────────────────
    function _createLabel(name, isPlayer, horseType) {
        const ICONS = { blitz: '⚡', sturm: '🌪', nebel: '🌫', feuer: '🔥' };
        const icon  = ICONS[horseType] || '🐴';
        const label = (icon + ' ' + (name || '?')).slice(0, 18);

        const W = 320, H = 68;
        const plane = BABYLON.MeshBuilder.CreatePlane('lbl_' + name,
            { width: 6.0, height: 1.28 }, scene);
        plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        plane.isPickable    = false;
        plane.position.y    = 6.6;

        const tex = new BABYLON.DynamicTexture('lbtex_' + name,
            { width: W, height: H }, scene, false);
        tex.hasAlpha = true;

        const ctx2d = tex.getContext();
        ctx2d.clearRect(0, 0, W, H);

        // Hintergrund-Pill (dunkler für Spieler, leicht getönt)
        ctx2d.fillStyle = isPlayer ? 'rgba(30,18,0,0.88)' : 'rgba(0,0,0,0.75)';
        const [rx, ry, rw, rh, rr] = [3, 3, W - 6, H - 6, 13];
        ctx2d.beginPath();
        ctx2d.moveTo(rx + rr, ry);
        ctx2d.lineTo(rx + rw - rr, ry);       ctx2d.quadraticCurveTo(rx + rw, ry,      rx + rw, ry + rr);
        ctx2d.lineTo(rx + rw, ry + rh - rr);  ctx2d.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rr, ry + rh);
        ctx2d.lineTo(rx + rr, ry + rh);       ctx2d.quadraticCurveTo(rx,      ry + rh, rx,      ry + rh - rr);
        ctx2d.lineTo(rx, ry + rr);             ctx2d.quadraticCurveTo(rx,      ry,      rx + rr, ry);
        ctx2d.closePath();
        ctx2d.fill();

        // Goldener Rahmen für den eigenen Spieler
        if (isPlayer) {
            ctx2d.strokeStyle = '#ffd700';
            ctx2d.lineWidth   = 2.5;
            ctx2d.beginPath();
            ctx2d.moveTo(rx + rr, ry);
            ctx2d.lineTo(rx + rw - rr, ry);       ctx2d.quadraticCurveTo(rx + rw, ry,      rx + rw, ry + rr);
            ctx2d.lineTo(rx + rw, ry + rh - rr);  ctx2d.quadraticCurveTo(rx + rw, ry + rh, rx + rw - rr, ry + rh);
            ctx2d.lineTo(rx + rr, ry + rh);       ctx2d.quadraticCurveTo(rx,      ry + rh, rx,      ry + rh - rr);
            ctx2d.lineTo(rx, ry + rr);             ctx2d.quadraticCurveTo(rx,      ry,      rx + rr, ry);
            ctx2d.closePath();
            ctx2d.stroke();
        }

        // Name + Icon
        ctx2d.font        = 'bold 28px Arial, sans-serif';
        ctx2d.textAlign   = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.shadowColor = 'rgba(0,0,0,0.9)';
        ctx2d.shadowBlur  = 7;
        ctx2d.fillStyle   = isPlayer ? '#ffd700' : '#ffffff';
        ctx2d.fillText(label, W / 2, H / 2 + 2);
        tex.update();

        const lm = new BABYLON.StandardMaterial('lbmat_' + name, scene);
        lm.diffuseTexture  = tex;
        lm.emissiveTexture = tex;
        lm.useAlphaFromDiffuseTexture = true;
        lm.disableLighting = true;
        lm.backFaceCulling = false;
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
        }
    }

    function updateHorse(id, progress, speed, lane, jumpHeight, penalized, isPlayer, rgbArr, name, riderCfg, horseType) {
        if (!horses[id]) {
            const color = rgbArr
                ? new BABYLON.Color3(rgbArr[0], rgbArr[1], rgbArr[2])
                : isPlayer
                    ? new BABYLON.Color3(0.85, 0.55, 0.15)
                    : new BABYLON.Color3(0.3+Math.random()*0.5, 0.2+Math.random()*0.3, 0.1+Math.random()*0.4);
            const { root, legMeshes, hitMesh } = createHorse(scene, color);
            createRider(root, riderCfg || { face:0, shirt:0, pants:0 });
            const labelPlane = _createLabel(name || '?', isPlayer, horseType);
            labelPlane.parent = root;
            horses[id] = { root, legMeshes, hitMesh, labelPlane, displayProgress: progress, targetProgress: progress,
                speed: 0, displayLane: lane, targetLane: lane, jumpHeight: 0, penalized: false };
        }
        const h = horses[id];
        h.targetProgress = progress;
        h.speed          = speed;
        h.targetLane     = lane;
        h.jumpHeight     = jumpHeight;
        h.penalized      = penalized;
    }

    function updateObstacles(list) {
        if (!list || list.length === 0) return;
        for (const obs of list) {

            // ── Schiebebande (bewegt sich seitlich) ──────────────────────────
            if (obs.type === 'slider') {
                const laneIdx = obs.laneFloat !== undefined ? obs.laneFloat : obs.lane;
                const laneOff = -3.5 + Math.max(0, Math.min(2, laneIdx)) * 3.5;
                const pos     = trackPosition(obs.progress, laneOff);

                if (obstacleMeshes[obs.id]) {
                    // Position jedes Frame aktualisieren
                    obstacleMeshes[obs.id].position.x = pos.x;
                    obstacleMeshes[obs.id].position.z = pos.z;
                } else {
                    // Einmalig erstellen: Orientierung aus der Streckenmitte
                    const cNxt = trackPosition(obs.progress + 5, 0);
                    const mesh = BABYLON.MeshBuilder.CreateBox('obs'+obs.id,
                        { width: 4.6, height: 2.3, depth: 0.55 }, scene);
                    mesh.position = new BABYLON.Vector3(pos.x, 1.4, pos.z);
                    mesh.lookAt(new BABYLON.Vector3(cNxt.x, 1.4, cNxt.z));
                    const m = new BABYLON.StandardMaterial('obsm'+obs.id, scene);
                    m.diffuseColor  = new BABYLON.Color3(1.0, 0.28, 0.0);
                    m.emissiveColor = new BABYLON.Color3(0.30, 0.06, 0.0);
                    mesh.material   = m;
                    mesh.receiveShadows = true;
                    if (_shadowGen) _shadowGen.addShadowCaster(mesh);
                    obstacleMeshes[obs.id] = mesh;
                }
                continue;
            }

            // ── Statische Hindernisse (Kegel, Hürde) ─────────────────────────
            if (obstacleMeshes[obs.id]) continue;
            const laneOff = obs.lane === -1 ? 0 : LANE_OFFSETS[obs.lane];
            const pos     = trackPosition(obs.progress, laneOff);
            const nxt     = trackPosition(obs.progress + 5, laneOff);

            let mesh;
            if (obs.type === 'hurdle') {
                mesh = BABYLON.MeshBuilder.CreateBox('obs'+obs.id, {width:11,height:1.8,depth:0.5}, scene);
                mesh.material = mat(scene, new BABYLON.Color3(1, 0.15, 0.15));
            } else {
                mesh = BABYLON.MeshBuilder.CreateCylinder('obs'+obs.id,
                    {diameterTop:0, diameterBottom:1.3, height:1.8, tessellation:8}, scene);
                mesh.material = mat(scene, new BABYLON.Color3(1, 0.55, 0.05));
            }
            mesh.position = new BABYLON.Vector3(pos.x, 1.2, pos.z);
            mesh.lookAt(new BABYLON.Vector3(nxt.x, 1.2, nxt.z));
            mesh.receiveShadows = true;
            if (_shadowGen) _shadowGen.addShadowCaster(mesh);
            obstacleMeshes[obs.id] = mesh;
        }
    }

    function clearObstacles() {
        for (const m of Object.values(obstacleMeshes)) m.dispose();
        Object.keys(obstacleMeshes).forEach(k => delete obstacleMeshes[k]);
    }

    function updatePowerups(list) {
        if (!list) return;

        // Farben werden hier (lazy) erstellt, wenn BABYLON garantiert bereit ist
        const PU_RGB = {
            stamina: [0.1, 1.0, 0.3],
            turbo:   [1.0, 0.85, 0.0],
            shield:  [0.2, 0.55, 1.0],
        };

        // Aufgesammelte entfernen
        const activeIds = new Set(list.map(p => p.id));
        for (const id of Object.keys(powerupMeshes)) {
            if (!activeIds.has(id)) {
                powerupMeshes[id].dispose();
                delete powerupMeshes[id];
            }
        }

        // Neue hinzufügen
        for (const pu of list) {
            if (powerupMeshes[pu.id]) continue;

            const laneOff = LANE_OFFSETS[pu.lane] !== undefined ? LANE_OFFSETS[pu.lane] : 0;
            const pos     = trackPosition(pu.progress, laneOff);
            const rgb     = PU_RGB[pu.type] || [1, 1, 1];
            const color   = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);

            const sphere = BABYLON.MeshBuilder.CreateSphere(
                'pu_' + pu.id, { diameter: 1.6, segments: 8 }, scene);
            sphere.position = new BABYLON.Vector3(pos.x, 1.8, pos.z);
            sphere._phase   = pu.progress * 0.05;

            const m = new BABYLON.StandardMaterial('pum_' + pu.id, scene);
            m.diffuseColor  = color;
            m.emissiveColor = new BABYLON.Color3(rgb[0] * 0.5, rgb[1] * 0.5, rgb[2] * 0.5);
            sphere.material = m;

            powerupMeshes[pu.id] = sphere;
        }
    }

    function clearPowerups() {
        for (const m of Object.values(powerupMeshes)) m.dispose();
        Object.keys(powerupMeshes).forEach(k => delete powerupMeshes[k]);
    }

    function removeHorse(id) {
        if (!horses[id]) return;
        const h = horses[id];
        if (h.dustPs)     h.dustPs.dispose();
        if (h.hitPs)      h.hitPs.dispose();
        if (h.labelPlane) h.labelPlane.dispose();
        h.root.getChildMeshes().forEach(m => m.dispose());
        h.root.dispose();
        delete horses[id];
    }

    function triggerFinishConfetti() {
        if (!scene) return;
        const emitPos = new BABYLON.Vector3(TRACK_A, 4, 0);

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
        camera.detachControl();
        scene.activeCamera = camera;
        camera.target      = new BABYLON.Vector3(TRACK_A, 2, 0);
        camera.alpha       = Math.PI * 1.35;   // leicht seitlich von vorne
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

    return { init, setPlayerId, setCameraMode, setWeather,
             triggerSpectatorWave,
             updateHorse, updateObstacles, clearObstacles,
             updatePowerups, clearPowerups,
             triggerFinishConfetti, triggerVictoryCamera, resetVictoryCamera,
             removeHorse };
})();
