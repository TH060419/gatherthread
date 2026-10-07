// Pure, editable overlay layout. Screenshot pixels stay in a separate <img>.
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function annotationPage(scene, imageSource, locale) {
  const { width, height } = scene.viewport;
  const compact = width < 600;
  const radius = compact ? 12 : 14;
  const inset = compact ? 2 : 4;
  const overlays = scene.points.map((point, index) => {
    const x = Math.max(2, point.x - inset);
    const y = Math.max(2, point.y - inset);
    const right = Math.min(width - 2, point.x + point.width + inset);
    const bottom = Math.min(height - 2, point.y + point.height + inset);
    let cx = clamp(x - radius - 5, radius + 3, width - radius - 3);
    let cy = clamp(y + Math.min(22, point.height / 2), radius + 3, height - radius - 3);
    // Reviewed positions put badges in empty gutters, never on nearby controls.
    if (scene.name === '01-workspace' && index === 0) { cx = 42; cy = 735; }
    if (scene.name === '03-summary' && index !== 1) { cx = point.x + point.width / 2; cy = point.y - 25; }
    if (scene.name === '04-agent-work' && index === 2) { cx = right + 23; cy = point.y + point.height / 2; }
    if (scene.name === '07-file-service' && index === 0) { cx = right + 23; cy = point.y + point.height / 2; }
    if (scene.name === '10-summary-settings' && index === 0) { cx = point.x + point.width / 2; cy = point.y - 25; }
    if (scene.name === '15-history-controls' && index === 2) { cx = point.x + point.width / 2; cy = point.y - 27; }
    if (['12-phone','13-tablet'].includes(scene.name) && index === 0) { cx = 39; cy = point.y - 21; }
    if (['12-phone','13-tablet'].includes(scene.name) && index === 1) { cx = right + 25; cy = point.y + point.height / 2; }
    const endX = clamp(cx, x, right), endY = clamp(cy, y, bottom);
    const distance = Math.hypot(endX - cx, endY - cy);
    const startX = distance ? cx + (endX - cx) * radius / distance : cx;
    const startY = distance ? cy + (endY - cy) * radius / distance : cy;
    return `<g class="point" data-number="${index + 1}">
      <rect class="halo" x="${x}" y="${y}" width="${right - x}" height="${bottom - y}" rx="${compact ? 7 : 10}"/>
      <rect class="outline" x="${x}" y="${y}" width="${right - x}" height="${bottom - y}" rx="${compact ? 7 : 10}"/>
      <path class="leader-halo" d="M ${startX} ${startY} L ${endX} ${endY}"/>
      <path class="leader" d="M ${startX} ${startY} L ${endX} ${endY}"/>
      <circle class="badge" cx="${cx}" cy="${cy}" r="${radius}"/>
      <text x="${cx}" y="${cy}" font-size="${compact ? 14 : 18}">${index + 1}</text>
    </g>`;
  }).join('');
  const heading = locale === 'zh-CN' ? '重点标注 · 实机界面' : 'Key points · real interface';
  const legend = scene.points.map((point, index) => `<li><span>${index + 1}</span><p>${escape(point.text)}</p></li>`).join('');
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escape(scene.name)} · GatherThread</title>
    <style>
      *{box-sizing:border-box}body{margin:0;background:#fff;color:#203731;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
      main{width:${width}px}.frame{position:relative;width:${width}px;height:${height}px}.frame img{display:block;width:100%;height:100%;object-fit:contain}
      svg{position:absolute;inset:0;overflow:hidden;pointer-events:none}.halo{fill:none;stroke:#fff;stroke-width:${compact ? 4 : 6};stroke-opacity:.8}.outline{fill:none;stroke:#087f73;stroke-width:${compact ? 1.5 : 2.5}}
      .leader-halo{fill:none;stroke:#fff;stroke-width:6}.leader{fill:none;stroke:#087f73;stroke-width:2}.badge{fill:#087f73;stroke:#fff;stroke-width:${compact ? 2 : 3}}text{fill:#fff;font-weight:700;text-anchor:middle;dominant-baseline:central}
      footer{border-top:1px solid #d8e9e4;padding:${compact ? '17px 18px 20px' : '22px 34px 26px'};background:#fff}h2{margin:0 0 ${compact ? 12 : 15}px;font-size:${compact ? 11 : 15}px;font-weight:600;letter-spacing:.05em;color:#6b7b76}
      ol{display:grid;grid-template-columns:repeat(${compact ? 1 : scene.points.length},minmax(0,1fr));gap:${compact ? 12 : 26}px;list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:${compact ? 9 : 12}px;min-width:0}li span{display:grid;place-items:center;width:${compact ? 22 : 30}px;height:${compact ? 22 : 30}px;border-radius:50%;flex:none;background:#e6f3ef;color:#087f73;font-size:${compact ? 13 : 18}px;font-weight:700}p{margin:0;font-size:${compact ? 14 : 23}px;line-height:1.5;font-weight:500}
    </style><main><div class="frame"><img src="${escape(imageSource)}" alt="${locale === 'zh-CN' ? '完整应用界面' : 'Complete application view'}"><svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${overlays}</svg></div><footer><h2>${heading}</h2><ol>${legend}</ol></footer></main>
    <script>window.__ready=false;Promise.all([...document.images].map(image=>image.complete?Promise.resolve():new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject}))).then(()=>document.fonts.ready).then(()=>window.__ready=true);</script></html>`;
}
