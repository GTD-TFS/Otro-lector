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
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    this.video.srcObject = this.stream;
    this.active = true;
    this.monitor();
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
      let state = 'bad';
      if (score > 80 && brightness > 40 && brightness < 210) state = 'good';
      else if (score > 40 && brightness > 30 && brightness < 230) state = 'mid';
      else state = 'bad';

      this.container.className = state;
      if (state === 'good') {
        this.msg.textContent = '✅ Enfocado y luz correcta';
        this.goodCount++;
      } else if (state === 'mid') {
        this.msg.textContent = '🟡 Ajusta un poco el enfoque o la luz';
        this.goodCount = 0;
      } else {
        this.msg.textContent = '🔴 Borroso o con reflejos';
        this.goodCount = 0;
      }

      if (this.goodCount >= 3) { // ~1 segundo estable
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
  }

  focusScore() {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 120;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.video, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const gray = new Float32Array(c.width * c.height);
    for (let i = 0, j = 0; i < d.length; i += 4, j++)
      gray[j] = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    let mean = 0;
    for (let g of gray) mean += g;
    mean /= gray.length;
    let variance = 0;
    for (let g of gray) variance += (g - mean) ** 2;
    variance /= gray.length;
    return variance / 100; // normalizado
  }

  brightnessScore() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 48;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.video, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4)
      sum += 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    return sum / n; // 0–255
  }

  preprocess(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    // Convertir a gris + mejorar contraste
    let min = 255, max = 0;
    const gray = new Uint8Array(w*h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const g = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
      gray[j] = g; if (g<min)min=g; if(g>max)max=g;
    }
    const range = max - min || 1;
    for (let j=0;j<gray.length;j++){
      const v = (gray[j]-min)*255/range;
      const k = j*4;
      d[k]=d[k+1]=d[k+2]=v;
    }
    ctx.putImageData(img,0,0);
  }
}
