// Stack images vertically for review: node cmp.js out.png maxWidth img1 img2 ...
const sharp = require((process.env.LAB_REPO || process.cwd()) + '/node_modules/sharp');
(async () => {
  const [out, maxW, ...files] = process.argv.slice(2);
  const metas = await Promise.all(files.map((f) => sharp(f).metadata()));
  let y = 0; const comps = [];
  for (let i = 0; i < files.length; i += 1) { comps.push({ input: files[i], left: 0, top: y }); y += metas[i].height + 14; }
  const W = Math.max(...metas.map((m) => m.width));
  const buf = await sharp({ create: { width: W, height: y, channels: 3, background: '#f00' } }).composite(comps).png().toBuffer();
  await sharp(buf).resize({ width: Math.min(W, Number(maxW)) }).png().toFile(out);
})();
