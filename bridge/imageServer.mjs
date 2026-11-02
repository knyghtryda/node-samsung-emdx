// Fetch the next image from esp32-photoframe-server the way a frame does:
// GET the configured image_url with the frame's token, telling the server
// the panel size, orientation and processing settings in headers. The
// server picks the photo (source, albums, orientation, recent-history
// exclusion), lays it out and tone-maps it; for display_type "rgb" it skips
// dithering and answers full-color PNG.

export async function fetchFrameImage({ store, frame, onConfig = () => {} }) {
  const { config, processing, state } = store;
  if (!config.image_url) {
    throw new Error('No image URL: set this frame\'s image source in esp32-photoframe-server');
  }

  const [width, height] = frame.dims();
  const headers = {
    'X-Display-Width': `${width}`,
    'X-Display-Height': `${height}`,
    'X-Display-Orientation': config.display_orientation === 'portrait' ? 'portrait' : 'landscape',
    'X-Processing-Settings': JSON.stringify(processing),
    'X-Firmware-Version': frame.version,
    'X-Config-Last-Updated': `${state.configLastUpdated}`,
  };
  if (Number.isFinite(state.battery)) headers['X-Battery-Percentage'] = `${state.battery}`;
  if (config.access_token) headers.Authorization = `Bearer ${config.access_token}`;

  // Generous: AI-generated sources take a while
  const res = await fetch(config.image_url, { headers, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Image server answered ${res.status}${body ? `: ${body}` : ''}`);
  }

  // The server hands newer config down with the image when it couldn't
  // push it directly
  const payload = res.headers.get('X-Config-Payload');
  if (payload) {
    try {
      const { config: cfg, processing_settings: proc, color_palette: palette } = JSON.parse(payload);
      if (cfg) store.updateConfig(cfg);
      if (proc) store.replaceProcessing(proc);
      if (palette) store.replacePalette(palette);
      onConfig();
    } catch {
      // A malformed payload must not cost us the image
    }
  }

  return Buffer.from(await res.arrayBuffer());
}
