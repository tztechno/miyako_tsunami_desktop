// GPU tsunami inundation solver for a 2 m detail tile (WebGL2 fragment shaders, ping-pong float render targets),
// adapted from N65 nagoya_flood's sim.js.
//
// Scheme: 4-direction outflow fluxes per cell (virtual-pipe layout) updated with the local-inertial momentum
// equation and semi-implicit Manning friction (Bates et al. 2010); fluxes are rescaled so a cell never sends
// out more water than it holds (mass conservative, depth >= 0). Buildings, seawalls, parapets and closed
// gates are part of the surface (DSM) the water runs on.
// Boundary (nesting): the water level of the 5 m city run stands just outside the tile edge. It comes
// from the run's stored keyframes on the 30 m render grid, interpolated in space and time; where it is higher
// than the tile's edge cell water flows in, where it is lower the tile drains out.
import * as THREE from 'three';

const VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */ `
uniform sampler2D uState;   // r: depth, g: max depth
uniform sampler2D uFlux;    // r: up (j-1), g: down (j+1), b: left (i-1), a: right (i+1) outflow, m^3/s
uniform sampler2D uTerr;    // r: DSM, g: ground, b: 1 building
uniform ivec2 uSize;
uniform float uDt, uDx, uG, uN2;
// nesting in the 5 m run: water level (m) of two keyframes on a window of its render grid, and its ground
uniform sampler2D uCEtaA, uCEtaB, uCGround;
uniform float uCW;          // time weight between keyframe A and B
uniform ivec2 uCSize;
uniform vec4 uMap;          // coarse texel coord = (x + i * y, z + j * w) for fine cell (i, j)

bool inside(ivec2 p) { return p.x >= 0 && p.y >= 0 && p.x < uSize.x && p.y < uSize.y; }

float cEta(ivec2 c) { return mix(texelFetch(uCEtaA, c, 0).r, texelFetch(uCEtaB, c, 0).r, uCW); }

// Water standing just outside the tile at (outside) cell pn, from the 5 m run. Returns -1e9 when dry.
float ghostLevel(ivec2 p, ivec2 pn) {
  vec2 c = vec2(uMap.x + float(pn.x) * uMap.y, uMap.z + float(pn.y) * uMap.w);
  ivec2 i0 = ivec2(floor(c));
  vec2 f = c - vec2(i0);
  ivec2 hi = uCSize - 1;
  ivec2 a = clamp(i0, ivec2(0), hi), b = clamp(i0 + ivec2(1, 0), ivec2(0), hi);
  ivec2 cc = clamp(i0 + ivec2(0, 1), ivec2(0), hi), d = clamp(i0 + ivec2(1, 1), ivec2(0), hi);
  float e = mix(mix(cEta(a), cEta(b), f.x), mix(cEta(cc), cEta(d), f.x), f.y);
  float z = mix(mix(texelFetch(uCGround, a, 0).r, texelFetch(uCGround, b, 0).r, f.x),
                mix(texelFetch(uCGround, cc, 0).r, texelFetch(uCGround, d, 0).r, f.x), f.y);
  float dc = e - z;
  if (dc < 0.02) return -1e9;
  // sea / river / deep flood: transfer the water surface; thin sheet flow: transfer the depth
  return dc > 0.3 ? e : texelFetch(uTerr, p, 0).g + dc;
}
`;

