export class SmartCamera {
  constructor({ videoEl, containerEl, messageEl }) {
    this.video = videoEl;
    this.container = containerEl;
    this.msg = messageEl;
    this.active = false;
    this.stream = null;
    this.focusTimer = null;
    this.goodCount = 0;
    this.onReadyToCapture = null;
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      this.video.srcObject = this.stream;
      this.active = true;
      this.msg.textContent = "Cámara iniciada";
      this.tryEnableTorch(); // 🔦 intenta activar linterna
      this.monitor();
    } catch (e) {
      console.error(e);
      this.msg.textContent = "❌ No se pudo acceder a la cámara";
    }
  }

  async tryEnableTorch() {
    try {
      const track = this.stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities();
      if (capabilities.torch) {
        await track.applyConstraints({ advanced: [{ torch: true }] });
        this.msg.textContent = "💡 Linterna activada al mínimo";
      } else {
        console.log("Torch no disponible en esta cámara.");
      }
    } catch (err) {
      console.warn("No se pudo activar linterna:", err);
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
    this.container.className = 'bad';
    this.msg.textContent = 'Cámara detenida';
  }

  monitor() {
    this.focusTimer = setInterval(() => {
      if (!this.video.videoWidth) return;

      const score = this.focusScore();
      const brightness = this.brightnessScore();

      // 🔧 Umbrales más permisivos
      let state = 'bad';
      if (score > 45 && brightness > 30 && brightness < 230) state = 'good';
      else if (score > 25 && brightness > 20 && brightness < 240) state = 'mid';
      else state = 'bad';

      this.container.className = state;

      if (state === 'good') {
        this.msg.textContent = '✅ Enfocado y luz correcta';
        this.goodCount++;
      } else if (state === 'mid') {
        this.msg.textContent = '🟡 Ajusta enfoque o ángulo';
        this.goodCount = 0;
      } else {
        this.msg.textContent = '🔴 Borroso o con reflejos';
        this.goodCount = 0;
      }

      // 🔁 Auto-disparo tras 0.6 s (≈2 ciclos)
      if (this.goodCount >= 2) {
        this.goodCount = 0;
        this.capture();
      }
    }, 300);
  }

  capture() {
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.video, 0, 0);
    this.preprocess(ctx, c.width, c.height);
    c.toBlob(b => {
      if (this.onReadyToCapture) this.onReadyToCapture(b);
    }, 'image/jpeg', 0.9);
    this.msg.textContent = '📸 Imagen capturada automáticamente';
  }

  // ---- Detección de enfoque ----
  focusScore() {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 120;
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

    return variance / 100; // valor normalizado
  }

  // ---- Detección de brillo global ----
  brightnessScore() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.video, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return sum / n; // rango 0–255
  }

  // ---- Preprocesado: grises + contraste ----
  preprocess(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let min = 255, max = 0;
    const gray = new Uint8Array(w * h);

    // Escala de grises + rango dinámico
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[j] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }

    const range = max - min || 1;
    for (let j = 0; j < gray.length; j++) {
      const v = ((gray[j] - min) * 255) / range;
      const k = j * 4;
      d[k] = d[k + 1] = d[k + 2] = v;
    }

    // Suavizado leve para reflejos
    const kernel = [
      [1, 2, 1],
      [2, 4, 2],
      [1, 2, 1]
    ];
    const divisor = 16;
    const src = new Uint8ClampedArray(d);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * w + (x + kx)) * 4;
            sum += src[idx] * kernel[ky + 1][kx + 1];
          }
        }
        const k = (y * w + x) * 4;
        const val = sum / divisor;
        d[k] = d[k + 1] = d[k + 2] = val;
      }
    }

    ctx.putImageData(img, 0, 0);
  }
}
