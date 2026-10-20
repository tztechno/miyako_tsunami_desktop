import * as THREE from 'three';

export class SeawallManager {
  constructor(regionMeta) {
    this.meta = regionMeta;
    this.seawallData = null;
    this.activePreset = 'historic_10'; // 'historic_10' | 'none' | 'custom'
    this.customHeight = 10.0;
    this.meshGroup = new THREE.Group();
    this.seawallMeshes = new Map();

    // Simulation grid barrier elevation
    this.barrierGrid = new Float32Array(this.meta.nx * this.meta.ny);
    this.barrierActive = new Uint8Array(this.meta.nx * this.meta.ny);
    this.overtoppingPoints = [];
  }

  async loadSeawalls(regionName) {
    try {
      const res = await fetch(`data/regions/${regionName}/seawalls.json`);
      if (!res.ok) {
        console.warn('seawalls.json not found for', regionName);
        return;
      }
      this.seawallData = await res.json();
      this.rebuildMeshes();
      this.updateBarrierGrid();
    } catch (e) {
      console.error('Failed to load seawalls:', e);
    }
  }

  setPreset(preset, customHeight = 10.0) {
    this.activePreset = preset;
    this.customHeight = customHeight;
    this.rebuildMeshes();
    this.updateBarrierGrid();
  }

  setCustomHeight(height) {
    this.customHeight = height;
    if (this.activePreset !== 'custom') {
      this.activePreset = 'custom';
    }
    this.rebuildMeshes();
    this.updateBarrierGrid();
  }

  getActiveSeawallList() {
    if (!this.seawallData || !this.seawallData.seawalls) return [];
    if (this.activePreset === 'none') return [];

    return this.seawallData.seawalls.filter(sw => {
      if (this.activePreset === 'historic_10') {
        return sw.type === 'historic';
      }
      return true; // custom
    });
  }

  rebuildMeshes() {
    // Clear existing
    while (this.meshGroup.children.length > 0) {
      const child = this.meshGroup.children[0];
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
      this.meshGroup.remove(child);
    }
    this.seawallMeshes.clear();

    const activeList = this.getActiveSeawallList();
    if (activeList.length === 0) return;

    for (const sw of activeList) {
      const targetH = this.activePreset === 'custom' ? this.customHeight : sw.defaultHeight;
      const mesh = this.createSeawallMesh(sw, targetH);
      if (mesh) {
        this.meshGroup.add(mesh);
        this.seawallMeshes.set(sw.id, { mesh, seawall: sw, height: targetH });
      }
    }
  }

  createSeawallMesh(sw, targetHeight) {
    const pts = sw.points;
    if (!pts || pts.length < 2) return null;

    const { originE, originN, res, nx, ny } = this.meta;
    const W = nx * res;
    const H = ny * res;

    const geom = new THREE.BufferGeometry();
    const positions = [];
    const normals = [];
    const colors = [];

    const baseHalfW = (sw.baseWidth || 20.0) / 2;
    const topHalfW = (sw.width || 5.0) / 2;

    const colorTop = new THREE.Color(sw.color || '#4fc3f7');
    const colorSide = new THREE.Color('#90a4ae');

    // Build extruded trapezoid segment by segment
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];

      // Local 3D coords: X right, Z down
      const x0 = p0.e - originE - W / 2;
      const z0 = originN - p0.n - H / 2;
      const x1 = p1.e - originE - W / 2;
      const z1 = originN - p1.n - H / 2;

      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;

      const nx_dir = -dz / len;
      const nz_dir = dx / len;

      // Base bottom elevation around 0..2m, top at targetHeight
      const yBottom = -1.0;
      const yTop = targetHeight;

      // 4 top vertices and 4 bottom vertices
      // v0: top left 0, v1: top right 0
      const v0x = x0 + nx_dir * topHalfW, v0z = z0 + nz_dir * topHalfW;
      const v1x = x0 - nx_dir * topHalfW, v1z = z0 - nz_dir * topHalfW;
      const v2x = x1 + nx_dir * topHalfW, v2z = z1 + nz_dir * topHalfW;
      const v3x = x1 - nx_dir * topHalfW, v3z = z1 - nz_dir * topHalfW;

