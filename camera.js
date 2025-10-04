export class SmartCamera {
  constructor({ videoEl, containerEl, messageEl }) {
    this.video = videoEl;
    this.container = containerEl;
    this.msg = messageEl;
    this.active = false;
    this.stream = null;
    this.focusTimer = null;
    this.goodCount = 0;
    this.onReadyToCapture = null; // (blob) => {}
    this.onAutoBatchReady = null; // (blobs[]) => {}
    this.track = null;
    this.torchEnabled = false;

    // Auto-consenso
    this.autoCollecting = false;
    this.collected = [];
    this.hashes = [];
    this.orientSamples = [];
    this.lastGreenAt = 0;
    this.cooldownMs = 800; // no capturar "verde" más de 1 vez por ~0.8s
    this.targetCount = 5;
    this.timeoutId = null;

    // Orientación (si existe)
    this.lastDeviceOrientation = null;
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', (e) => {
        const { alpha, beta, gamma } = e;
        this.lastDeviceOrientation = { alpha, beta, gamma, t: Date.now() };
      }, { passive: true });
    }
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 1.777 } // 16:9 horizontal
        }
      });
      this.video.srcObject = this.stream;
      this.active = true;
      this.msg.textContent = "Cámara iniciada";
      this.track = this.stream.getVideoTracks()[0];
      this.monitor();
    } catch (e) {
      console.error(e);
      this.msg.textContent = "❌ No se pudo acceder a la cámara";
    }
  }

  async toggleTorch() {
    if (!this.track) return;
    try {
      const caps = this.track.getCapabilities?.() || {};
      if (!caps.torch) {
        this.msg.textContent = "💡 Linterna no disponible";
        return;
      }
      this.torchEnabled = !this.torchEnabled;
      await this.track.applyConstraints({ advanced: [{ torch: this.torchEnabled }] });
      this.msg.textContent = this.torchEnabled ? "💡 Linterna encendida" : "💡 Linterna apagada";
    } catch (err) {
      console.warn("No se pudo cambiar la linterna:", err);
    }
  }

  stop() {
    this.active = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.focusTimer) {
      clearInterval(this.focusTimer);
      this.focusTimer = null;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.autoCollecting = false;
    this.collected = [];
    this.hashes = [];
    this.orientSamples = [];
    this.container.className = 'bad';
    this.msg.textContent = 'Cámara detenida';
  }

  // === Auto-consenso: iniciar recolección hasta N distintas o timeoutMs ===
  startAutoConsensus(n = 5, timeoutMs = 15000) {
    this.targetCount = n;
    this.collected = [];
    this.hashes = [];
    this.orientSamples = [];
    this.autoCollecting = true;
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => {
      this.finishAutoConsensus();
    }, timeoutMs);
    this.msg.textContent = `⏳ Buscando ${n} capturas distintas…`;
  }
  finishAutoConsensus() {
    this.autoCollecting = false;
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
    if (this.onAutoBatchReady) this.onAutoBatchReady(this.collected.slice());
    this.msg.textContent = `📦 Lote listo: ${this.collected.length} imágenes`;
  }

  monitor() {
    this.focusTimer = setInterval(() => {
      if (!this.video.videoWidth) return;

      const score = this.focusScore();
      const brightness = this.brightnessScore();

      // Exigencia 5–6
      let state = 'bad';
      if (score > 35 && brightness > 35 && brightness < 230) state = 'good';
      else if (score > 20 && brightness > 25 && brightness < 245) state = 'mid';
      else state = 'bad';

      this.container.className = state;

      if (state === 'good') {
        this.msg.textContent = this.autoCollecting ? '✅ Buen frame (buscando diversidad)…' : '✅ Enfocado y buena luz';
        this.goodCount++;
      } else if (state === 'mid') {
        this.msg.textContent = '🟡 Ajusta un poco (enfoque/luz)';
        this.goodCount = 0;
      } else {
        this.msg.textContent = '🔴 Borroso o reflejos';
        this.goodCount = 0;
      }

      // Auto-captura (normal)
      if (!this.autoCollecting && this.goodCount >= 3) {
        this.goodCount = 0;
        this.capture((blob) => this.onReadyToCapture && this.onReadyToCapture(blob));
      }

      // Auto-consenso: capturar solo cuando hay buen frame y diversidad
      if (this.autoCollecting && this.goodCount >= 2) {
        const now = Date.now();
        if (now - this.lastGreenAt < this.cooldownMs) return;
        this.lastGreenAt = now;
        // Evaluar diversidad y, si cumple, agregar
        this.capture(async (blob, hash) => {
          const diverse = this.isDiverse(hash, this.lastDeviceOrientation);
          if (diverse) {
            this.collected.push(blob);
            this.hashes.push(hash);
            if (this.lastDeviceOrientation) this.orientSamples.push(this.lastDeviceOrientation);
            this.msg.textContent = `✅ Captura distinta (${this.collected.length}/${this.targetCount})`;
            if (this.collected.length >= this.targetCount) {
              this.finishAutoConsensus();
            }
          } else {
            this.msg.textContent = '↩️ Captura descartada (demasiado similar)';
          }
        });
      }
    }, 300);
  }

  manualCapture() {
    if (!this.active) return;
    this.msg.textContent = '📸 Captura manual';
    this.capture((blob) => this.onReadyToCapture && this.onReadyToCapture(blob));
  }

  // Captura con giro a horizontal + preprocesado + dHash
  capture(cb) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;

    let c = document.createElement('canvas');
    let ctx = null;

    if (vh > vw) { // rotar 90º
      c.width = vh; c.height = vw;
      ctx = c.getContext('2d');
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(this.video, -vw / 2, -vh / 2);
    } else {
      c.width = vw; c.height = vh;
      ctx = c.getContext('2d');
      ctx.drawImage(this.video, 0, 0);
    }

    this.preprocess(ctx, c.width, c.height);
    const hash = this.dhash(c, 8); // 8x8 -> 64 bits
    c.toBlob(b => cb && cb(b, hash), 'image/jpeg', 0.9);
  }

  // Diversidad: Hamming(dHash) >= 12 y, si hay orientación, delta >= 3°
  isDiverse(newHash, orient) {
    if (!newHash) return true;
    for (const old of this.hashes) {
      if (this.hamming(old, newHash) < 12) return false;
    }
    if (orient && this.orientSamples.length) {
      const last = this.orientSamples[this.orientSamples.length - 1];
      const delta = (a, b) => Math.abs((a||0) - (b||0));
      if (Math.max(delta(orient.alpha, last.alpha), delta(orient.beta, last.beta), delta(orient.gamma, last.gamma)) < 3) {
        // muy parecida en orientación
        return false;
      }
    }
    return true;
  }

  // dHash perceptual (grayscale, 9x8 -> compara adyacentes en X, devuelve string bits)
  dhash(canvas, size=8) {
    const w = size + 1, h = size;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0, w, h);
    const img = ctx.getImageData(0,0,w,h).data;
    const gray = [];
    for (let i=0;i<img.length;i+=4){
      gray.push(0.299*img[i] + 0.587*img[i+1] + 0.114*img[i+2]);
    }
    let bits = '';
    for (let y=0;y<h;y++){
      for (let x=0;x<size;x++){
        const i1 = y*w + x;
        const i2 = y*w + x + 1;
        bits += gray[i1] > gray[i2] ? '1' : '0';
      }
    }
    return bits;
  }

  hamming(a,b){
    let d=0; for (let i=0;i<a.length;i++){ if (a[i]!==b[i]) d++; } return d;
  }

  // ---- Detección de enfoque (variance-like) ----
  focusScore() {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 90;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.video, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;

    const gray = new Float32Array(c.width * c.height);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }

    let mean = 0;
    for (const g of gray) mean += g;
    mean /= gray.length;

    let variance = 0;
    for (const g of gray) variance += (g - mean) ** 2;
    variance /= gray.length;

    return variance / 100;
  }

  // ---- Brillo global ----
  brightnessScore() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.video, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return sum / n; // 0..255
  }

  // ---- Preprocesado: gris + estirado de contraste ----
  preprocess(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let min = 255, max = 0;
    const gray = new Uint8Array(w * h);

    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[j] = g; if (g < min) min = g; if (g > max) max = g;
    }
    const range = max - min || 1;
    for (let j = 0; j < gray.length; j++) {
      const v = ((gray[j] - min) * 255) / range;
      const k = j * 4;
      d[k] = d[k + 1] = d[k + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }
}
