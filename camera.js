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
    this.track = null;
    this.torchEnabled = false;
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
      const caps = this.track.getCapabilities();
      if (!caps.torch) {
        this.msg.textContent = "💡 Linterna no disponible";
        return;
      }
      this.torchEnabled = !this.torchEnabled;
      await this.track.applyConstraints({ advanced: [{ torch: this.torchEnabled }] });
      this.msg.textContent = this.torchEnabled
        ? "💡 Linterna encendida"
        : "💡 Linterna apagada";
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
    this.container.className = 'bad';
    this.msg.textContent = 'Cámara detenida';
  }

  monitor() {
    this.focusTimer = setInterval(() => {
      if (!this.video.videoWidth) return;

      const score = this.focusScore();
      const brightness = this.brightnessScore();

      // ⚙️ Modo permisivo: enfoque y luz flexibles
      let state = 'bad';
      if (score > 25 && brightness > 25 && brightness < 250) state = 'good';
      else if (score > 15 && brightness > 20 && brightness < 255) state = 'mid';
      else state = 'bad';

      this.container.className = state;

      if (state === 'good') {
        this.msg.textContent = '✅ Listo para capturar';
        this.goodCount++;
      } else if (state === 'mid') {
        this.msg.textContent = '🟡 Casi listo, ajusta un poco';
        this.goodCount = 0;
      } else {
        this.msg.textContent = '🔴 Demasiado borroso o con reflejos';
        this.goodCount = 0;
      }

      // 🔁 Auto-disparo tras 0.6 s estable (2 ciclos)
      if (this.goodCount >= 2) {
        this.goodCount = 0;
        this.capture();
      }
    }, 300);
  }

  manualCapture() {
    if (!this.active) return;
    this.msg.textContent = '📸 Captura manual solicitada';
    this.capture();
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
    this.msg.textContent = '📸 Imagen capturada';
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

    return variance / 100; // normalizado
  }

  // ---- Detección de brillo ----
  brightnessScore() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.video, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4)
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
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

    ctx.putImageData(img, 0, 0);
  }
}
