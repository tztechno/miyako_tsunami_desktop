import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { toPlane } from './proj.js';
import { sourceZoneCenter, entryPath } from './tsunamiSim.js';

const PIN_SCREEN_SCALE = 0.006; // pin height ≈ 18px regardless of zoom

// Water palette (sRGB → linear handled by THREE.Color)
const C_SEA_DEEP = new THREE.Color('#0a3150');
const C_SEA_RISE = new THREE.Color('#2f8fa6');
const C_SEA_LOW = new THREE.Color('#061c2e');
const C_FLOOD = new THREE.Color('#8c7a5a'); // muddy overland tsunami water
const C_FLOOD_DEEP = new THREE.Color('#4f4636');
const C_FOAM = new THREE.Color('#f2f6f5');
// Inundation-depth classes and colours of the national standard legend
// (same as 重ねるハザードマップ 津波浸水想定), so the simulation can be compared with the hazard map.
export const DEPTH_LEGEND = [
  { max: 0.3, color: '#ffffb3', label: '〜0.3m' },
  { max: 0.5, color: '#f7f5a9', label: '0.3〜0.5m' },
  { max: 1, color: '#f8e1a6', label: '0.5〜1m' },
  { max: 3, color: '#ffd8c0', label: '1〜3m' },
  { max: 5, color: '#ffb7b7', label: '3〜5m' },
  { max: 10, color: '#ff9191', label: '5〜10m' },
  { max: 20, color: '#f285c9', label: '10〜20m' },
  { max: Infinity, color: '#dc7adc', label: '20m〜' },
];
const HAZARD = DEPTH_LEGEND.map((c) => [c.max, new THREE.Color(c.color)]);

// Match map: simulation vs 2011 actual inundation (5 m mesh)
const MATCH_COLORS = {
  hit: new THREE.Color('#66bb6a'), // flooded in both
  miss: new THREE.Color('#29b6f6'), // flooded in 2011, not in the simulation
  false: new THREE.Color('#ff7043'), // flooded only in the simulation
};

// 2011 survey marker colours (simulated max water level − measured)
const SURVEY_COLORS = {
  none: new THREE.Color('#ffffff'), // simulation not run yet
  miss: new THREE.Color('#9e9e9e'), // simulated water never reached the point
  low: new THREE.Color('#29b6f6'), // simulation lower by > 2 m
  ok: new THREE.Color('#66bb6a'), // within ±2 m
  high: new THREE.Color('#ff7043'), // simulation higher by > 2 m
};

