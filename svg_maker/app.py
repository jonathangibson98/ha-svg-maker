import os, re, io, json, time, uuid, logging, tempfile, shutil
from collections import OrderedDict
from flask import Flask, request, send_from_directory, jsonify
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
import vtracer

OPTIONS_FILE = os.environ.get("OPTIONS_FILE", "/data/options.json")
STATIC_DIR = os.environ.get("STATIC_DIR", "/static")
PORT = int(os.environ.get("PORT", 8099))

DEFAULTS = {
    "log_level": "info",
    "output_path": "/share/svg_maker",
    "temp_path": "/homeassistant/www/svg_maker/temp_icons",
    "auto_delete_temp": False, "auto_delete_after_days": 7,
    "filename_style": "original_timestamp", "on_name_conflict": "rename",
    "default_mode": "color", "default_detail": 5, "path_style": "spline",
    "max_image_dimension": 1600, "max_upload_mb": 25,
    "crop_editor": True, "auto_crop": True, "crop_shape": "circle",
    "crop_padding": 15, "output_size": 512, "auto_enhance": True,
}
BLOCKED = ("/proc", "/sys", "/dev", "/etc", "/bin", "/sbin", "/usr", "/lib",
           "/lib64", "/run", "/var", "/root", "/boot", "/static")
KNOWN = ("/homeassistant", "/share", "/media", "/backup", "/ssl", "/config",
         "/data", "/addon_configs", "/addons")

def load_options():
    opts = dict(DEFAULTS)
    try:
        with open(OPTIONS_FILE) as f:
            opts.update(json.load(f))
    except Exception:
        pass
    return opts