const FLUX_FRAG = /* glsl */ `
${COMMON}
float faceFlux(float qOld, float z, float H, ivec2 pn) {
  float zn, Hn;
  if (inside(pn)) { zn = texelFetch(uTerr, pn, 0).r; Hn = zn + texelFetch(uState, pn, 0).r; }
  else { zn = z; Hn = max(z, ghostLevel(ivec2(clamp(pn, ivec2(0), uSize - 1)), pn)); }
  float hf = max(H, Hn) - max(z, zn);        // flow depth at the cell face
  if (hf < 1e-4) return 0.0;
  float q = qOld / uDx;                      // unit-width discharge m^2/s
  q = (q + uG * hf * uDt * (H - Hn) / uDx) / (1.0 + uG * uDt * uN2 * abs(q) / pow(hf, 7.0 / 3.0));
  q = min(q, hf * sqrt(uG * hf) * 1.5);      // Froude limiter
  return max(0.0, q * uDx);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uTerr, p, 0).r;
  float d = texelFetch(uState, p, 0).r;
  float H = z + d;
  vec4 f = texelFetch(uFlux, p, 0);
  vec4 q = vec4(
    faceFlux(f.r, z, H, p + ivec2(0, -1)),
    faceFlux(f.g, z, H, p + ivec2(0, 1)),
    faceFlux(f.b, z, H, p + ivec2(-1, 0)),
    faceFlux(f.a, z, H, p + ivec2(1, 0)));
  float out_ = (q.r + q.g + q.b + q.a) * uDt;
  float avail = d * uDx * uDx;
  if (out_ > avail && out_ > 0.0) q *= avail / out_;
  gl_FragColor = q;
}`;

const DEPTH_FRAG = /* glsl */ `
${COMMON}
float fin(ivec2 pn, int comp) {
  if (!inside(pn)) return 0.0;
  return texelFetch(uFlux, pn, 0)[comp];
}
// inflow (m^3/s) from the 5 m run through the boundary face towards outside cell pn
float ghostIn(ivec2 p, ivec2 pn, float z, float H) {
  if (inside(pn)) return 0.0;
  float Hb = ghostLevel(p, pn);
  if (Hb <= H) return 0.0;
  float hf = Hb - z;
  if (hf < 1e-4) return 0.0;
  float q = pow(hf, 5.0 / 3.0) * sqrt((Hb - H) / uDx) / sqrt(uN2); // Manning, unit width
  q = min(q, hf * sqrt(uG * hf));                                   // not faster than critical flow
  q = min(q, 0.25 * (Hb - H) * uDx / uDt);                          // do not overshoot the outside level
  return q * uDx;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, p, 0);
  vec4 f = texelFetch(uFlux, p, 0);
  float inflow = fin(p + ivec2(0, -1), 1) + fin(p + ivec2(0, 1), 0) + fin(p + ivec2(-1, 0), 3) + fin(p + ivec2(1, 0), 2);
  float z = texelFetch(uTerr, p, 0).r;
  float H0 = z + s.r;
  inflow += ghostIn(p, p + ivec2(0, -1), z, H0) + ghostIn(p, p + ivec2(0, 1), z, H0)
          + ghostIn(p, p + ivec2(-1, 0), z, H0) + ghostIn(p, p + ivec2(1, 0), z, H0);
  float outflow = f.r + f.g + f.b + f.a;
  float d = max(0.0, s.r + (inflow - outflow) * uDt / (uDx * uDx));
  gl_FragColor = vec4(d, max(s.g, d), 0.0, 0.0);
}`;

