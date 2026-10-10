# SVG Maker

Turn photos into scalable SVG vector files from a simple web page inside Home Assistant.

## How to use
1. Open the Web UI, pick a photo, choose **Color** or **Black & white**, set the detail, tap **Convert to SVG**.
2. Preview the result and type the file name you want.
3. Tap **Save locally** (saves to your Save folder), **Download** (to your device) or **Both**.

Every conversion is also auto-saved to the **Temp folder** (default `/homeassistant/www/svg_maker/temp_icons`). When you use Save locally or Both, the temp copy is moved into your Save folder, so only unsaved results stay in temp. Files under `/homeassistant/www` are available in Home Assistant at `/local/...`, for example `/local/svg_maker/temp_icons/name.svg`. If `www` did not exist before, restart Home Assistant once so it starts serving `/local`.

## File access
The app can see these folders: `/homeassistant`, `/share`, `/media`, `/backup`, `/ssl`, `/addons`, `/config` (this app's own config) and `/addon_configs`. It only ever writes to the Save folder and Temp folder you set. Protected system paths are refused.

## Configuration

| Option | Default | What it does |
|---|---|---|
| `log_level` | `info` | `debug`, `info`, `warning` or `error`. |
| `output_path` | `/share/svg_maker` | Where Save locally and Both put files. Created automatically. |
| `temp_path` | `/homeassistant/www/svg_maker/temp_icons` | Auto-save location for results you did not save. |
| `auto_delete_temp` | `false` | Toggle: delete old files from the temp folder. Never touches the Save folder. |
| `auto_delete_after_days` | `7` | Age limit when auto-delete is on. |
| `filename_style` | `original_timestamp` | Naming for temp files. |
| `on_name_conflict` | `rename` | `rename` adds -1, -2. `overwrite` replaces. |
| `default_mode` | `color` | Starting color mode on the page. |
| `default_detail` | `5` | Starting detail (1 to 10). |
| `path_style` | `spline` | `spline`, `polygon` or `none`. |
| `max_image_dimension` | `1600` | Longest side in pixels before tracing. |
| `max_upload_mb` | `25` | Largest upload allowed. |

Restart the app after changing options.

## Tips
- Works best on logos, drawings, signatures and images with clear shapes.
- iPhone photo failing? Settings, Camera, Formats, **Most Compatible** (HEIC is not supported).
- Slow on a Raspberry Pi? Lower `max_image_dimension` or the detail slider.