opt = load_options()
logging.basicConfig(
    level=getattr(logging, str(opt["log_level"]).upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("svg_maker")

def clean_path(p, default, label):
    p = str(p or "").strip()
    if not p.startswith("/"):
        log.error("%s must be an absolute path starting with /. Using default %s", label, default)
        return default
    n = os.path.normpath(p)
    if n == "/" or any(n == b or n.startswith(b + "/") for b in BLOCKED):
        log.error("%s %s is a protected system location. Using default %s", label, n, default)
        return default
    if not any(n == k or n.startswith(k + "/") for k in KNOWN):
        log.warning("%s %s is not inside a Home Assistant mapped folder. It may disappear when the app restarts.", label, n)
    return n

OUT = clean_path(opt["output_path"], DEFAULTS["output_path"], "Save folder")
TEMP = clean_path(opt["temp_path"], DEFAULTS["temp_path"], "Temp folder")

def ensure_dir(path):
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".write_test")
        open(probe, "w").close()
        os.remove(probe)
        return True
    except Exception as e:
        log.error("Cannot write to %s (%s)", path, e)
        return False

def temp_url(path):
    base = "/homeassistant/www/"
    if path and path.startswith(base):
        return "/local/" + path[len(base):]
    return ""

def cleanup_temp():
    if not opt["auto_delete_temp"] or not os.path.isdir(TEMP):
        return
    cutoff = time.time() - int(opt["auto_delete_after_days"]) * 86400
    removed = 0
    try:
        for n in os.listdir(TEMP):
            p = os.path.join(TEMP, n)
            if n.lower().endswith(".svg") and os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                with open(p, "rb") as f:
                    head = f.read(400)
                if b"VTracer" in head:
                    os.remove(p)
                    removed += 1
        if removed:
            log.info("Auto-delete removed %d old temp file(s)", removed)
    except Exception as e:
        log.warning("Temp cleanup problem: %s", e)

def safe_name(name):
    base = os.path.splitext(os.path.basename(name or "image"))[0]
    return re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "image"

def clean_user_name(name, fallback):
    name = re.sub(r"\.svg$", "", (name or "").strip(), flags=re.I)
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return name or fallback

def unique_path(folder, stem, ext):
    p = os.path.join(folder, stem + ext)
    i = 1
    while os.path.exists(p):
        p = os.path.join(folder, f"{stem}-{i}{ext}")
        i += 1
    return p

def temp_stem(base):
    ts = int(time.time())
    style = opt["filename_style"]
    if style == "original":
        return base
    if style == "timestamp":
        return str(ts)
    return f"{base}_{ts}"

def enhance_image(img, mode, detail):
    """Clean up a photo so it traces into big flat shapes instead of noise."""
    img = ImageOps.autocontrast(img, cutoff=1)
    img = img.filter(ImageFilter.MedianFilter(5 if max(img.size) <= 800 else 3))
    if mode == "bw":
        return ImageOps.autocontrast(ImageOps.grayscale(img)).convert("RGB")
    img = ImageEnhance.Color(img).enhance(1.25)
    return img.quantize(colors=2 + detail, method=Image.Quantize.MEDIANCUT,
                        dither=Image.Dither.NONE).convert("RGB")

def apply_shape(svg, shape):
    """Make the SVG square and clip it to a circle or rounded square."""
    if shape not in ("circle", "rounded", "square"):
        return svg
    m = re.search(r"<svg[^>]*>", svg)
    if not m:
        return svg
    tag = m.group(0)
    w = re.search(r'width="(\d+)"', tag)
    h = re.search(r'height="(\d+)"', tag)
    if not (w and h):
        return svg
    w, h = int(w.group(1)), int(h.group(1))
    side = min(w, h)
    x0, y0 = (w - side) / 2, (h - side) / 2
    new = re.sub(r'\s(width|height|viewBox)="[^"]*"', "", tag)
    new = new[:-1] + f' width="{side}" height="{side}" viewBox="{x0:g} {y0:g} {side} {side}">'
    inner = ""
    close = ""
    if shape in ("circle", "rounded"):
        if shape == "circle":
            clip = f'<circle cx="{w/2:g}" cy="{h/2:g}" r="{side/2:g}"/>'
        else:
            clip = f'<rect x="{x0:g}" y="{y0:g}" width="{side}" height="{side}" rx="{side*0.18:g}"/>'
        inner = f'<defs><clipPath id="svgmaker-clip">{clip}</clipPath></defs><g clip-path="url(#svgmaker-clip)">'
        close = "</g>"
    out = svg.replace(tag, new + inner, 1)
    i = out.rfind("</svg>")
    return out[:i] + close + out[i:] if i >= 0 else out

CACHE = OrderedDict()  # id -> {svg, temp, base}

app = Flask(__name__, static_folder=STATIC_DIR)
app.config["MAX_CONTENT_LENGTH"] = int(opt["max_upload_mb"]) * 1024 * 1024

@app.errorhandler(413)
def too_big(_):
    return f"File too large. Max is {opt['max_upload_mb']} MB.", 413

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")

@app.route("/settings")
def settings():
    return jsonify({
        "default_mode": opt["default_mode"],
        "default_detail": int(opt["default_detail"]),
        "output_path": OUT, "temp_path": TEMP,
        "max_upload_mb": int(opt["max_upload_mb"]),
        "crop_editor": bool(opt["crop_editor"]), "auto_crop": bool(opt["auto_crop"]),
        "crop_shape": opt["crop_shape"], "crop_padding": int(opt["crop_padding"]),
        "output_size": int(opt["output_size"]), "auto_enhance": bool(opt["auto_enhance"]),
    })

@app.route("/convert", methods=["POST"])
def convert():
    f = request.files.get("photo")
    if not f:
        return "No file received", 400
    mode = request.form.get("mode", opt["default_mode"])
    try:
        detail = max(1, min(10, int(request.form.get("detail", opt["default_detail"]))))
    except ValueError:
        detail = int(opt["default_detail"])
    shape = request.form.get("shape", opt["crop_shape"])
    enhance = request.form.get("enhance", "1" if opt["auto_enhance"] else "0") == "1"
    log.info("Converting %s (mode=%s, detail=%s, shape=%s, enhance=%s)", f.filename, mode, detail, shape, enhance)
    t0 = time.time()
    try:
        raw = f.read()
        base = safe_name(f.filename)
        with tempfile.TemporaryDirectory() as d:
            src, dst = os.path.join(d, "in.png"), os.path.join(d, "out.svg")
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            log.debug("Original size %sx%s", *img.size)
            m = int(opt["max_image_dimension"])
            img.thumbnail((m, m))
            if enhance:
                img = enhance_image(img, mode, detail)
                kw = dict(filter_speckle=max(3, round(max(img.size) / 90) + 6 - detail),
                          color_precision=8, layer_difference=8, corner_threshold=60,
                          length_threshold=8, path_precision=1)
            else:
                kw = dict(filter_speckle=max(1, 12 - detail),
                          color_precision=min(8, 3 + detail // 2),
                          layer_difference=max(8, 40 - detail * 3))
            img.save(src)
            vtracer.convert_image_to_svg_py(
                src, dst,
                colormode="binary" if mode == "bw" else "color",
                mode=opt["path_style"], **kw)
            with open(dst) as o:
                svg = apply_shape(o.read(), shape)
    except Exception as e:
        log.exception("Conversion failed")
        return f"Could not convert that image: {e}", 500

    temp_file = None
    if ensure_dir(TEMP):
        try:
            temp_file = unique_path(TEMP, temp_stem(base), ".svg")
            with open(temp_file, "w") as o:
                o.write(svg)
            log.info("Auto-saved to %s", temp_file)
        except Exception as e:
            log.error("Could not auto-save temp file: %s", e)
            temp_file = None
    cleanup_temp()

    cid = uuid.uuid4().hex[:12]
    CACHE[cid] = {"svg": svg, "temp": temp_file, "base": base}
    while len(CACHE) > 25:
        CACHE.popitem(last=False)
    log.info("Done in %.1fs (%d KB SVG)", time.time() - t0, len(svg) // 1024)
    return jsonify({"id": cid, "svg": svg, "name": base,
                    "temp_file": temp_file, "temp_url": temp_url(temp_file)})

@app.route("/save", methods=["POST"])
def save():
    data = request.get_json(silent=True) or {}
    item = CACHE.get(data.get("id"))
    if not item:
        return "That conversion expired. Convert the photo again.", 404
    if not ensure_dir(OUT):
        return f"Cannot write to save folder {OUT}. Check the Save folder option and the log.", 500
    name = clean_user_name(data.get("name"), item["base"])
    dest = os.path.join(OUT, name + ".svg")
    if os.path.exists(dest) and opt["on_name_conflict"] == "rename":
        dest = unique_path(OUT, name, ".svg")
    try:
        with open(dest, "w") as o:
            o.write(item["svg"])
    except Exception as e:
        log.error("Save failed: %s", e)
        return f"Save failed: {e}", 500
    if item["temp"] and os.path.exists(item["temp"]):
        try:
            os.remove(item["temp"])
        except Exception:
            pass
    item["temp"] = None
    log.info("Saved %s", dest)
    return jsonify({"saved_path": dest, "file_name": os.path.basename(dest)})

if __name__ == "__main__":
    ensure_dir(OUT)
    ensure_dir(TEMP)
    cleanup_temp()
    log.info("Save folder: %s | Temp folder: %s | Auto-delete temp: %s",
             OUT, TEMP, opt["auto_delete_temp"])
    log.info("SVG Maker ready on port %s", PORT)
    app.run(host="0.0.0.0", port=PORT)