const ZERO_FRAG = /* glsl */ `void main() { gl_FragColor = vec4(0.0); }`;
const COPY_FRAG = /* glsl */ `uniform sampler2D uSrc; void main() { gl_FragColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

// 4x4 block reduction: r = max depth
const REDUCE_FRAG = /* glsl */ `
uniform sampler2D uSrc; uniform ivec2 uSrcSize;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * 4;
  float m = 0.0;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    ivec2 p = o + ivec2(x, y);
    if (p.x >= uSrcSize.x || p.y >= uSrcSize.y) continue;
    m = max(m, texelFetch(uSrc, p, 0).r);
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 0.0);
}`;

function floatRT(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}
const floatTex = (data, w, h) => {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
};

export class TileSim {
  /**
   * tile: loadTile() result; surface: tileSurface() result; coarse: { timeline, regionMeta, tideLevel } (the 5 m run).
   * Initial state: the sea and rivers at the tide level (T.P. m), land dry (as the 5 m run starts).
   */
  constructor(renderer, tile, surface, coarse, manning = 0.025) {
    this.renderer = renderer;
    this.tile = tile;
    const { nx, ny, res, N } = tile;
    this.nx = nx; this.ny = ny; this.dx = res;

    const terr = new Float32Array(N * 4);
    const init = new Float32Array(N * 4);
    for (let k = 0; k < N; k++) {
      terr[k * 4] = surface.dsm[k];
      terr[k * 4 + 1] = tile.ground[k];
      terr[k * 4 + 2] = tile.bldgGrid[k] >= 0 ? 1 : 0;
      const d = tile.water[k] ? Math.max(0, (coarse.tideLevel || 0) - surface.dsm[k]) : 0;
      init[k * 4] = d; init[k * 4 + 1] = d;
    }
    this.terrTex = new THREE.DataTexture(terr, nx, ny, THREE.RGBAFormat, THREE.FloatType);
    this.terrTex.needsUpdate = true;
    this.initTex = new THREE.DataTexture(init, nx, ny, THREE.RGBAFormat, THREE.FloatType);
    this.initTex.needsUpdate = true;

    // window of the 5 m run's render grid around the tile (+2 vertices each side)
    const tl = coarse.timeline, R = coarse.regionMeta;
    const spacing = tl.step * R.res;                 // render vertex spacing (m)
    const vx = (x) => (x - 0.5 * R.res) / spacing;   // region-local x (m) -> render vertex coordinate
    this.wi0 = Math.max(0, Math.floor(vx(tile.offX)) - 2);
    this.wj0 = Math.max(0, Math.floor(vx(tile.offZ)) - 2);
    const wi1 = Math.min(tl.wnx - 1, Math.ceil(vx(tile.offX + tile.widthM)) + 2);
    const wj1 = Math.min(tl.wny - 1, Math.ceil(vx(tile.offZ + tile.heightM)) + 2);
    this.cw = wi1 - this.wi0 + 1; this.ch = wj1 - this.wj0 + 1;
    this.timeline = tl;
    const cg = new Float32Array(this.cw * this.ch);
    for (let j = 0; j < this.ch; j++) for (let i = 0; i < this.cw; i++) cg[j * this.cw + i] = tl.ground[(this.wj0 + j) * tl.wnx + this.wi0 + i];
    this.cGround = floatTex(cg, this.cw, this.ch);
    this.cEtaA = floatTex(new Float32Array(this.cw * this.ch), this.cw, this.ch);
    this.cEtaB = floatTex(new Float32Array(this.cw * this.ch), this.cw, this.ch);
    this.kfLoaded = -1;
    const s = res / spacing;
    const map = new THREE.Vector4(vx(tile.offX + 0.5 * res) - this.wi0, s, vx(tile.offZ + 0.5 * res) - this.wj0, s);

    this.state = [floatRT(nx, ny), floatRT(nx, ny)];
    this.flux = [floatRT(nx, ny), floatRT(nx, ny)];
    this.reduceRTs = [];
    let w = nx, h = ny;
    while (w > 8 || h > 8) { w = Math.ceil(w / 4); h = Math.ceil(h / 4); this.reduceRTs.push(floatRT(w, h)); }

    this.uniforms = {
      uState: { value: null }, uFlux: { value: null }, uTerr: { value: this.terrTex },
      uSize: { value: new THREE.Vector2(nx, ny) },
      uDt: { value: 0.05 }, uDx: { value: res }, uG: { value: 9.81 }, uN2: { value: manning * manning },
      uCEtaA: { value: this.cEtaA }, uCEtaB: { value: this.cEtaB }, uCGround: { value: this.cGround },
      uCW: { value: 0 }, uCSize: { value: new THREE.Vector2(this.cw, this.ch) }, uMap: { value: map },
    };
    const mat = (frag, uniforms = this.uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    this.fluxMat = mat(FLUX_FRAG);
    this.depthMat = mat(DEPTH_FRAG);
    this.zeroMat = mat(ZERO_FRAG, {});
    this.copyUniforms = { uSrc: { value: null } };
    this.copyMat = mat(COPY_FRAG, this.copyUniforms);
    this.reduceUniforms = { uSrc: { value: null }, uSrcSize: { value: new THREE.Vector2() } };
    this.reduceMat = mat(REDUCE_FRAG, this.reduceUniforms);

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.zeroMat);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.cfl = 0.5;
    this.reset(tl.start);
  }

  _pass(material, target) {
    this.quad.material = material;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }

  reset(t0) {
    this.copyUniforms.uSrc.value = this.initTex;
    for (const rt of this.state) this._pass(this.copyMat, rt);
    for (const rt of this.flux) this._pass(this.zeroMat, rt);
    this.cur = 0;
    this.time = t0;
    this.steps = 0;
    this.measure();
  }

  /** Boundary water levels for time t: the two keyframes around it on the window, and the weight. */
  _setBoundary(t) {
    const tl = this.timeline, f = tl.frames;
    const i = tl.indexAt(t);
    const a = f[i], b = f[Math.min(f.length - 1, i + 1)];
    if (this.kfLoaded !== i) {
      const fill = (tex, kf) => {
        const d = tex.image.data;
        for (let j = 0; j < this.ch; j++) {
          const row = (this.wj0 + j) * tl.wnx + this.wi0;
          for (let q = 0; q < this.cw; q++) d[j * this.cw + q] = kf.eta[row + q] * 0.01;
        }
        tex.needsUpdate = true;
      };
      fill(this.cEtaA, a);
      fill(this.cEtaB, b);
      this.kfLoaded = i;
    }
    this.uniforms.uCW.value = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  }

  /** Max depth via GPU reduction (forces a GPU sync; call sparingly). */
  measure() {
    let src = this.state[this.cur], sw = this.nx, sh = this.ny;
    for (const rt of this.reduceRTs) {
      this.reduceUniforms.uSrc.value = src.texture;
      this.reduceUniforms.uSrcSize.value.set(sw, sh);
      this._pass(this.reduceMat, rt);
      src = rt; sw = rt.width; sh = rt.height;
    }
    const buf = new Float32Array(sw * sh * 4);
    this.renderer.readRenderTargetPixels(src, 0, 0, sw, sh, buf);
    let m = 0;
    for (let i = 0; i < sw * sh; i++) m = Math.max(m, buf[i * 4]);
    this.hmax = m;
    return m;
  }

  /** CFL time step of the local-inertial scheme, h = deepest water with a 30 % margin. */
  stableDt() {
    const h = Math.max(this.hmax * 1.3 + 0.05, 0.1);
    return Math.min(1.0, (this.cfl * this.dx) / Math.sqrt(9.81 * h));
  }

  step(dt) {
    const u = this.uniforms;
    this._setBoundary(this.time + dt);
    u.uDt.value = dt;
    u.uState.value = this.state[this.cur].texture;
    u.uFlux.value = this.flux[this.cur].texture;
    this._pass(this.fluxMat, this.flux[1 - this.cur]);
    u.uFlux.value = this.flux[1 - this.cur].texture;
    this._pass(this.depthMat, this.state[1 - this.cur]);
    this.cur = 1 - this.cur;
    this.time += dt;
    this.steps++;
  }

  /** Full state read-back: Float32Array(nx*ny*4) = depth, max depth, -, -. */
  readState() {
    const buf = new Float32Array(this.nx * this.ny * 4);
    this.renderer.readRenderTargetPixels(this.state[this.cur], 0, 0, this.nx, this.ny, buf);
    return buf;
  }

  dispose() {
    [...this.state, ...this.flux, ...this.reduceRTs].forEach((rt) => rt.dispose());
    [this.terrTex, this.initTex, this.cGround, this.cEtaA, this.cEtaB].forEach((t) => t.dispose());
    [this.fluxMat, this.depthMat, this.zeroMat, this.copyMat, this.reduceMat].forEach((m) => m.dispose());
    this.quad.geometry.dispose();
  }
}
