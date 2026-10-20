import * as THREE from 'three';
import { toPlane } from './proj.js';
import { getLang } from './i18n.js';

export class LabelManager {
  constructor(container, meta) {
    this.container = container;
    this.meta = meta;
    this.labels = [];
    this.elements = [];
    this.visible = true;
  }

  async loadLabels() {
    try {
      const res = await fetch('data/labels.json');
      if (!res.ok) return;
      const all = await res.json();
      this.labels = all.filter(l => l.region === this.meta.name || l.region === 'outer');
      this.createElements();
    } catch (e) {
      console.warn('Failed to load labels:', e);
    }
  }

  createElements() {
    this.container.innerHTML = '';
    this.elements = [];

    const { originE, originN, res, nx, ny } = this.meta;
    const W = nx * res;
    const H = ny * res;

    for (const l of this.labels) {
      const [e, n] = toPlane(l.lon, l.lat);
      const x = e - originE - W / 2;
      const z = originN - n - H / 2;
      const y = 30; // height above ground

      const el = document.createElement('div');
      el.className = `map-3d-label category-${l.category}`;
      el.innerHTML = `<span class="label-dot"></span><span class="label-text">${getLang() === 'en' ? l.name_en : l.name}</span>`;
      this.container.appendChild(el);

      this.elements.push({
        el,
        label: l,
        pos: new THREE.Vector3(x, y, z),
      });
    }
  }

  update(camera, width, height) {
    if (!this.visible) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'block';

    const tempV = new THREE.Vector3();
    const camDir = camera.getWorldDirection(new THREE.Vector3());

    for (const item of this.elements) {
      tempV.copy(item.pos);

      // Check if in front of camera
      const toLabel = tempV.clone().sub(camera.position);
      if (toLabel.dot(camDir) < 0) {
        item.el.style.display = 'none';
        continue;
      }

      tempV.project(camera);
      // Normalized Device Coordinates to screen pixels
      const x = (tempV.x * 0.5 + 0.5) * width;
      const y = (-(tempV.y * 0.5) + 0.5) * height;

      if (tempV.z > 1.0 || x < -50 || x > width + 50 || y < -50 || y > height + 50) {
        item.el.style.display = 'none';
      } else {
        item.el.style.display = 'flex';
        item.el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
      }
    }
  }

  setVisible(v) {
    this.visible = v;
    this.container.style.display = v ? 'block' : 'none';
  }

  updateLanguage() {
    for (const item of this.elements) {
      const span = item.el.querySelector('.label-text');
      if (span) {
        span.textContent = getLang() === 'en' ? item.label.name_en : item.label.name;
      }
    }
  }
}
