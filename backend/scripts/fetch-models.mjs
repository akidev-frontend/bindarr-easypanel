// Fetch the CollectorVision corner-detection model into CV_MODEL_DIR.
//
// The model is not in this repository and not baked into the container image,
// which is a licensing decision rather than an oversight: it is AGPL-3.0 while
// Bindarr is MIT, so the operator fetches it deliberately instead of receiving it
// inside an MIT-licensed artifact. Nothing runs this automatically.
//
// Card IDENTIFICATION does not need a model on the server: it is a generative
// vision model configured in Admin → Instance Settings (see utils/visionApi).
// This model only finds the card in the frame so the browser can draw the live
// outline and fire auto-capture.
//
//   node scripts/fetch-models.mjs
//
// In a container:  docker exec bindarr node scripts/fetch-models.mjs
//
// Sizes are asserted, not assumed: a truncated ONNX file fails at session
// creation with a protobuf error that says nothing about the download.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const MODEL_DIR = process.env.CV_MODEL_DIR
  || path.join(import.meta.dirname, '..', 'data', 'models');

// One descriptor table, shared with the admin panel's download button
// (backend/src/utils/modelAssets.js). Two copies of a byte size is two chances to
// assert the wrong one.
const { MODELS, LICENSE } = createRequire(import.meta.url)('../src/utils/modelAssets.js');
const HF = 'https://huggingface.co';

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function fetchOne({ name, repo, file, bytes }) {
  const dest = path.join(MODEL_DIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size === bytes) {
    console.log(`  ${name}: already present (${mb(bytes)})`);
    return 'present';
  }
  const url = `${HF}/${repo}/resolve/main/${file}`;
  process.stdout.write(`  ${name}: downloading ${mb(bytes)} from ${repo}... `);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== bytes) {
    throw new Error(`${name} came back ${buf.length} bytes, expected ${bytes} — refusing to write it`);
  }
  // Write-then-rename, so an interrupted run cannot leave a half file that looks
  // finished to the next one.
  fs.writeFileSync(`${dest}.tmp`, buf);
  fs.renameSync(`${dest}.tmp`, dest);
  console.log('ok');
  return 'fetched';
}

console.log(`Target: ${MODEL_DIR}`);
console.log(`cornelius is ${LICENSE.spdx} (${LICENSE.urls.join(', ')}).`);
console.log('Bindarr is MIT. Running it in your own install is your call to make;');
console.log('shipping it onward is a licensing decision.');

fs.mkdirSync(MODEL_DIR, { recursive: true });
let fetched = 0;
for (const item of MODELS) {
  if ((await fetchOne(item)) === 'fetched') fetched++;
}
console.log(`${fetched} file(s) downloaded, ${MODELS.length - fetched} already present.`);
console.log('Card identification needs a vision model: set the endpoint, model and API key in Admin → Instance Settings.');
