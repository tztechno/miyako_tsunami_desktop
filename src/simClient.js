/**
 * Main-thread handle for the simulation worker. Holds the latest frame/stats
 * and offers promise-based requests (advance for recording, CSV export).
 */
export class SimClient {
  constructor({ meta, ground, buildings, seawallMgr, renderStep, onFrame }) {
    this.meta = meta;
    this.onFrame = onFrame;
    this.stats = null;
    this.simTimeSec = 0;
    this.point = null;
    this.frame = null;
    this.pending = new Map();
    this.nextReq = 1;

    this.worker = new Worker(new URL('./simWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => console.error('Simulation worker error:', e.message || e);
    this.worker.postMessage({
      type: 'init',
      meta,
      ground: ground.slice(),
      buildings,
      renderStep,
      barrierGrid: seawallMgr.barrierGrid.slice(),
      barrierActive: seawallMgr.barrierActive.slice(),
    });
  }

  handle(m) {
    if (m.type === 'frame') {
      // Return the previous frame's buffers to the worker for reuse
      if (this.frame) this.recycle(this.frame);
      this.frame = m.frame;
      this.stats = m.stats;
      this.simTimeSec = m.simTimeSec;
      this.point = m.point;
      this.surveyMax = m.surveyMax;
      this.onFrame?.(m);
      if (m.reqId != null) {
        this.pending.get(m.reqId)?.(m);
        this.pending.delete(m.reqId);
      }
    } else if (m.type === 'batchDone') {
      this.pending.get(m.reqId)?.(m);
      this.pending.delete(m.reqId);
    } else if (m.type === 'csv') {
      this.pending.get(m.reqId)?.(m.csv);
      this.pending.delete(m.reqId);
    }
  }

  recycle(frame) {
    this.worker.postMessage({ type: 'recycle', frame }, [frame.eta.buffer, frame.depth.buffer, frame.maxDepth.buffer, frame.foam.buffer, frame.bldgWet.buffer]);
  }

  request(msg) {
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker.postMessage({ ...msg, reqId });
    });
  }

  setScenario(scenario) {
    const sc = { ...scenario };
    if (sc.waveProfile && typeof sc.waveProfile.serialize === 'function') {
      sc.waveProfile = sc.waveProfile.serialize();
    }
    this.worker.postMessage({ type: 'scenario', scenario: sc });
  }

  setWaveProfile(profile) {
    const serialized = profile && typeof profile.serialize === 'function' ? profile.serialize() : profile;
    this.worker.postMessage({ type: 'waveProfile', profile: serialized });
  }

  injectWave(params) {
    this.worker.postMessage({ type: 'injectWave', params });
  }

  setCustomWave(params) { this.worker.postMessage({ type: 'customWave', params }); }
  /** Still-water level (T.P. m) under the tsunami; restarts the run. */
  setTide(level) { this.worker.postMessage({ type: 'tide', level }); }
  reset() { this.worker.postMessage({ type: 'reset' }); }
  play() { this.worker.postMessage({ type: 'play' }); }
  pause() { this.worker.postMessage({ type: 'pause' }); }
  setPoint(point) { this.worker.postMessage({ type: 'point', point }); }
  setSurveyCells(cells) { this.worker.postMessage({ type: 'survey', cells }); }
  advance(seconds) { return this.request({ type: 'advance', seconds }); }
  csv() { return this.request({ type: 'csv' }); }
  /** Reset and run to durationSec; resolves with { summaryCsv, times, rows, maxDepth, arrival } or { cancelled }. */
  batch(durationSec, cells, sampleEvery = 5) { return this.request({ type: 'batch', durationSec, cells, sampleEvery }); }
  cancelBatch() { this.worker.postMessage({ type: 'batchCancel' }); }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
