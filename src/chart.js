import { t } from './i18n.js';

export class DepthChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.history = []; // { timeSec, depth }
    this.pointInfo = null;
  }

  setPoint(info) {
    this.pointInfo = info;
    this.history = [];
  }

  addSample(timeSec, depth) {
    if (!this.pointInfo) return;
    this.history.push({ timeSec, depth });
    if (this.history.length > 200) {
      this.history.shift();
    }
  }

  draw() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (!this.pointInfo) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t('chartEmpty'), w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }

    // Header info
    ctx.fillStyle = '#00e5ff';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText(`${t('chartHead')}: ${this.pointInfo.elevation.toFixed(1)}m | ${t('chartDepth')}: ${this.pointInfo.waterDepth.toFixed(2)}m`, 10, 16);

    // Max depth in history
    let maxD = 5.0;
    for (const p of this.history) {
      if (p.depth > maxD) maxD = p.depth;
    }
    maxD = Math.ceil(maxD * 1.2);

    const padL = 35;
    const padB = 25;
    const padT = 30;
    const padR = 15;

    const toX = (i) => padL + (i / Math.max(1, this.history.length - 1)) * (w - padL - padR);
    const toY = (d) => h - padB - (d / maxD) * (h - padT - padB);

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let d = 0; d <= maxD; d += Math.max(1, Math.round(maxD / 4))) {
      const y = toY(d);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText(`${d}m`, 5, y + 3);
    }

    if (this.history.length < 2) return;

    // Draw area under curve
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(0));
    for (let i = 0; i < this.history.length; i++) {
      ctx.lineTo(toX(i), toY(this.history[i].depth));
    }
    ctx.lineTo(toX(this.history.length - 1), toY(0));
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, 'rgba(0, 229, 255, 0.5)');
    grad.addColorStop(1, 'rgba(0, 229, 255, 0.05)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const x = toX(i);
      const y = toY(this.history[i].depth);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Time label
    const t0 = (this.history[0].timeSec / 60).toFixed(1);
    const t1 = (this.history[this.history.length - 1].timeSec / 60).toFixed(1);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillText(`${t0} ${t('unitMin')}`, padL, h - 8);
    ctx.textAlign = 'right';
    ctx.fillText(`${t1} ${t('unitMin')} (${t('chartElapsed')})`, w - padR, h - 8);
    ctx.textAlign = 'left';
  }
}
