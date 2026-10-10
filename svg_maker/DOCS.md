# SVG Maker

Turn photos into scalable SVG vector files from a simple web page inside Home Assistant.

## How to use
1. Open the Web UI and pick a photo. A crop window appears with the app's suggested crop already in place.
2. Drag the photo to move it, pinch or use the Zoom slider to resize. Choose **Circle**, **Rounded**, **Square** or **Full** (whole photo). **Auto-fit** re-runs the suggestion and **Reset** starts over.
3. Choose **Color** or **Black & white**, set the detail, and tap **Convert to SVG**.
4. Preview the result, type the file name you want, then tap **Save locally** (saves to your Save folder), **Download** (to your device) or **Both**.

**Auto-crop** finds whatever stands out most in the photo and centers the crop on it. It is not face detection, so check it and nudge if needed. **Auto-enhance** boosts contrast, smooths texture and simplifies colors so photos trace into clean shapes and smaller files. Because the crop is made in your browser, phone photos in formats like HEIC also work if your browser can open them.

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
| `crop_editor` | `true` | Show the drag and zoom crop window after you pick a photo. |
| `auto_crop` | `true` | Auto-suggest the crop. With the editor off, the auto crop is applied without asking. |
| `crop_shape` | `circle` | `circle`, `rounded`, `square` or `none` (whole photo). Changeable on the page. |
| `crop_padding` | `15` | Extra space around the detected subject, in percent. |
| `output_size` | `512` | Cropped photo is shrunk to this many pixels before tracing. |
| `auto_enhance` | `true` | Contrast, noise smoothing and color simplifying before tracing. Changeable on the page. |

Restart the app after changing options.

## Tips
- Works best on logos, drawings, signatures and images with clear shapes.
- iPhone photo failing? Settings, Camera, Formats, **Most Compatible** (HEIC is not supported).
- Slow on a Raspberry Pi? Lower `max_image_dimension` or the detail slider.