export class TsunamiScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.seaLevel = 0; // still-water (tide) level; the sea is coloured by the anomaly above it
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0d1b2a');
    this.scene.fog = new THREE.FogExp2('#0d1b2a', 0.00012);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
      logarithmicDepthBuffer: true, // lets the camera get close to the ground without z-fighting
    });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 1, 80000);
    this.camera.position.set(0, 1500, 2200);

    this.setupLights();
    this.setupControls();

    this.groundMesh = null;
    this.outerMesh = null;
    this.waterMesh = null;
    this.buildingsMesh = null;
    this.pinMesh = null;

    this.showHazardColors = false;
    this.showMaxDepth = false;
    this.showMatch = false; // simulation vs 2011 5 m mesh
    this.actual5 = null; // Uint16 cm per water-grid vertex (65535 = no data)
    this.overlays = {}; // key -> mesh draped on the terrain (hazard map, 2011 inundation)
    this.surveyGroup = null;
    this.sourceZoneGroup = null;
    this.buildingFocus = { enabled: true, radius: 2000, x: 0, z: 0 };
    this.viewLocked = false;
    this.fly = null;

    // Rotation-centre marker shown after a double-click
    this.focusMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.85, depthTest: false })
    );
    this.focusMarker.renderOrder = 10;
    this.focusMarker.visible = false;
    this.scene.add(this.focusMarker);
  }

  /** Terrain height at local (x, z), used for picking and keeping the camera above ground. */
  surfaceAt(x, z) {
    const g = this.terrain;
    if (!g) return 0;
    const i = Math.floor((x + g.W / 2) / g.res);
    const j = Math.floor((z + g.H / 2) / g.res);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return 0;
    const h = g.ground[j * g.nx + i];
    return Number.isNaN(h) ? 0 : h;
  }

  /** Ray-march from the camera to the terrain (fast; no triangle raycast over 640k faces). */
  pickSurface(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    const step = (this.terrain?.res || 5) * 0.5;
    let prev = 0;
    for (let s = 0; s < this.camera.far; s += step * (1 + s / 2000)) {
      if (o.y + d.y * s <= this.surfaceAt(o.x + d.x * s, o.z + d.z * s)) {
        let a = prev, b = s;
        for (let k = 0; k < 20; k++) {
          const m = (a + b) / 2;
          if (o.y + d.y * m <= this.surfaceAt(o.x + d.x * m, o.z + d.z * m)) b = m;
          else a = m;
        }
        return new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
      }
      prev = s;
    }
    return null;
  }

  /** Double-click: fly so that `p` becomes the centre of rotation / zoom. */
  flyTo(p, maxDist = 600, seconds = 0.9) {
    const off = this.camera.position.clone().sub(this.target);
    off.setLength(Math.min(off.length(), maxDist));
    this.fly = { t: 0, dur: seconds, fromT: this.target.clone(), toT: p.clone(), fromC: this.camera.position.clone(), toC: p.clone().add(off) };
    this.focusMarker.visible = true;
  }

  setViewLocked(locked) {
    this.viewLocked = locked;
    const c = this.controls;
    if (locked) {
      // drop pending inertia so the view stays exactly where it is
      c._sphericalDelta?.set(0, 0, 0);
      c._panOffset?.set(0, 0, 0);
      if ('_scale' in c) c._scale = 1;
    }
    c.enabled = !locked;
  }

  setupLights() {
    this.scene.add(new THREE.AmbientLight('#ffffff', 0.85));
    const sun = new THREE.DirectionalLight('#fff8e7', 1.8);
    sun.position.set(2000, 4000, 2000);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 100;
    sun.shadow.camera.far = 15000;
    const d = 2500;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    this.scene.add(sun);
    this.sun = sun;
  }

  /**
   * Free camera: left-drag = rotate, right-drag = pan along the ground, wheel = zoom toward cursor,
   * W/A/S/D = move, Q/E = down/up, Shift = faster.
   */
  setupControls() {
    const c = new OrbitControls(this.camera, this.canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.screenSpacePanning = false;
    c.zoomToCursor = true;
    c.minDistance = 3;
    c.maxDistance = 40000;
    c.maxPolarAngle = Math.PI * 0.497;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls = c;
    this.target = c.target;

    this.keys = new Set();
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.lastKeyTime = performance.now();
  }

  applyKeyboard() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastKeyTime) / 1000);
    this.lastKeyTime = now;
    if (this.keys.size === 0 || this.viewLocked) return;

    const dist = this.camera.position.distanceTo(this.target);
    const speed = Math.max(20, dist * 0.6) * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1) * dt;
    const fwd = this.camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(fwd);
    if (this.keys.has('KeyS')) move.sub(fwd);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('KeyE')) move.y += 1;
    if (this.keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(speed);
    this.camera.position.add(move);
    this.target.add(move);
  }

  getCameraPose() {
    return { pos: this.camera.position.clone(), target: this.target.clone() };
  }

  setCameraPose(pos, target) {
    this.camera.position.copy(pos);
    this.target.copy(target);
    this.camera.lookAt(target);
  }

  setCameraView(type) {
    const W = this.terrain?.W || 4000;
    const isMiyako = this.terrain?.name === 'miyako_port';
    // Town/port center: near originE + 2900m for Miyako, originE + 2000m for Taro
    const townX = -W / 2 + (isMiyako ? 2900 : 2000);
    const townZ = this.townZ();
    const t = new THREE.Vector3(townX, 10, townZ);
    let p = new THREE.Vector3(townX + 1500, 1500, townZ + 2200);

    if (type === 'viewBird') {
      // Whole area bird-eye view from above the bay (shows coastal town and offshore wave source)
      p.set(500, Math.max(3400, W * 0.46), Math.max(3000, W * 0.40));
      t.set(500, 0, 0);
    } else if (type === 'viewCoast') {
      // Near-offshore looking west at the town and historic seawall
      p.set(townX + 1600, 320, townZ + 650);
      t.set(townX + 100, 10, townZ - 50);
    } else if (type === 'viewTown') {
      // Close-up on the town and seawall
      p.set(townX - 450, 220, townZ + 420);
      t.set(townX + 150, 20, townZ - 50);
    } else if (type === 'viewOffshore') {
      // Behind offshore wave source zone (X ~ W/2) looking west toward the coast
      p.set(W / 2 + 350, 1100, townZ + 1200);
      t.set(townX + 500, 30, townZ);
    } else if (type === 'viewSource') {
      if (this.csvSourceXZ) {
        // Wave CSV point (often ~20 km offshore): look out to it from behind the region, region in the foreground
        const { x, z } = this.csvSourceXZ;
        const d = Math.hypot(x, z) || 1;
        t.set(x * 0.45, 0, z * 0.45);
        p.set((-x / d) * 3500, 3000, (-z / d) * 3500);
      } else if (isMiyako) {
        // Miyako Bay northern entrance (deep sea entrance off Omoe peninsula)
        p.set(2150, 520, -2300);
        t.set(1450, 15, -1750);
      } else {
        const srcX = W / 2 - 250;
        p.set(srcX + 750, 480, townZ + 600);
        t.set(srcX, 15, townZ);
      }
    } else if (type === 'viewBackdrop') {
      p.set(2500, 6000, 7000);
      t.set(0, 0, 0);
    }
    this.animateCameraTo(p, t);
  }

  /**
   * Scene z of the town (Taro: the seawall, plane N ≈ -28600 m; Miyako Port: the region centre), so the
   * camera presets follow it when the region's north-south extent changes.
   */
  townZ() {
    const t = this.terrain;
    if (!t || t.name === 'miyako_port' || t.originN == null) return 0;
    return t.originN + 28600 - t.H / 2;
  }

  animateCameraTo(targetPos, targetLookAt, seconds = 1.0) {
    this.fly = { t: 0, dur: seconds, fromT: this.target.clone(), toT: targetLookAt.clone(), fromC: this.camera.position.clone(), toC: targetPos.clone() };
  }

  disposeMesh(mesh) {
    if (!mesh) return;
    this.scene.remove(mesh);
    if (!mesh.userData.sharedGeometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      m.map?.dispose();
      m.dispose();
    }
  }

  /**
   * The source zone marks where a wave from a distant earthquake enters the region (not the epicentre).
   * sourceWidthM: length of the zone along the wave crest (null = the default size).
   */
  buildSourceZone(meta, waveDirectionDeg = 90, sourceWidthM = null) {
    if (this.sourceZoneGroup) {
      this.scene.remove(this.sourceZoneGroup);
      this.sourceZoneGroup.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      this.sourceZoneGroup = null;
      this.sourceRotGroup = null;
    }

    const { nx, ny, res } = meta;
    const W = nx * res;
    const H = ny * res;
    const isMiyako = meta.name === 'miyako_port';
    const townX = -W / 2 + (isMiyako ? 2900 : 2000);
    const rootGroup = new THREE.Group();

    // Wave source position:
    // - Taro: East offshore deep sea (W/2 - 250, Z=0)
    // - Miyako Port: Miyako Bay entrance (X=1450, Z=-1750) - placed in deep water at bay mouth,
    //   avoiding the mountainous Omoe Peninsula to the east, aligned with tsunami from Taro offshore/epicenter.
    const { x: pivotX, z: pivotZ } = sourceZoneCenter(meta);

    // Rotatable group containing source zone frame, plane, beacons, buoy and direction arrow
    const rotGroup = new THREE.Group();
    rotGroup.position.set(pivotX, 0, pivotZ);

    const zoneW = isMiyako ? 380 : Math.min(500, W * 0.08);
    const zoneH = sourceWidthM > 0 ? sourceWidthM : isMiyako ? 1700 : H - 100;
    const halfW = zoneW / 2;
    const halfH = zoneH / 2;
    const yTop = 8.0;
    const yBase = -1.0;

    // 1. Red bounding box lines around source zone (centered at 0, 0 in rotGroup)
    const linePositions = [
      // Bottom rect
      -halfW, yBase, -halfH,  halfW, yBase, -halfH,
       halfW, yBase, -halfH,  halfW, yBase,  halfH,
       halfW, yBase,  halfH, -halfW, yBase,  halfH,
      -halfW, yBase,  halfH, -halfW, yBase, -halfH,
      // Top rect
      -halfW, yTop,  -halfH,  halfW, yTop,  -halfH,
       halfW, yTop,  -halfH,  halfW, yTop,   halfH,
       halfW, yTop,   halfH, -halfW, yTop,   halfH,
      -halfW, yTop,   halfH, -halfW, yTop,  -halfH,
      // Vertical corner pillars
      -halfW, yBase, -halfH, -halfW, 60, -halfH,
       halfW, yBase, -halfH,  halfW, 60, -halfH,
       halfW, yBase,  halfH,  halfW, 60,  halfH,
      -halfW, yBase,  halfH, -halfW, 60,  halfH,
    ];
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0xff1744, transparent: true, opacity: 0.95 });
    rotGroup.add(new THREE.LineSegments(lineGeom, lineMat));

    // 2. Translucent red fill over source sea area
    const planeGeom = new THREE.PlaneGeometry(zoneW, zoneH);
    planeGeom.rotateX(-Math.PI / 2);
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0xff1744,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const zonePlane = new THREE.Mesh(planeGeom, planeMat);
    zonePlane.position.y = 0.6;
    rotGroup.add(zonePlane);

    // 3. Corner beacon spheres
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff5252 });
    const beaconGeom = new THREE.SphereGeometry(10, 12, 8);
    [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].forEach(([bx, bz]) => {
      const b = new THREE.Mesh(beaconGeom, beaconMat);
      b.position.set(bx, 60, bz);
      rotGroup.add(b);
    });

    // 4. Large 3D Direction Arrow pointing in propagation direction toward the coast
    const arrowGroup = new THREE.Group();
    const shaftLen = 450;
    const shaftRadius = 6;
    const shaftGeom = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLen, 12);
    shaftGeom.rotateZ(Math.PI / 2);
    shaftGeom.translate(-shaftLen / 2 - halfW, 14, 0);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0x00e5ff,
      emissive: 0x00b0ff,
      emissiveIntensity: 0.6,
      roughness: 0.25,
    });
    const shaft = new THREE.Mesh(shaftGeom, shaftMat);

    const headLen = 120;
    const headRadius = 28;
    const headGeom = new THREE.ConeGeometry(headRadius, headLen, 16);
    headGeom.rotateZ(-Math.PI / 2);
    headGeom.translate(-shaftLen - halfW - headLen / 2, 14, 0);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xffeb3b,
      emissive: 0xffd600,
      emissiveIntensity: 0.7,
      roughness: 0.2,
    });
    const head = new THREE.Mesh(headGeom, headMat);
    arrowGroup.add(shaft, head);
    rotGroup.add(arrowGroup);

    // 5. Offshore observation buoy at center of rotGroup
    const buoyGroup = new THREE.Group();
    const buoyBody = new THREE.Mesh(
      new THREE.CylinderGeometry(16, 20, 18, 16),
      new THREE.MeshStandardMaterial({ color: 0xff9100, roughness: 0.35, metalness: 0.2 })
    );
    buoyBody.position.y = 9;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 1.8, 35, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 })
    );
    mast.position.y = 32;
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(5, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff })
    );
    light.position.y = 52;
    buoyGroup.add(buoyBody, mast, light);
    buoyGroup.position.set(0, 0, 0);
    rotGroup.add(buoyGroup);

    // Apply initial rotation matching waveDirectionDeg
    const rad = -((waveDirectionDeg - 90) * Math.PI) / 180;
    rotGroup.rotation.y = rad;
    this.sourceRotGroup = rotGroup;
    rootGroup.add(rotGroup);

    // 6. Coastal monitoring buoy in front of seawall (fixed in coastal bay)
    const coastalBuoy = new THREE.Group();
    const cBody = new THREE.Mesh(
      new THREE.CylinderGeometry(12, 14, 14, 16),
      new THREE.MeshStandardMaterial({ color: 0x00e5ff, roughness: 0.35, metalness: 0.2 })
    );
    cBody.position.y = 7;
    const cMast = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 1.4, 24, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 })
    );
    cMast.position.y = 23;
    const cLight = new THREE.Mesh(
      new THREE.SphereGeometry(4, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x76ff03 })
    );
    cLight.position.y = 37;
    coastalBuoy.add(cBody, cMast, cLight);
    coastalBuoy.position.set(townX + (isMiyako ? 350 : 450), 0, isMiyako ? 50 : this.townZ());
    rootGroup.add(coastalBuoy);

    rootGroup.renderOrder = 4;
    this.sourceZoneGroup = rootGroup;
    this.scene.add(rootGroup);
  }

  updateSourceZoneDirection(deg) {
    if (!this.sourceRotGroup) return;
    const rad = -((deg - 90) * Math.PI) / 180;
    this.sourceRotGroup.rotation.y = rad;
  }

  setSourceZoneVisible(v) {
    if (this.sourceZoneGroup) this.sourceZoneGroup.visible = v;
    if (this.csvSourceGroup) this.csvSourceGroup.visible = v;
  }

  /** Scene position (x, z) of a lon/lat relative to the region centre. */
  lonLatToScene(meta, lon, lat) {
    const [e, n] = toPlane(lon, lat);
    return { x: e - meta.originE - (meta.nx * meta.res) / 2, z: meta.originN - n - (meta.ny * meta.res) / 2 };
  }

  /**
   * Marker at the point where a wave CSV was sampled (e.g. nankai_trough "Lon/Lat" header), usually outside
   * the computed region, with a dashed line along the route to where the wave enters the region (entryPath).
   * Drawn without fog so it stays visible ~20 km away.
   */
  setCsvSource(meta, profile) {
    if (this.csvSourceGroup) {
      this.scene.remove(this.csvSourceGroup);
      this.csvSourceGroup.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      this.csvSourceGroup = null;
      this.csvSourceXZ = null;
    }
    if (!meta || !profile || profile.lon == null || profile.lat == null) return;

    const { x, z } = this.lonLatToScene(meta, profile.lon, profile.lat);
    const path = entryPath(meta, x, z).pts;
    const group = new THREE.Group();

    const pillarH = 1200;
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(35, 35, pillarH, 16),
      new THREE.MeshBasicMaterial({ color: 0xff1744, transparent: true, opacity: 0.85, fog: false })
    );
    pillar.position.set(x, pillarH / 2, z);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(400, 520, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, fog: false })
    );
    ring.position.set(x, 2, z);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(path.map((p) => new THREE.Vector3(p.x, 20, p.z))),
      new THREE.LineDashedMaterial({ color: 0xffeb3b, dashSize: 300, gapSize: 200, fog: false })
    );
    line.computeLineDistances();
    group.add(pillar, ring, line);
    group.renderOrder = 5;
    group.visible = this.sourceZoneGroup ? this.sourceZoneGroup.visible : true;
    this.csvSourceGroup = group;
    this.csvSourceXZ = { x, z };
    this.scene.add(group);
  }

  async loadTexture(url) {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  async buildTerrain(meta, groundF32, aerialUrl) {
    this.disposeMesh(this.groundMesh);
    const { nx, ny, res } = meta;
    const geom = new THREE.PlaneGeometry(nx * res, ny * res, nx - 1, ny - 1);
    geom.rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    for (let v = 0; v < nx * ny; v++) {
      const h = groundF32[v];
      pos.setY(v, Number.isNaN(h) ? -20 : h);
    }
    geom.computeVertexNormals();

    this.terrain = { name: meta.name, nx, ny, res, W: nx * res, H: ny * res, originN: meta.originN, ground: groundF32 };
    const mat = new THREE.MeshStandardMaterial({ map: await this.loadTexture(aerialUrl), roughness: 0.85, metalness: 0.05 });
    this.groundMesh = new THREE.Mesh(geom, mat);
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);
  }

  async buildOuterBackdrop(meta, groundF32, aerialUrl, innerMeta) {
    this.disposeMesh(this.outerMesh);
    const { nx, ny, res } = meta;
    const W = nx * res;
    const H = ny * res;
    const geom = new THREE.PlaneGeometry(W, H, nx - 1, ny - 1);
    geom.rotateX(-Math.PI / 2);

    const innerCenterX = innerMeta.originE + (innerMeta.nx * innerMeta.res) / 2;
    const innerCenterN = innerMeta.originN - (innerMeta.ny * innerMeta.res) / 2;
    const offX = meta.originE + W / 2 - innerCenterX;
    const offZ = innerCenterN - (meta.originN - H / 2);

    const pos = geom.attributes.position;
    for (let v = 0; v < nx * ny; v++) {
      const h = groundF32[v];
      pos.setY(v, Number.isNaN(h) ? -20 : h - 1.0);
    }
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ map: await this.loadTexture(aerialUrl), roughness: 0.9, metalness: 0.02 });
    this.outerMesh = new THREE.Mesh(geom, mat);
    this.outerMesh.position.set(offX, 0, offZ);
    this.outerMesh.receiveShadow = true;
    this.scene.add(this.outerMesh);
  }

  buildWaterMesh(meta, renderStep) {
    this.disposeMesh(this.waterMesh);
    const { nx, ny, res } = meta;
    this.nx = nx;
    this.waterStep = renderStep;
    this.wnx = Math.floor(nx / renderStep);
    this.wny = Math.floor(ny / renderStep);
    // Vertex spacing must match the sampled sim cells (i * step * res)
    const W = (this.wnx - 1) * renderStep * res;
    const H = (this.wny - 1) * renderStep * res;
    const geom = new THREE.PlaneGeometry(W, H, this.wnx - 1, this.wny - 1);
    geom.rotateX(-Math.PI / 2);
    geom.translate(W / 2 - (nx * res) / 2, 0, H / 2 - (ny * res) / 2);
    geom.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(this.wnx * this.wny * 3), 3));
    geom.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geom.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    geom.attributes.color.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.25,
      metalness: 0.15,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    });
    this.waterMesh = new THREE.Mesh(geom, mat);
    this.waterMesh.position.y = 0.05;
    this.scene.add(this.waterMesh);
  }

  /** Update water surface from a worker frame (downsampled eta/depth/foam). */
  updateWater(frame, ground) {
    if (!this.waterMesh || !frame) return;
    const geom = this.waterMesh.geometry;
    const P = geom.attributes.position.array;
    const C = geom.attributes.color.array;
    const Nrm = geom.attributes.normal.array;
    const { nx, waterStep: step, wnx, wny } = this;
    const { eta, depth, foam, maxDepth } = frame;
    const c = new THREE.Color();

    for (let j = 0; j < wny; j++) {
      const sy = j * step;
      for (let i = 0; i < wnx; i++) {
        const v = j * wnx + i;
        const zb = ground[sy * nx + i * step];
        const d = depth[v];
        if (this.showMatch && this.actual5 && zb >= 0) {
          const a = this.actual5[v];
          const simWet = maxDepth[v] >= 0.1;
          const actWet = a !== 65535 && a > 0;
          const mc = simWet && actWet ? MATCH_COLORS.hit : actWet ? MATCH_COLORS.miss : simWet && a !== 65535 ? MATCH_COLORS.false : null;
          if (!mc) {
            P[v * 3 + 1] = zb - 2.0;
          } else {
            P[v * 3 + 1] = zb + 0.4;
            C[v * 3] = mc.r; C[v * 3 + 1] = mc.g; C[v * 3 + 2] = mc.b;
          }
          continue;
        }
        if (this.showMaxDepth && zb >= 0) {
          const md = maxDepth[v];
          if (md < 0.05) {
            P[v * 3 + 1] = zb - 2.0;
          } else {
            P[v * 3 + 1] = zb + 0.4;
            c.copy(HAZARD.find(([lim]) => md < lim)[1]);
            C[v * 3] = c.r; C[v * 3 + 1] = c.g; C[v * 3 + 2] = c.b;
          }
          continue;
        }
        if (d < 0.05) {
          P[v * 3 + 1] = zb - 2.0; // hide below ground / seabed
          C[v * 3] = C_FLOOD.r; C[v * 3 + 1] = C_FLOOD.g; C[v * 3 + 2] = C_FLOOD.b;
          continue;
        }
        P[v * 3 + 1] = eta[v];
        const onLand = zb >= 0;
        if (this.showHazardColors && onLand) {
          c.copy(HAZARD.find(([lim]) => d < lim)[1]);
        } else if (onLand) {
          c.lerpColors(C_FLOOD, C_FLOOD_DEEP, Math.min(1, d / 6));
        } else {
          // Sea: colour by surface anomaly so the incoming wave and the drawdown are visible
          const a = eta[v] - this.seaLevel;
          if (a >= 0) c.lerpColors(C_SEA_DEEP, C_SEA_RISE, Math.min(1, a / 6));
          else c.lerpColors(C_SEA_DEEP, C_SEA_LOW, Math.min(1, -a / 4));
        }
        const f = foam[v] / 255;
        if (f > 0) c.lerp(C_FOAM, f);
        C[v * 3] = c.r; C[v * 3 + 1] = c.g; C[v * 3 + 2] = c.b;
      }
    }

    // Normals by central differences (much cheaper than computeVertexNormals each frame)
    const spacing = Math.abs(P[3] - P[0]) || 1;
    for (let j = 0; j < wny; j++) {
      const jm = Math.max(0, j - 1), jp = Math.min(wny - 1, j + 1);
      for (let i = 0; i < wnx; i++) {
        const im = Math.max(0, i - 1), ip = Math.min(wnx - 1, i + 1);
        const v = j * wnx + i;
        const gx = (P[(j * wnx + ip) * 3 + 1] - P[(j * wnx + im) * 3 + 1]) / ((ip - im) * spacing);
        const gz = (P[(jp * wnx + i) * 3 + 1] - P[(jm * wnx + i) * 3 + 1]) / ((jp - jm) * spacing);
        const inv = 1 / Math.hypot(gx, 1, gz);
        Nrm[v * 3] = -gx * inv; Nrm[v * 3 + 1] = inv; Nrm[v * 3 + 2] = -gz * inv;
      }
    }

    geom.attributes.position.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;
    geom.attributes.normal.needsUpdate = true;
    geom.computeBoundingSphere();
  }

  buildBuildings(buildings, meta, groundF32) {
    this.disposeMesh(this.buildingsMesh);
    this.buildingsMesh = null;
    this.buildingMatrices = null;
    if (!buildings || buildings.length === 0) return;

    const { res, nx, ny } = meta;
    const W = nx * res;
    const H = ny * res;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7, metalness: 0.1 }),
      buildings.length
    );
    const dummy = new THREE.Object3D();
    const white = new THREE.Color('#f5f5f5');
    this.buildingMatrices = new Float32Array(buildings.length * 16);
    this.buildingXZ = new Float32Array(buildings.length * 2);

    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      const gx = Math.min(nx - 1, Math.max(0, Math.floor(b.x / res)));
      const gz = Math.min(ny - 1, Math.max(0, Math.floor(b.z / res)));
      const groundZ = groundF32[gz * nx + gx] || 2.0;
      dummy.position.set(b.x - W / 2, groundZ + b.h / 2, b.z - H / 2);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.updateMatrix();
      dummy.matrix.toArray(this.buildingMatrices, i * 16);
      this.buildingXZ[i * 2] = b.x - W / 2;
      this.buildingXZ[i * 2 + 1] = b.z - H / 2;
      mesh.setColorAt(i, white);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.buildingsMesh = mesh;
    this.scene.add(mesh);
    this.applyBuildingFocus();
  }

  /** Show only buildings within `radius` metres of the focus point (display only; physics keeps all). */
  setBuildingFocus({ enabled, radius, x, z }) {
    Object.assign(this.buildingFocus, Object.fromEntries(Object.entries({ enabled, radius, x, z }).filter(([, v]) => v !== undefined)));
    this.applyBuildingFocus();
  }

  applyBuildingFocus() {
    const mesh = this.buildingsMesh;
    if (!mesh) return;
    const { enabled, radius, x, z } = this.buildingFocus;
    const r2 = radius * radius;
    const m = mesh.instanceMatrix.array;
    let shown = 0;
    for (let i = 0; i < mesh.count; i++) {
      const dx = this.buildingXZ[i * 2] - x;
      const dz = this.buildingXZ[i * 2 + 1] - z;
      if (!enabled || dx * dx + dz * dz <= r2) {
        m.set(this.buildingMatrices.subarray(i * 16, i * 16 + 16), i * 16);
        shown++;
      } else {
        m.fill(0, i * 16, i * 16 + 16); // zero-scale = not drawn
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.shownBuildings = shown;
  }

  updateBuildingDamage(bldgWet) {
    const mesh = this.buildingsMesh;
    if (!mesh || !bldgWet || bldgWet.length !== mesh.count) return;
    const safe = new THREE.Color('#f5f5f5');
    const wet = new THREE.Color('#d32f2f');
    for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, bldgWet[i] ? wet : safe);
    mesh.instanceColor.needsUpdate = true;
  }

  /** Image overlay draped on the terrain (hazard map, 2011 actual inundation mesh). */
  async buildOverlay(key, url, opts = {}) {
    this.disposeMesh(this.overlays[key]);
    delete this.overlays[key];
    if (!this.groundMesh) return;
    let tex;
    try {
      tex = await this.loadTexture(url);
    } catch {
      return; // no data for this region
    }
    if (opts.nearest) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
    }
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    // share the terrain geometry so the overlay follows the ground exactly
    const mesh = new THREE.Mesh(this.groundMesh.geometry, mat);
    mesh.renderOrder = 1;
    mesh.visible = false;
    mesh.userData.sharedGeometry = true;
    this.overlays[key] = mesh;
    this.scene.add(mesh);
  }

  setOverlayVisible(key, v) {
    if (this.overlays[key]) this.overlays[key].visible = v;
  }

  /** Switch the terrain photo between the current one and the 2011 post-tsunami ortho photo. */
  async setAerial(kind, urls) {
    if (!this.groundMesh) return;
    this.aerialCache = this.aerialCache || {};
    if (!this.aerialCache[kind]) this.aerialCache[kind] = await this.loadTexture(urls[kind]);
    this.groundMesh.material.map = this.aerialCache[kind];
    this.groundMesh.material.needsUpdate = true;
  }

  clearAerialCache() {
    for (const t of Object.values(this.aerialCache || {})) t.dispose();
    this.aerialCache = {};
  }

  /**
   * 2011 survey points: a line from the ground up to the measured water level (T.P.)
   * with a ball at the top, coloured by how the simulation compares.
   */
  buildSurveyMarkers(points, meta, groundF32) {
    if (this.surveyGroup) {
      this.scene.remove(this.surveyGroup);
      this.surveyGroup.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
    }
    this.surveyGroup = null;
    if (!points?.length) return;

    const { nx, ny, res } = meta;
    const W = nx * res;
    const H = ny * res;
    const group = new THREE.Group();
    const linePos = new Float32Array(points.length * 6);
    const balls = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true }),
      points.length
    );
    balls.renderOrder = 5;
    const dummy = new THREE.Object3D();
    this.surveyTops = [];
    points.forEach((p, i) => {
      const gx = Math.min(nx - 1, Math.max(0, Math.floor(p.x / res)));
      const gz = Math.min(ny - 1, Math.max(0, Math.floor(p.z / res)));
      const zb = groundF32[gz * nx + gx];
      const x = p.x - W / 2;
      const z = p.z - H / 2;
      const top = Math.max(p.h, zb + 0.5);
      linePos.set([x, zb, z, x, top, z], i * 6);
      this.surveyTops.push(new THREE.Vector3(x, top, z));
      dummy.position.set(x, top, z);
      dummy.updateMatrix();
      balls.setMatrixAt(i, dummy.matrix);
      balls.setColorAt(i, SURVEY_COLORS.none);
    });
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
    const lines = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthTest: false }));
    lines.renderOrder = 5;
    group.add(lines, balls);
    group.visible = false;
    this.surveyGroup = group;
    this.surveyBalls = balls;
    this.scene.add(group);
  }

  setSurveyVisible(v) {
    if (this.surveyGroup) this.surveyGroup.visible = v;
  }

  /** Colour survey markers by simulated max water level vs measured; returns the comparison summary. */
  /** Colour the survey markers and return the agreement for all points and for those matching today's terrain (p.fitsTerrain). */
  updateSurveyComparison(points, surveyMax) {
    if (!this.surveyBalls || !points?.length) return null;
    const acc = () => ({ n: 0, reached: 0, within: 0, sumDiff: 0, sumSq: 0 });
    const all = acc(), fits = acc();
    points.forEach((p, i) => {
      let col = SURVEY_COLORS.none;
      const sim = surveyMax ? surveyMax[i] : undefined;
      for (const a of p.fitsTerrain ? [all, fits] : [all]) a.n++;
      if (surveyMax) {
        if (!Number.isFinite(sim)) col = SURVEY_COLORS.miss;
        else {
          const diff = sim - p.h;
          for (const a of p.fitsTerrain ? [all, fits] : [all]) {
            a.reached++;
            a.sumDiff += diff;
            a.sumSq += diff * diff;
            if (Math.abs(diff) <= 2) a.within++;
          }
          col = diff > 2 ? SURVEY_COLORS.high : diff < -2 ? SURVEY_COLORS.low : SURVEY_COLORS.ok;
        }
      }
      this.surveyBalls.setColorAt(i, col);
    });
    this.surveyBalls.instanceColor.needsUpdate = true;
    const out = (a) => ({
      n: a.n,
      reached: a.reached,
      within: a.within,
      meanDiff: a.reached ? a.sumDiff / a.reached : NaN,
      rmse: a.reached ? Math.sqrt(a.sumSq / a.reached) : NaN,
    });
    return { ...out(all), fits: out(fits) };
  }

  setPin(worldX, worldZ, elevation) {
    if (!this.pinMesh) {
      const geom = new THREE.ConeGeometry(1, 3, 12);
      geom.rotateX(Math.PI);
      geom.translate(0, 1.5, 0); // tip at the origin, pointing down at the clicked spot
      const mat = new THREE.MeshStandardMaterial({ color: '#ff1744', emissive: '#b00020', roughness: 0.3 });
      this.pinMesh = new THREE.Mesh(geom, mat);
      this.scene.add(this.pinMesh);
    }
    this.pinMesh.position.set(worldX, elevation, worldZ);
    this.pinMesh.visible = true;
  }

  /** Interactive frame: keyboard, fly animation, controls, ground clearance, marker sizes. */
  render(dt = 1 / 60) {
    this.applyKeyboard();
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t * f.t * (3 - 2 * f.t);
      this.target.lerpVectors(f.fromT, f.toT, e);
      this.camera.position.lerpVectors(f.fromC, f.toC, e);
      if (f.t >= 1) this.fly = null;
    }
    this.controls.update();
    this.clampCamera();
    this.renderFrame();
  }

  /** Draw with the camera as-is (used by the recorder, which sets the camera itself). */
  renderFrame() {
    if (this.pinMesh?.visible) {
      const s = this.camera.position.distanceTo(this.pinMesh.position) * PIN_SCREEN_SCALE;
      this.pinMesh.scale.setScalar(Math.max(0.3, s));
    }
    if (this.surveyGroup?.visible && this.surveyTops) {
      const dummy = this._dummy || (this._dummy = new THREE.Object3D());
      for (let i = 0; i < this.surveyTops.length; i++) {
        dummy.position.copy(this.surveyTops[i]);
        dummy.scale.setScalar(Math.max(0.5, this.camera.position.distanceTo(this.surveyTops[i]) * 0.004));
        dummy.updateMatrix();
        this.surveyBalls.setMatrixAt(i, dummy.matrix);
      }
      this.surveyBalls.instanceMatrix.needsUpdate = true;
    }
    if (this.focusMarker.visible) {
      this.focusMarker.position.copy(this.target);
      this.focusMarker.scale.setScalar(Math.max(0.4, this.camera.position.distanceTo(this.target) * 0.004));
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Keep the camera at least `clearance` m above the ground. */
  clampCamera(clearance = 2) {
    const c = this.camera.position;
    const g = this.surfaceAt(c.x, c.z) + clearance;
    if (c.y < g) {
      c.y = g;
      this.camera.lookAt(this.target);
    }
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
