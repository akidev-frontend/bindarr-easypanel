// Where the live detector's model is fetched from.
//
// Pure on purpose: cardDetector owns the worker and the network, this owns the
// one decision that broke the native app (issue #80) and is worth a test.

export const MODEL_PATH = '/models/cornelius.onnx';

// The model lives on the Bindarr server. On the web that is the page's own
// origin, so the relative path is right. In the native app the page's origin is
// the BUNDLED assets, which have no /models route — the SPA fallback answers with
// index.html, and the scanner silently dropped to the ~1 fps contour detector.
export function modelUrl(native, serverUrl) {
  return native ? `${serverUrl || ''}${MODEL_PATH}` : MODEL_PATH;
}
