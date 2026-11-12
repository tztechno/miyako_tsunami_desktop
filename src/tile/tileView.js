// Drawing of a 2 m detail tile inside the city scene: terrain with the 0.5 m aerial photo, every PLATEAU
// building (red once the water around it reaches 0.5 m), the seawall / parapet / gate cells, and the water
// surface displaced on the GPU from a depth texture, coloured with the same depth legend as the 5 m view.
import * as THREE from 'three';
import { DEPTH_LEGEND } from '../scene.js';

// the city renderer uses a logarithmic depth buffer, so these shaders write log depth too (logdepthbuf chunks)
const WATER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D uDepth;
attribute float aGround;
attribute float aWater;
varying float vD;
varying float vWater;
varying vec3 vPos;
void main() {
  float d = texture2D(uDepth, vec2(uv.x, 1.0 - uv.y)).r; // data row 0 = north edge (uv.y = 1 there)
  vD = d;
  vWater = aWater;
  vec3 p = position;
  p.y = d > 0.02 ? aGround + d : aGround - 2.0;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

// legend colours as uniform arrays (thresholds in m), sRGB -> linear done on upload
const WATER_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uColors[8];
uniform float uMax[8];
varying float vD;
varying float vWater;
varying vec3 vPos;
void main() {
  #include <logdepthbuf_fragment>
  if (vD <= 0.02) discard;
  vec3 c;
  if (vWater > 0.5) {
    c = vec3(0.012, 0.09, 0.16); // sea / river (linear), as the 5 m view's open water
  } else {
    c = uColors[7];
    for (int i = 6; i >= 0; i--) if (vD < uMax[i]) c = uColors[i];
  }
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
  float light = 0.75 + 0.25 * abs(dot(n, normalize(vec3(0.4, 1.0, 0.3))));
  gl_FragColor = vec4(c * light, 0.9);
  #include <colorspace_fragment>
}`;

export class TileView {
  /** scene: TsunamiScene; tile: loadTile(); surface: tileSurface() (walls). */
  constructor(scene, tile, surface) {
    this.scene = scene;
    this.tile = tile;
    this.group = new THREE.Group();
    // tile-local (x east, z south from the tile's NW corner) -> scene coordinates
    this.group.position.set(tile.offX - scene.W / 2, 0, tile.offZ - scene.H / 2);
    scene.scene.add(this.group);
    this.depth = new Float32Array(tile.N);
    this._buildTerrain();
    this._buildWater();
    this._buildBuildings();
    this.setWalls(surface);
  }

  /** Grid geometry with one vertex per cell centre. */
  _grid(withGround) {
    const { nx, ny, res, ground } = this.tile;
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = (i + 0.5) * res; pos[k * 3 + 1] = withGround ? ground[k] : 0; pos[k * 3 + 2] = (j + 0.5) * res;
      uv[k * 2] = (i + 0.5) / nx; uv[k * 2 + 1] = 1 - (j + 0.5) / ny;
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let p = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }

  _buildTerrain() {
    const geo = this._grid(true);
    geo.computeVertexNormals();
    const url = URL.createObjectURL(this.tile.aerialBlob);
    const tex = new THREE.TextureLoader().load(url, () => URL.revokeObjectURL(url));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 }));
    this.terrain.position.y = 0.05;
    this.group.add(this.terrain);
  }

  _buildWater() {
    const { nx, ny, N, ground, water } = this.tile;
    const geo = this._grid(false);
    const g = new Float32Array(N), w = new Float32Array(N);
    for (let k = 0; k < N; k++) { g[k] = ground[k]; w[k] = water[k]; }
    geo.setAttribute('aGround', new THREE.BufferAttribute(g, 1));
    geo.setAttribute('aWater', new THREE.BufferAttribute(w, 1));
    this.depthTex = new THREE.DataTexture(this.depth, nx, ny, THREE.RedFormat, THREE.FloatType);
    this.depthTex.flipY = false;
    this.depthTex.needsUpdate = true;
    const colors = DEPTH_LEGEND.map((l) => new THREE.Color(l.color));
    const maxes = DEPTH_LEGEND.map((l) => (Number.isFinite(l.max) ? l.max : 1e9));
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uDepth: { value: this.depthTex }, uColors: { value: colors }, uMax: { value: maxes } },
    });
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.frustumCulled = false;
    this.water.renderOrder = 2;
    this.group.add(this.water);
  }

  _buildBuildings() {
    const B = this.tile.buildings;
    const pos = [], nrm = [];
    this.bRange = new Uint32Array(B.count + 1); // first vertex of each building
    const col = [];
    // per-building grey (±6 %) and lighter roofs, as in nagoya_flood, so neighbouring blocks stay distinct
    const shade = (b) => 0.80 + (Math.abs(Math.sin(b * 12.9898) * 43758.5453) % 1) * 0.12;
    const { offX, offZ } = this.tile;
    for (let b = 0; b < B.count; b++) {
      this.bRange[b] = pos.length / 3;
      const s = B.vstart[b], e = B.vstart[b + 1], n = e - s;
      if (n < 3) continue;
      let cx = 0, cz = 0;
      for (let i = s; i < e; i++) { cx += B.verts[i * 2]; cz += B.verts[i * 2 + 1]; }
      if (this.scene.onLandmarkModel?.(offX + cx / n, offZ + cz / n)) continue; // drawn by a detailed model (osaka_tsunami only)
      const base = B.base(b), top = Math.max(base + 3, B.top(b));
      const pts = [];
      for (let i = s; i < e; i++) pts.push(new THREE.Vector2(B.verts[i * 2], B.verts[i * 2 + 1]));
      const sign = THREE.ShapeUtils.area(pts) > 0 ? 1 : -1;
      const g = shade(b);
      const push = (x, y, z, nn) => {
        pos.push(x, y, z); nrm.push(nn[0], nn[1], nn[2]);
        const v = nn[1] > 0.5 ? Math.min(1, g * 1.1) : g;
        col.push(v, v * 0.995, v * 0.98);
      };
      for (let i = 0; i < n; i++) {
        const p = pts[i], q = pts[(i + 1) % n];
        const dx = q.x - p.x, dz = q.y - p.y, len = Math.hypot(dx, dz) || 1;
        const nn = [(-dz / len) * sign, 0, (dx / len) * sign];
        push(p.x, base, p.y, nn); push(q.x, base, q.y, nn); push(q.x, top, q.y, nn);
        push(p.x, base, p.y, nn); push(q.x, top, q.y, nn); push(p.x, top, p.y, nn);
      }
      for (const t of THREE.ShapeUtils.triangulateShape(pts, [])) for (const k of t) push(pts[k].x, top, pts[k].y, [0, 1, 0]);
    }
    this.bRange[B.count] = pos.length / 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    this.bBase = Float32Array.from(col);
    this.bColor = Float32Array.from(col);
    geo.setAttribute('color', new THREE.BufferAttribute(this.bColor, 3));
    this.bWet = new Uint8Array(B.count);
    this.buildings = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.group.add(this.buildings);
  }

  /** Wall / gate cells as boxes from the ground to the crest. */
  setWalls(surface) {
    if (this.walls) { this.group.remove(this.walls); this.walls.geometry.dispose(); this.walls.material.dispose(); this.walls = null; }
    const { nx, res, N, ground } = this.tile;
    const cells = [];
    for (let k = 0; k < N; k++) if (!Number.isNaN(surface.wall[k])) cells.push(k);
    if (!cells.length) return;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(res, 1, res), new THREE.MeshLambertMaterial(), cells.length);
    const m = new THREE.Matrix4();
    // seawalls light blue, river levees lilac, gates amber
    const colors = [null, new THREE.Color('#7dd3fc'), new THREE.Color('#c4b5fd'), new THREE.Color('#f59e0b')];
    cells.forEach((k, n) => {
      mesh.setColorAt(n, colors[surface.wallKind[k]] || colors[1]);
      const i = k % nx, j = Math.floor(k / nx);
      const lo = Math.min(ground[k], surface.wall[k] - 0.5), hi = surface.wall[k];
      m.makeScale(1, hi - lo, 1).setPosition((i + 0.5) * res, (lo + hi) / 2, (j + 0.5) * res);
      mesh.setMatrixAt(n, m);
    });
    this.walls = mesh;
    this.group.add(mesh);
  }

  /** Water depth per cell (Float32Array N) and flood depth per building (red at >= 0.5 m). */
  setDepth(depth, bFlood) {
    this.depth.set(depth);
    this.depthTex.needsUpdate = true;
    if (!bFlood) return;
    let changed = false;
    for (let b = 0; b < bFlood.length; b++) {
      const wet = bFlood[b] >= 0.5 ? 1 : 0;
      if (wet === this.bWet[b]) continue;
      this.bWet[b] = wet;
      changed = true;
      for (let v = this.bRange[b]; v < this.bRange[b + 1]; v++) {
        if (wet) { this.bColor[v * 3] = 1; this.bColor[v * 3 + 1] = 0.27; this.bColor[v * 3 + 2] = 0.27; }
        else for (let c = 0; c < 3; c++) this.bColor[v * 3 + c] = this.bBase[v * 3 + c];
      }
    }
    if (changed) this.buildings.geometry.attributes.color.needsUpdate = true;
  }

  /** Terrain height at tile-local (x, z), for pins and the camera. */
  groundAt(x, z) {
    const { nx, ny, res, ground } = this.tile;
    const i = Math.floor(x / res), j = Math.floor(z / res);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    return ground[j * nx + i];
  }

  dispose() {
    this.scene.scene.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
    });
    this.depthTex.dispose();
  }
}
