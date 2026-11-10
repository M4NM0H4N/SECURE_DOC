// Draws a QR code into a <canvas> using the vendored encoder (window.qrcode, loaded by a classic
// script tag). Nothing leaves the page.
export function drawQr(text, { cell = 4, margin = 4 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'QR code with the verification link');
  if (typeof window.qrcode !== 'function') return canvas;
  const qr = window.qrcode(0, 'M'); // type 0 = smallest that fits
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + margin * 2) * cell;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // always dark on white, in both themes, so scanners can read it
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
  }
  canvas.style.display = 'block';
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  return canvas;
}