      // Bottom
      const b0x = x0 + nx_dir * baseHalfW, b0z = z0 + nz_dir * baseHalfW;
      const b1x = x0 - nx_dir * baseHalfW, b1z = z0 - nz_dir * baseHalfW;
      const b2x = x1 + nx_dir * baseHalfW, b2z = z1 + nz_dir * baseHalfW;
      const b3x = x1 - nx_dir * baseHalfW, b3z = z1 - nz_dir * baseHalfW;

      // Helper to add quad (2 triangles)
      const addQuad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx2, dy2, dz2, norm, col) => {
        positions.push(ax, ay, az,  bx, by, bz,  cx, cy, cz);
        positions.push(ax, ay, az,  cx, cy, cz,  dx2, dy2, dz2);
        for (let k = 0; k < 6; k++) {
          normals.push(norm.x, norm.y, norm.z);
          colors.push(col.r, col.g, col.b);
        }
      };

      // Top face
      addQuad(v0x, yTop, v0z,  v2x, yTop, v2z,  v3x, yTop, v3z,  v1x, yTop, v1z, new THREE.Vector3(0, 1, 0), colorTop);

      // Left seaside slope
      const normL = new THREE.Vector3(nx_dir, 0.4, nz_dir).normalize();
      addQuad(b0x, yBottom, b0z,  b2x, yBottom, b2z,  v2x, yTop, v2z,  v0x, yTop, v0z, normL, colorSide);

      // Right landside slope
      const normR = new THREE.Vector3(-nx_dir, 0.4, -nz_dir).normalize();
      addQuad(v1x, yTop, v1z,  v3x, yTop, v3z,  b3x, yBottom, b3z,  b1x, yBottom, b1z, normR, colorSide);
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.1,
      side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  updateBarrierGrid() {
    this.barrierGrid.fill(-999);
    this.barrierActive.fill(0);

    const activeList = this.getActiveSeawallList();
    if (activeList.length === 0) return;

    const { originE, originN, res, nx, ny } = this.meta;

    for (const sw of activeList) {
      const targetH = this.activePreset === 'custom' ? this.customHeight : sw.defaultHeight;
      const pts = sw.points;
      const halfW = (sw.width || 6.0) / 2 + res * 0.7;

      for (let s = 0; s < pts.length - 1; s++) {
        const p0 = pts[s];
        const p1 = pts[s + 1];

        const x0 = (p0.e - originE) / res;
        const y0 = (originN - p0.n) / res;
        const x1 = (p1.e - originE) / res;
        const y1 = (originN - p1.n) / res;

        const minGx = Math.max(0, Math.floor(Math.min(x0, x1) - halfW / res));
        const maxGx = Math.min(nx - 1, Math.ceil(Math.max(x0, x1) + halfW / res));
        const minGy = Math.max(0, Math.floor(Math.min(y0, y1) - halfW / res));
        const maxGy = Math.min(ny - 1, Math.ceil(Math.max(y0, y1) + halfW / res));

        const segDx = x1 - x0;
        const segDy = y1 - y0;
        const segLenSq = segDx * segDx + segDy * segDy;

        for (let gy = minGy; gy <= maxGy; gy++) {
          for (let gx = minGx; gx <= maxGx; gx++) {
            const cx = gx + 0.5;
            const cy = gy + 0.5;

            // Distance to line segment
            let t = ((cx - x0) * segDx + (cy - y0) * segDy) / (segLenSq || 1);
            t = Math.max(0, Math.min(1, t));
            const projX = x0 + t * segDx;
            const projY = y0 + t * segDy;
            const dist = Math.hypot(cx - projX, cy - projY) * res;

            if (dist <= halfW) {
              const idx = gy * nx + gx;
              if (targetH > this.barrierGrid[idx]) {
                this.barrierGrid[idx] = targetH;
                this.barrierActive[idx] = 1;
              }
            }
          }
        }
      }
    }
  }

  dispose() {
    while (this.meshGroup.children.length > 0) {
      const c = this.meshGroup.children[0];
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      this.meshGroup.remove(c);
    }
  }
}
