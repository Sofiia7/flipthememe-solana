// Writes dist/serve/index.html: a one-button download page for the newest APK in dist/serve, for
// installing a build on a phone over the same Wi-Fi (no internet, no hosting).
//
//   node apps/mobile/scripts/lan-page.mjs          (from the repository root)
//   python -m http.server 8000 --bind 0.0.0.0      (run inside dist/serve; Windows asks once to allow it)
//
// Then open the printed address on the phone. Release builds are FlipTheMeme-<version>-<build>.apk,
// development clients FlipTheMeme-devclient-<version>-<build>.apk; the newest release build gets the button.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = join(root, 'dist', 'serve');

const NAME = /^FlipTheMeme-(devclient-)?(\d+\.\d+\.\d+)-(\d+)\.apk$/;
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mb = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;

const builds = readdirSync(dir)
  .map((file) => {
    const m = NAME.exec(file);
    if (!m) return null;
    const stat = statSync(join(dir, file));
    return { file, dev: !!m[1], version: m[2], build: Number(m[3]), size: stat.size, modified: stat.mtime };
  })
  .filter(Boolean)
  .sort((a, b) => b.build - a.build);

const releases = builds.filter((b) => !b.dev);
const devclients = builds.filter((b) => b.dev);
const newest = releases[0];
if (!newest) {
  console.error(`No FlipTheMeme-<version>-<build>.apk in ${dir}`);
  process.exit(1);
}
const sha = createHash('sha256').update(readFileSync(join(dir, newest.file))).digest('hex');
const when = (d) => d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

const olderRows = (list) =>
  list.map((b) => `<li><a href="${escape(b.file)}">${escape(b.file)}</a> <span>${mb(b.size)}, ${escape(when(b.modified))}</span></li>`).join('\n');

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>FlipTheMeme: установка</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #100d1f; color: #e6e0f1; font-family: system-ui, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 28px 20px 48px; }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: 1px; }
  .sub { color: #a89aba; margin: 0 0 24px; }
  a.go { display: block; text-align: center; text-decoration: none; background: #f4bf3d; color: #2a1a00; font-weight: 800; font-size: 22px; padding: 22px 12px; border-radius: 12px; box-shadow: 0 0 18px #ffe14d66; }
  .meta { margin: 14px 0 0; color: #a89aba; font-size: 14px; line-height: 1.5; word-break: break-all; }
  ol { padding-left: 20px; line-height: 1.55; }
  .warn { background: #2a1530; border: 1px solid #6b2d4a; border-radius: 10px; padding: 12px 14px; margin: 18px 0; font-size: 15px; line-height: 1.5; }
  h2 { font-size: 16px; margin: 28px 0 8px; color: #b46cff; }
  ul { padding-left: 18px; line-height: 1.7; font-size: 14px; }
  li span { color: #8a809c; }
  a { color: #e0c1ff; }
</style>
</head>
<body>
<main>
  <h1>FLIPTHEMEME</h1>
  <p class="sub">Сборка ${newest.build} (версия ${escape(newest.version)}), devnet, тестовые SOL</p>
  <a class="go" href="${escape(newest.file)}">СКАЧАТЬ APK, ${mb(newest.size)}</a>
  <p class="meta">${escape(newest.file)}<br>собрана ${escape(when(newest.modified))}<br>sha256 ${sha}</p>
  <h2>Как поставить</h2>
  <ol>
    <li>Телефон и ноутбук в одной сети Wi-Fi, ноутбук не спит.</li>
    <li>Нажми кнопку, дождись загрузки.</li>
    <li>Открой файл. Если телефон просит, разреши этому браузеру устанавливать приложения.</li>
    <li>Открой FlipTheMeme. Кошелёк: Seed Vault Wallet (Settings, Network, Devnet) или Solflare.</li>
  </ol>
  <div class="warn">Если стоит сборка с другой подписью (например dev client), Android не даст обновить поверх: сначала удали старую. Ключ устройства сотрётся, деньги в игровом балансе останутся, в приложении нажми «PLAY WITH MY X SOL».</div>
${releases.length > 1 ? `  <h2>Прошлые сборки</h2>\n  <ul>\n${olderRows(releases.slice(1))}\n  </ul>` : ''}
${devclients.length ? `  <h2>Dev client (для Metro)</h2>\n  <ul>\n${olderRows(devclients)}\n  </ul>` : ''}
</main>
</body>
</html>
`;

writeFileSync(join(dir, 'index.html'), html, 'utf8');

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal && /^(192\.168|10\.)/.test(i.address))
  .map((i) => i.address);
console.log(`Page for build ${newest.build} written to ${join(dir, 'index.html')}`);
console.log(lan.length ? `Open on the phone: ${lan.map((a) => `http://${a}:8000`).join('  or  ')}` : 'No LAN address found; check the Wi-Fi connection.');
