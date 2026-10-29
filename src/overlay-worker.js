// Runs checkImages() off the main thread (see overlay.js): decoding a photo never blocks the server.
import { parentPort, workerData } from 'node:worker_threads';
import { checkImages } from './overlay.js';

const { dataUrl, items, frame, opts } = workerData;
try {
  parentPort.postMessage({ ok: true, out: checkImages(dataUrl, items, frame, opts) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message || e) });
}
