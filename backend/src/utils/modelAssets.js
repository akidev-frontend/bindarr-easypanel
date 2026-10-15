// The scan engine's downloadable piece, and the one place that describes it.
//
// Scanning has two halves. DETECTION runs locally in the browser (cornelius, via
// onnxruntime-web): it finds the card's corners so the scanner can draw the live
// outline and fire auto-capture. IDENTIFICATION is a generative vision model
// configured in Admin → Instance Settings (utils/visionApi) — it is called over
// HTTP and needs nothing installed on the server.
//
// That leaves exactly one thing to download:
//
//   MODEL (cornelius, ~3.2 MB) — the corner detector. Nothing scans without it,
//   and it is the same file for every install. NOT in this repository and NOT
//   baked into the container image: it is AGPL-3.0 while Bindarr is MIT, so
//   shipping it inside an MIT artifact is a licensing decision this project
//   declines to make for its operators. Fetching it into your own install is your
//   call, which is why this is a button and not a background task.
const fs = require('fs');
const path = require('path');

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', '..', 'data', 'models');
const HF = 'https://huggingface.co';

// Sizes are asserted, not assumed. A truncated ONNX file fails at session
// creation with a protobuf error that says nothing about the download.
const MODELS = [
  { name: 'cornelius.onnx', repo: 'HanClinto/ccgdetector-fastweb-single', file: 'fastweb-single-1.39.onnx', bytes: 3185226 },
];

const CATALOGS = [];

const LICENSE = {
  spdx: 'MIT / AGPL-3.0',
  urls: ['https://huggingface.co/HanClinto/ccgdetector-fastweb-single'],
};

const assetPath = (a) => path.join(MODEL_DIR, a.name);
// Present means present AND the right size. A half-written file from a killed
// container reads as installed otherwise, and then fails at inference time.
// Supports both new fastweb-single (3.19 MB) and previous cornelius (4.41 MB).
const isPresent = (a) => {
  try {
    const sz = fs.statSync(assetPath(a)).size;
    if (a.name === 'cornelius.onnx') return sz === a.bytes || sz === 4407545;
    return sz === a.bytes;
  } catch { return false; }
};

// One download at a time: it is a few megabytes from someone else's free CDN.
let current = null;
const state = () => (current ? { ...current } : null);
let last = null;
const lastResult = () => last;

function status() {
  return {
    dir: MODEL_DIR,
    license: LICENSE,
    models: MODELS.map(a => ({ name: a.name, bytes: a.bytes, present: isPresent(a) })),
    catalogs: CATALOGS.map(a => ({
      name: a.name, game: a.game, bytes: a.bytes, snapshot: a.snapshot, present: isPresent(a),
    })),
    progress: state(),
    last,
  };
}

// Stream to a temp file and rename, so an interrupted download cannot leave a
// half file that the size check above would have to catch later.
async function fetchAsset(a, onProgress) {
  const dest = assetPath(a);
  if (isPresent(a)) return 'present';
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const res = await fetch(`${HF}/${a.repo}/resolve/main/${a.file}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow', signal: AbortSignal.timeout(900000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${a.name}`);
  const tmp = `${dest}.tmp`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      onProgress?.(got);
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (got !== a.bytes) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${a.name} came back ${got} bytes, expected ${a.bytes} — refusing to install it`);
  }
  fs.renameSync(tmp, dest);
  return 'fetched';
}

// `what`: 'models'. Returns the progress record; the caller polls status() rather
// than waiting.
function start(what) {
  if (current) throw new Error('a download is already running');
  const wanted = what === 'models' ? MODELS : [];
  if (!wanted.length) throw new Error(`nothing to download for "${what}"`);

  const job = {
    what, name: wanted[0].name, done: 0,
    total: wanted.reduce((n, a) => n + a.bytes, 0),
    phase: 'downloading', message: '',
  };
  current = job;
  (async () => {
    let base = 0, fetched = 0;
    try {
      for (const a of wanted) {
        job.name = a.name;
        const result = await fetchAsset(a, (got) => { job.done = base + got; });
        if (result === 'fetched') fetched++;
        base += a.bytes;
        job.done = base;
      }
      job.phase = 'done';
      job.message = `${fetched} file(s) downloaded, ${wanted.length - fetched} already present`;
    } catch (e) {
      job.phase = 'error';
      job.message = e.message;
      console.error(`model download failed (${what}):`, e.message);
    } finally {
      last = { ...job, finishedAt: Date.now() };
      current = null;
    }
  })();
  return state();
}

module.exports = { MODELS, CATALOGS, LICENSE, MODEL_DIR, status, start, state, lastResult, isPresent };
