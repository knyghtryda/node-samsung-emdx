import { randomUUID } from 'node:crypto';

// EMDX displays don't accept image bytes over MDC. They are told (MDC 0xC7)
// to download a content manifest from an HTTP server, then fetch the image
// the manifest points to. ContentServer is that HTTP side: mount handle() on
// any Node/Express server the display can reach, then push().

export function buildContentManifest({ imageUrl, fileId, fileSize }) {
  const fileName = `${fileId}.jpg`;
  return {
    schedule: [{
      start_date: '1970-01-01', stop_date: '2999-12-31', start_time: '00:00:00',
      contents: [{
        image_url: imageUrl, file_id: fileId,
        file_path: `/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/${fileId}/${fileName}`,
        duration: 91326, file_size: `${fileSize}`, file_name: fileName,
      }],
    }],
    name: 'node-samsung-emdx', version: 1,
    create_time: new Date().toISOString().replace('T', ' ').slice(0, 19),
    id: fileId, program_id: 'com.samsung.ios.ePaper',
    content_type: 'ImageContent', deploy_type: 'MOBILE',
  };
}

// The display's parser expects JSON with escaped slashes, as Samsung's own
// app sends it
export function serializeContentManifest(manifest) {
  return JSON.stringify(manifest).replaceAll('/', '\\/');
}

export default class ContentServer {

  _pending = new Map(); // pushId -> { image, manifest, resolve }

  // baseUrl: how the DISPLAY reaches this server, e.g. http://192.168.1.10:8080
  constructor({ baseUrl, pathPrefix = '/emdx' }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.pathPrefix = pathPrefix;
  }

  // Request handler for (req, res). Returns false when the URL isn't ours,
  // so it can sit in front of other routes.
  handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(`${this.pathPrefix}/`)) return false;
    const [pushId, file] = url.pathname.slice(this.pathPrefix.length + 1).split('/');
    const entry = this._pending.get(pushId);

    if (!entry || !['content.json', 'image'].includes(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"Not found"}');
      return true;
    }

    if (file === 'content.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(serializeContentManifest(entry.manifest));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': entry.image.length });
    res.end(entry.image);
    // Resolve once the bytes are out, not when the request arrives
    res.once('finish', () => {
      this._pending.delete(pushId);
      entry.resolve();
    });
    return true;
  }

  // Tell the display to download `image` (a JPEG buffer) and resolve once it
  // has. Connects and disconnects the device; it must already be awake.
  async push(device, image, { timeout = 30_000 } = {}) {
    const pushId = randomUUID().toUpperCase();
    const fileId = randomUUID().toUpperCase();
    const base = `${this.baseUrl}${this.pathPrefix}/${pushId}`;
    const contentUrl = `${base}/content.json`;

    let timer;
    const served = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this._pending.delete(pushId);
        reject(new Error(`Display did not download the image within ${timeout / 1000}s`));
      }, timeout);
      this._pending.set(pushId, {
        image,
        manifest: buildContentManifest({ imageUrl: `${base}/image`, fileId, fileSize: image.length }),
        resolve: () => { clearTimeout(timer); resolve(); },
      });
    });

    try {
      await device.connect();
      await device.setNetworkStandby({ enabled: true }).catch(() => {});
      await device.setContentDownload({ url: contentUrl });
    } catch (err) {
      clearTimeout(timer);
      this._pending.delete(pushId);
      throw err;
    } finally {
      await device.disconnect().catch(() => {});
    }

    await served;
    return pushId;
  }

}
