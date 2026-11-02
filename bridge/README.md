# EMDX PhotoFrame Bridge

Shows photos from Google Photos, Immich, Synology and the other
[esp32-photoframe-server](https://github.com/aitjcize/esp32-photoframe-server)
sources on a Samsung EMDX (EM32DX) e-paper display.

To the server, the bridge looks like an ESP32 PhotoFrame. Behind that, it
drives the display over MDC: it wakes the display on the frame's rotation
schedule, fetches the next image from the server, pushes it, and puts the
display back to sleep.

The server picks the photo (source, albums, orientation, no recent repeats),
lays it out and tone-maps it (exposure, saturation, contrast / S-curve). It
does **not** dither: the EMDX quantizes and dithers to its Spectra 6 palette
on-device, and that can't be turned off. That needs a server that understands
`display_type: "rgb"` (see [Server support](#server-support)).

## Setup

1. Run the bridge on a machine on the display's network (see below).
2. In esp32-photoframe-server, **Settings → Devices → Add**, with host
   `<bridge-host>:8080`.
3. In the device's settings:
   - **Auto Rotate**: turn it on and set the schedule (e.g. every 2 hours,
     or a few times a day). Rotation mode **URL**, **Use this server**, and
     pick the image source (and albums).
   - **General**: orientation, portrait or landscape.
   - **Processing**: exposure, saturation and contrast for the panel.
   - **Power → Deep sleep**: on (default) for the best battery life. See
     [Sleep](#sleep).
4. Save. The first image is pushed as soon as the display is awake.

## Running

```bash
docker compose -f bridge/docker-compose.yml up -d --build
```

Or without Docker (Node.js 20+):

```bash
cd bridge && npm install
EMDX_HOST=192.168.1.37 EMDX_PIN=000000 TZ=America/Los_Angeles npm start
```

**Host networking is required** in Docker: the display downloads each image
from the bridge, so the bridge must be reachable at the host's LAN address,
and Wake-on-LAN broadcasts must reach the LAN.

| Variable | Description | Default |
| --- | --- | --- |
| `EMDX_HOST` | Display IP address | required |
| `EMDX_PIN` | Display PIN | required |
| `EMDX_MAC` | Display MAC, for Wake-on-LAN | |
| `TZ` | Time zone; must match the display's clock | system |
| `BRIDGE_PORT` | Port for the server and the display | `8080` |
| `ADVERTISE_HOST` | LAN IP the display downloads from | the local address on the route to the display |
| `ADVERTISE_URL` | Full base URL instead of `ADVERTISE_HOST` + port | |
| `EMDX_ROTATION` | Extra rotation for how the display is mounted (0/90/180/270) | `0` |
| `EMDX_WIDTH`, `EMDX_HEIGHT` | Panel size in landscape | `2560`, `1440` |
| `AWAKE_MINUTES` | How long the display stays on after an image | `5` |
| `DATA_DIR` | Where config and state are kept | `./data` |

`GET /bridge/status` shows what the bridge is doing (next image, sleep mode,
battery); `GET /bridge/last-push.jpg` is the last image pushed.

## Sleep

The display is battery-powered and keeps its image with the power off, so it
is only on long enough to take an image (`AWAKE_MINUTES`, never more than half
the time to the next one).

- **Deep sleep** (default, with Auto Rotate on): network standby off. The
  display can only wake itself, so the bridge sets its On Timer alarm for the
  next image. The alarm repeats daily, so if the bridge misses a wake it
  retries the next day; for schedules with gaps over 24 hours the extra
  wakes go straight back to sleep.
- **Standby** (Deep sleep off, or Auto Rotate off): network standby on, more
  battery drain. The bridge wakes the display with Wake-on-LAN (`EMDX_MAC`).

A manual push ("Push to frame" in the server) to a display in deep sleep
waits until the display next wakes.

The schedule and the alarm are local time. Set `TZ` to the display's time
zone (the frame config's `timezone` field is a POSIX rule for ESP32 firmware
and is not used).

Only one controller per display: don't also drive it from this repo's web UI.

## Server support

The server must send `display_type: "rgb"` frames full-color PNG with tone
mapping only (`epaper-image-convert --skip-dithering
--no-compress-dynamic-range -f png`). Until that is upstream, use a server
built from a branch with it. Without it, the server sends Spectra 6 dithered
images, which the display then dithers a second time.
