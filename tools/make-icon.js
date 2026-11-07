// Делает иконку приложения и логотип для шапки из исходного логотипа.
// Перекрашивает розовый в цвет интерфейса (--accent) и убирает фон вокруг круга.
//
// Запуск (из папки проекта):
//   node_modules\electron\dist\electron.exe tools/make-icon.js [build/logo-source.webp]
//
// Результат:
//   build/icon.png                  — иконка приложения и установщика (512×512)
//   src/renderer/assets/icon.png    — иконка окна (256×256)
//   src/renderer/assets/logo.png    — логотип в шапке (128×128)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ACCENT = [224, 0, 90]; // #e0005a — как --accent в styles.css
const SRC = path.resolve(process.argv.slice(1).find((a) => /\.(webp|png|jpe?g)$/i.test(a)) || path.join(ROOT, 'build', 'logo-source.webp'));
const OUTPUTS = [
  { size: 512, file: path.join(ROOT, 'build', 'icon.png') },
  { size: 256, file: path.join(ROOT, 'src', 'renderer', 'assets', 'icon.png') },
  { size: 128, file: path.join(ROOT, 'src', 'renderer', 'assets', 'logo.png') },
];

// Выполняется внутри скрытого окна: там есть canvas и декодеры webp/png/jpeg.
function processInPage(dataUrl, accent, sizes) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;

      // «Розовость» пикселя: розовый в исходнике почти без зелёного канала, белый — с полным.
      // Прозрачный фон розовым не считается.
      const pink = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) pink[i] = px[i * 4 + 3] < 128 ? 0 : 1 - px[i * 4 + 1] / 255;

      // Границы круга: строки и столбцы, где розового заметно много (мелкие соринки отсекаются)
      const rows = new Uint32Array(h);
      const cols = new Uint32Array(w);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (pink[y * w + x] > 0.5) {
            rows[y]++;
            cols[x]++;
          }
      const span = (arr, min) => {
        let a = 0;
        let b = arr.length - 1;
        while (a < arr.length && arr[a] < min) a++;
        while (b > 0 && arr[b] < min) b--;
        return [a, b];
      };
      const [top, bottom] = span(rows, w * 0.01);
      const [left, right] = span(cols, h * 0.01);
      const cx = (left + right + 1) / 2;
      const cy = (top + bottom + 1) / 2;
      const r = (right - left + bottom - top + 2) / 4;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const t = px[i * 4 + 3] ? 1 - px[i * 4 + 1] / 255 : 0;
          const srcAlpha = px[i * 4 + 3] / 255;
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          const alpha = Math.max(0, Math.min(1, r - d + 0.5)); // сглаженный край круга
          px[i * 4] = Math.round(accent[0] * t + 255 * (1 - t));
          px[i * 4 + 1] = Math.round(accent[1] * t + 255 * (1 - t));
          px[i * 4 + 2] = Math.round(accent[2] * t + 255 * (1 - t));
          px[i * 4 + 3] = Math.round(alpha * srcAlpha * 255);
        }
      }
      ctx.putImageData(data, 0, 0);

      // Квадрат вокруг круга с небольшим отступом, уменьшение в несколько шагов — для чёткости
      const pad = r * 0.03;
      const sx = cx - r - pad;
      const sy = cy - r - pad;
      const side = (r + pad) * 2;
      const out = {};
      for (const size of sizes) {
        let cur = c;
        let curX = sx;
        let curY = sy;
        let curSide = side;
        while (curSide / 2 > size) {
          const half = document.createElement('canvas');
          half.width = half.height = Math.ceil(curSide / 2);
          const hc = half.getContext('2d');
          hc.imageSmoothingQuality = 'high';
          hc.drawImage(cur, curX, curY, curSide, curSide, 0, 0, half.width, half.height);
          cur = half;
          curX = curY = 0;
          curSide = half.width;
        }
        const o = document.createElement('canvas');
        o.width = o.height = size;
        const oc = o.getContext('2d');
        oc.imageSmoothingQuality = 'high';
        oc.drawImage(cur, curX, curY, curSide, curSide, 0, 0, size, size);
        out[size] = o.toDataURL('image/png');
      }
      resolve({ out, circle: { cx, cy, r, w, h } });
    };
    img.src = dataUrl;
  });
}

app.whenReady().then(async () => {
  try {
    const ext = path.extname(SRC).slice(1).toLowerCase().replace('jpg', 'jpeg');
    const dataUrl = `data:image/${ext};base64,${fs.readFileSync(SRC).toString('base64')}`;
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
    await win.loadURL('about:blank');
    const { out, circle } = await win.webContents.executeJavaScript(
      `(${processInPage.toString()})(${JSON.stringify(dataUrl)}, ${JSON.stringify(ACCENT)}, ${JSON.stringify(OUTPUTS.map((o) => o.size))})`
    );
    console.log(`Круг: центр ${circle.cx.toFixed(0)},${circle.cy.toFixed(0)}, радиус ${circle.r.toFixed(0)} (изображение ${circle.w}×${circle.h})`);
    for (const o of OUTPUTS) {
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      fs.writeFileSync(o.file, Buffer.from(out[o.size].split(',')[1], 'base64'));
      console.log(`✓ ${path.relative(ROOT, o.file)} (${o.size}×${o.size})`);
    }
    app.exit(0);
  } catch (e) {
    console.error('Ошибка:', e.message);
    app.exit(1);
  }
});
