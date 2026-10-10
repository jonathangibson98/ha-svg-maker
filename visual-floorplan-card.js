/*
 * Visual Floorplan Card for Home Assistant  (v3.11)
 *
 * - Floor plan image background with enhanced mobile-friendly pan & zoom + overlay controls
 * - Devices: drop entities on the map, drag to move, resize each one
 *     * lights show their real color and dim with brightness
 *     * media players / people / cameras can show their artwork or photo
 *     * media players can cast an ambient TV glow if enabled
 *     * toggle individual entity glow on/off
 *     * custom brightness glow intensity per entity
 *     * custom tap and hold actions per entity (group members inherit group actions)
 *     * devices placed at (nearly) the same spot stack into one bubble;
 *       tap the bubble to fan them out
 * - Rooms: trace a room, bind it to a Home Assistant Area
 *     * toggle "Has Walls & Roof" (open areas like patios get full sunlight without roof clipping)
 *     * HOLD a room = toggle every light in the Area (a plain tap does nothing)
 *     * room glows in the blended color + brightness of its lights
 *     * green outline when motion/occupancy/presence is on
 *     * shows the Area temperature if it has a sensor
 * - No YAML needed. The editor writes the config for you.
 *
 * Card type: custom:visual-floorplan-card
 */

const VFP_TOGGLE_DOMAINS = ["light", "switch", "input_boolean", "fan", "automation"];
const VFP_ACTIVE_STATES = ["on", "open", "unlocked", "playing", "home", "heat", "cool"];
const VFP_PRESENCE = ["motion", "occupancy", "presence"];
const VFP_PICTURE_DOMAINS = ["media_player", "person", "camera"];
const SVGNS = "http://www.w3.org/2000/svg";
const VFP_DEFAULT_OFF = "#546e7a"; // blue-grey: visible on dark floor plans
const VFP_DEFAULT_SIZE = 32;
const VFP_DEFAULT_RADIUS = 2.5; // % of the image: devices closer than this stack
const VFP_AMBER = [255, 193, 7];

const vfpClamp = (n) => Math.max(0, Math.min(100, n));
const vfpRound = (n) => Math.round(n * 10) / 10;
const vfpPts = (pts) => pts.map((p) => p[0] + "," + p[1]).join(" ");
const vfpCentroid = (pts) => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
];

function vfpHexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [84, 110, 122];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// dark or light icon color so it stays readable on any background
function vfpContrast(rgb) {
  const luma = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return luma > 0.6 ? "#111" : "#fff";
}

// color + brightness (0.05 - 1) of a light that is on
function vfpLightInfo(st) {
  const rgb = Array.isArray(st.attributes.rgb_color) ? st.attributes.rgb_color : VFP_AMBER;
  const b = typeof st.attributes.brightness === "number" ? st.attributes.brightness / 255 : 1;
  return { rgb, bf: Math.max(0.05, Math.min(1, b)) };
}

const VFP_MOON_PHASES = {
  new_moon: 0,
  waxing_crescent: 0.2,
  first_quarter: 0.5,
  waxing_gibbous: 0.8,
  full_moon: 1,
  waning_gibbous: 0.8,
  last_quarter: 0.5,
  waning_crescent: 0.2,
};
const vfpMix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// color of the outdoors from the sun (elevation) and moon (phase) entities
function vfpSky(sun, moon) {
  let elev = -30; // no sun entity = treat as night
  if (sun) {
    const e = parseFloat(sun.attributes.elevation);
    elev = isNaN(e) ? (sun.state === "above_horizon" ? 30 : -20) : e;
  }
  const day = Math.max(0, Math.min(1, (elev + 4) / 20));
  let moonLvl = 0;
  if (moon) {
    let v = VFP_MOON_PHASES[moon.state];
    if (v === undefined) {
      const n = parseFloat(moon.state);
      v = isNaN(n) ? 0 : n > 1 ? n / 100 : n;
    }
    const me = parseFloat(moon.attributes.elevation);
    if (!isNaN(me) && me < 0) v = 0;
    moonLvl = v;
  }
  const night = vfpMix([6, 10, 20], [24, 40, 78], moonLvl * 0.9);
  let c = vfpMix(night, [140, 170, 190], day);
  const tw = Math.max(0, 1 - Math.abs(elev - 1) / 7); // sunrise / sunset warmth
  c = vfpMix(c, [170, 95, 80], tw * 0.5);
  return c.map(Math.round);
}

// area_id -> [entity_id, ...] using the entity + device registries in hass
function vfpBuildAreaMap(h) {
  const map = {};
  const ents = h.entities || {};
  const devs = h.devices || {};
  Object.keys(ents).forEach((eid) => {
    const reg = ents[eid];
    let a = reg.area_id;
    if (!a && reg.device_id && devs[reg.device_id]) a = devs[reg.device_id].area_id;
    if (a) (map[a] = map[a] || []).push(eid);
  });
  return map;
}

// cluster elements that sit within `radius` (%) of each other
function vfpGroup(elements, radius) {
  const groups = [];
  elements.forEach((el, i) => {
    let g = null;
    if (radius > 0) g = groups.find((q) => Math.hypot(q.x - el.x, q.y - el.y) <= radius);
    if (g) g.members.push(i);
    else groups.push({ x: el.x, y: el.y, members: [i] });
  });
  return groups;
}

// ---- sun / moon through windows ----
const VFP_RAD = Math.PI / 180;

function vfpMoonPos(date, lat, lng) {
  const e = VFP_RAD * 23.4397;
  const d = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
  const L = VFP_RAD * (218.316 + 13.176396 * d);
  const M = VFP_RAD * (134.963 + 13.064993 * d);
  const F = VFP_RAD * (93.272 + 13.22935 * d);
  const l = L + VFP_RAD * 6.289 * Math.sin(M);
  const b = VFP_RAD * 5.128 * Math.sin(F);
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const phi = VFP_RAD * lat;
  const H = VFP_RAD * (280.16 + 360.9856235 * d) - VFP_RAD * -lng - ra;
  let alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const hh = alt < 0 ? 0 : alt;
  alt += 0.0002967 / Math.tan(hh + 0.00312536 / (hh + 0.08901179));
  return { az: (az / VFP_RAD + 180 + 360) % 360, alt: alt / VFP_RAD };
}

function vfpMoonIllum(date) {
  const jd = date.valueOf() / 86400000 + 2440587.5;
  const f = (((jd - 2451550.1) / 29.530588853) % 1 + 1) % 1;
  return (1 - Math.cos(2 * Math.PI * f)) / 2;
}

function vfpPip(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function vfpSegDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function vfpWindowInfo(win, zones, aspect) {
  const p1 = [win.x1, win.y1 / aspect];
  const p2 = [win.x2, win.y2 / aspect];
  const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.3) return null;
  const n = [-dy / len, dx / len];
  let best = null;
  zones.forEach((z, zi) => {
    const pts = z.points.map((p) => [p[0], p[1] / aspect]);
    let d = Infinity;
    for (let i = 0; i < pts.length; i++) d = Math.min(d, vfpSegDist(mid, pts[i], pts[(i + 1) % pts.length]));
    if (!best || d < best.d) best = { zi, d, pts };
  });
  if (!best || best.d > 6) return null;
  const a = vfpPip([mid[0] + n[0] * 1.5, mid[1] + n[1] * 1.5], best.pts);
  const b = vfpPip([mid[0] - n[0] * 1.5, mid[1] - n[1] * 1.5], best.pts);
  let nin;
  if (a && !b) nin = n;
  else if (b && !a) nin = [-n[0], -n[1]];
  else {
    const c = vfpCentroid(best.pts);
    nin = (c[0] - mid[0]) * n[0] + (c[1] - mid[1]) * n[1] >= 0 ? n : [-n[0], -n[1]];
  }
  return { zi: best.zi, p1, p2, nin };
}

/* ================================================================== */
/* The card                                                            */
/* ================================================================== */
class VisualFloorplanCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("visual-floorplan-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:visual-floorplan-card",
      image: "/local/floorplan-house-dark.png",
      elements: [],
      zones: [],
      zoom_layout: "vertical",
      zoom_corner: "bottom-right",
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    VisualFloorplanCard._n = (VisualFloorplanCard._n || 0) + 1;
    this._uid = VisualFloorplanCard._n;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
  }

  setConfig(config) {
    this._config = {
      image: "/local/floorplan-house-dark.png",
      elements: [],
      zones: [],
      zoom_layout: "vertical",
      zoom_corner: "bottom-right",
      ...config,
    };
    this._build();
    if (this._hass) this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  getCardSize() {
    return 6;
  }

  _build() {
    const root = this.shadowRoot;
    const layout = this._config.zoom_layout || "vertical";
    const corner = this._config.zoom_corner || "bottom-right";

    let cornerStyles = "";
    if (corner === "bottom-right") cornerStyles = "right: 12px; bottom: 12px;";
    else if (corner === "bottom-left") cornerStyles = "left: 12px; bottom: 12px;";
    else if (corner === "top-right") cornerStyles = "right: 12px; top: 12px;";
    else if (corner === "top-left") cornerStyles = "left: 12px; top: 12px;";

    const isHoriz = layout === "horizontal";
    const flexDir = isHoriz ? "flex-direction: row;" : "flex-direction: column;";
    const borderStyle = isHoriz ? "border-left" : "border-top";

    root.innerHTML = `
      <style>
        ha-card { overflow: hidden; }
        .viewport { position: relative; width: 100%; overflow: hidden; touch-action: none; cursor: grab; background: #0a0f1a; }
        .viewport:active { cursor: grabbing; }
        .wrap { position: relative; width: 100%; line-height: 0; isolation: isolate; transform-origin: 0 0; will-change: transform; }
        img { width: 100%; display: block; position: relative; z-index: 1; pointer-events: none; }
        .outside {
          position: absolute;
          inset: 0;
          z-index: 0;
          isolation: isolate;
          overflow: hidden;
          background-color: #0a0f1a;
          transition: background-color 3s;
          pointer-events: none;
        }
        .glow { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
        .zglow { position: absolute; inset: 0; mix-blend-mode: screen; pointer-events: none; }
        .sunp {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          mix-blend-mode: screen;
          filter: blur(1.1px);
          pointer-events: none;
        }
        .lg {
          position: absolute;
          inset: 0;
          mix-blend-mode: screen;
          opacity: 0;
          transition: opacity 0.7s;
          pointer-events: none;
        }
        svg.zones { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; }
        svg.zones polygon {
          fill: transparent;
          stroke: transparent;
          stroke-width: 3px;
          vector-effect: non-scaling-stroke;
          pointer-events: all;
          cursor: pointer;
          transition: fill 0.4s, stroke 0.3s;
        }
        svg.zones polygon.present { stroke: rgba(76, 175, 80, 0.95); }
        svg.zones polygon {
          -webkit-touch-callout: none;
          -webkit-user-select: none;
          user-select: none;
        }
        svg.zones polygon.holding { fill: rgba(255, 255, 255, 0.12); stroke: rgba(255, 255, 255, 0.85); }
        .zlabel {
          position: absolute;
          z-index: 3;
          transform: translate(-50%, -50%);
          font: 700 11px/1 sans-serif;
          color: #fff;
          text-shadow: 0 0 3px #000, 0 0 3px #000;
          pointer-events: none;
          white-space: nowrap;
        }
        .item {
          --s: 32px;
          z-index: 4;
          position: absolute;
          transform: translate(-50%, -50%);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
          min-width: var(--s);
          height: var(--s);
          padding: 0 calc(var(--s) * 0.12);
          border-radius: calc(var(--s) / 2);
          background-color: #546e7a;
          background-size: cover;
          background-position: center;
          color: #fff;
          font-family: sans-serif;
          font-weight: 700;
          font-size: calc(var(--s) * 0.38);
          line-height: 1;
          --mdc-icon-size: calc(var(--s) * 0.62);
          transition: background-color 0.3s, box-shadow 0.3s;
        }
        .item.pic { width: var(--s); padding: 0; }
        .item.pic ha-state-icon { display: none; }
        .item.unavailable { opacity: 0.4; }
        .label { padding: 0 4px; white-space: nowrap; }

        .stack { position: absolute; width: 0; height: 0; z-index: 4; }
        .stack.open { z-index: 6; }
        .stack .item { left: 0; top: 0; }
        .stack .member {
          transform: translate(-50%, -50%) scale(0.2);
          opacity: 0;
          pointer-events: none;
          transition: transform 0.2s, opacity 0.2s, background-color 0.3s, box-shadow 0.3s;
        }
        .stack.open .member {
          transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1);
          opacity: 1;
          pointer-events: auto;
        }
        .stack .stackbtn { z-index: 1; }

        /* Floating Zoom Toolbar */
        .zoom-controls {
          position: absolute;
          ${cornerStyles}
          z-index: 10;
          display: flex;
          ${flexDir}
          background: rgba(20, 25, 35, 0.85);
          backdrop-filter: blur(6px);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        }
        .zoom-btn {
          width: 38px;
          height: 38px;
          background: transparent;
          border: none;
          color: #fff;
          font-size: 18px;
          font-weight: bold;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }
        .zoom-btn:active, .zoom-btn:hover {
          background: rgba(255, 255, 255, 0.15);
        }
        .zoom-btn + .zoom-btn {
          ${borderStyle}: 1px solid rgba(255, 255, 255, 0.1);
        }
      </style>
      <ha-card>
        <div class="viewport">
          <div class="wrap"><img src="${this._config.image}"></div>
          <div class="zoom-controls">
            <button class="zoom-btn" id="zoomIn" title="Zoom In">+</button>
            <button class="zoom-btn" id="zoomReset" title="Reset Zoom" style="font-size: 14px;">↺</button>
            <button class="zoom-btn" id="zoomOut" title="Zoom Out">−</button>
          </div>
        </div>
      </ha-card>
    `;
    const viewport = root.querySelector(".viewport");
    const wrap = root.querySelector(".wrap");

    // --- High-Responsiveness Pan, Zoom & Drag-Threshold Logic ---
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let hasMoved = false;
    let pointers = new Map();
    let initialPinchDist = null;
    let initialZoom = 1;

    const applyTransform = () => {
      this._zoom = Math.max(1, Math.min(6, this._zoom));
      const rect = viewport.getBoundingClientRect();
      const maxPanX = rect.width * (this._zoom - 1);
      const maxPanY = rect.height * (this._zoom - 1);
      this._panX = Math.max(-maxPanX, Math.min(0, this._panX));
      this._panY = Math.max(-maxPanY, Math.min(0, this._panY));
      if (this._zoom === 1) {
        this._panX = 0;
        this._panY = 0;
      }
      wrap.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
    };

    const zoomToCenter = (zoomFactor) => {
      const rect = viewport.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const newZoom = Math.max(1, Math.min(6, this._zoom * zoomFactor));
      const scaleChange = newZoom / this._zoom;
      this._panX = centerX - (centerX - this._panX) * scaleChange;
      this._panY = centerY - (centerY - this._panY) * scaleChange;
      this._zoom = newZoom;
      applyTransform();
    };

    root.getElementById("zoomIn").addEventListener("click", (e) => {
      e.stopPropagation();
      zoomToCenter(1.25);
    });
    root.getElementById("zoomOut").addEventListener("click", (e) => {
      e.stopPropagation();
      zoomToCenter(1 / 1.25);
    });
    root.getElementById("zoomReset").addEventListener("click", (e) => {
      e.stopPropagation();
      this._zoom = 1;
      this._panX = 0;
      this._panY = 0;
      applyTransform();
    });

    viewport.addEventListener("pointerdown", (e) => {
      if (e.target.closest && (e.target.closest(".item") || e.target.closest(".stack") || e.target.closest(".zoom-controls"))) return;
      pointers.set(e.pointerId, e);
      if (pointers.size === 1) {
        isDragging = true;
        hasMoved = false;
        pointerStartX = e.clientX;
        pointerStartY = e.clientY;
        startX = e.clientX - this._panX;
        startY = e.clientY - this._panY;
      } else if (pointers.size === 2) {
        isDragging = false;
        hasMoved = true;
        const pts = Array.from(pointers.values());
        initialPinchDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
        initialZoom = this._zoom;
      }
    });

    viewport.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e);
      if (pointers.size === 2 && initialPinchDist) {
        hasMoved = true;
        const pts = Array.from(pointers.values());
        const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
        const factor = dist / initialPinchDist;
        const rect = viewport.getBoundingClientRect();
        const midX = (pts[0].clientX + pts[1].clientX) / 2 - rect.left;
        const midY = (pts[0].clientY + pts[1].clientY) / 2 - rect.top;
        const newZoom = initialZoom * factor;
        const scaleChange = newZoom / this._zoom;
        this._panX = midX - (midX - this._panX) * scaleChange;
        this._panY = midY - (midY - this._panY) * scaleChange;
        this._zoom = newZoom;
        applyTransform();
      } else if (isDragging && pointers.size === 1) {
        if (!hasMoved && Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY) > 6) {
          hasMoved = true;
        }
        if (hasMoved) {
          this._panX = e.clientX - startX;
          this._panY = e.clientY - startY;
          applyTransform();
        }
      }
    });

    const removePointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) initialPinchDist = null;
      if (pointers.size === 0) {
        isDragging = false;
        hasMoved = false;
      }
    };
    viewport.addEventListener("pointerup", removePointer);
    viewport.addEventListener("pointercancel", removePointer);

    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.max(1, Math.min(6, this._zoom * zoomFactor));
      const scaleChange = newZoom / this._zoom;
      this._panX = mouseX - (mouseX - this._panX) * scaleChange;
      this._panY = mouseY - (mouseY - this._panY) * scaleChange;
      this._zoom = newZoom;
      applyTransform();
    }, { passive: false });

    let lastTap = 0;
    viewport.addEventListener("click", (e) => {
      if (hasMoved) return;

      const now = Date.now();
      if (now - lastTap < 300 && !e.target.closest(".item") && !e.target.closest(".stack") && !e.target.closest("polygon") && !e.target.closest(".zoom-controls")) {
        this._zoom = 1;
        this._panX = 0;
        this._panY = 0;
        applyTransform();
      }
      lastTap = now;

      const inside = e.target.closest && e.target.closest(".stack");
      wrap.querySelectorAll(".stack.open").forEach((s) => {
        if (s !== inside) this._setStackOpen(s, false);
      });
    });

    this._zones = [];
    const zones = this._config.zones || [];
    this._pos = {};
    (this._config.elements || []).forEach((el) => {
      if (!this._pos[el.entity]) this._pos[el.entity] = { x: el.x, y: el.y };
    });
    const imgEl = wrap.querySelector("img");
    imgEl.addEventListener("load", () => {
      this._alphaCtx = null;
      if (this._hass) this._update();
    });

    this._groupOf = {};
    (this._config.light_groups || []).forEach((g) => {
      (g.members || []).forEach((m) => {
        if (!this._groupOf[m]) this._groupOf[m] = g.entity;
      });
    });

    this._out = null;
    this._outLights = [];
    if (this._config.outside) {
      const od = document.createElement("div");
      od.className = "outside";
      wrap.insertBefore(od, imgEl);
      this._out = { div: od, kids: {} };
      let ot = null;
      let osx = 0;
      let osy = 0;
      const ocancel = () => {
        clearTimeout(ot);
        ot = null;
      };
      imgEl.addEventListener("pointerdown", (e) => {
        if (!this._outLights.length || !this._isOutsideClick(imgEl, e)) return;
        osx = e.clientX;
        osy = e.clientY;
        clearTimeout(ot);
        ot = setTimeout(() => {
          ot = null;
          this._buzz();
          this._tapOutside();
        }, 600);
      });
      imgEl.addEventListener("pointermove", (e) => {
        if (ot && Math.hypot(e.clientX - osx, e.clientY - osy) > 10) ocancel();
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => imgEl.addEventListener(ev, ocancel));
      imgEl.addEventListener("contextmenu", (e) => {
        if (this._outLights.length && this._isOutsideClick(imgEl, e)) {
          e.preventDefault();
          ocancel();
          this._tapOutside();
        }
      });
    }

    if (zones.length) {
      const glow = document.createElement("div");
      glow.className = "glow";
      wrap.appendChild(glow);

      const svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("class", "zones");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      wrap.appendChild(svg);

      zones.forEach((z) => {
        const poly = document.createElementNS(SVGNS, "polygon");
        poly.setAttribute("points", vfpPts(z.points));
        const title = document.createElementNS(SVGNS, "title");
        title.textContent = (z.name || "") + " (hold to toggle its lights)";
        poly.appendChild(title);
        svg.appendChild(poly);

        const label = document.createElement("div");
        label.className = "zlabel";
        const c = vfpCentroid(z.points);
        label.style.left = c[0] + "%";
        label.style.top = c[1] + 3.5 + "%";
        wrap.appendChild(label);

        const zg = document.createElement("div");
        zg.className = "zglow";
        if (z.has_walls !== false) {
          const clip = "polygon(" + z.points.map((p) => p[0] + "% " + p[1] + "%").join(",") + ")";
          zg.style.clipPath = clip;
          zg.style.webkitClipPath = clip;
        }
        glow.appendChild(zg);

        const amb = document.createElement("div");
        amb.className = "lg";
        zg.appendChild(amb);

        const sunSvg = document.createElementNS(SVGNS, "svg");
        sunSvg.setAttribute("class", "sunp");
        sunSvg.setAttribute("preserveAspectRatio", "none");
        zg.appendChild(sunSvg);

        const zo = { z, poly, label, lights: [], zg, amb, kids: {}, sun: sunSvg };
        this._onHold(poly, () => {
          if (!hasMoved) this._tapZone(zo);
        });
        this._zones.push(zo);
      });
    }

    this._items = [];
    this._stacks = [];
    const elements = this._config.elements || [];
    const radius = this._config.stack_radius != null ? this._config.stack_radius : VFP_DEFAULT_RADIUS;

    vfpGroup(elements, radius).forEach((g) => {
      if (g.members.length === 1) {
        const it = this._makeItem(elements[g.members[0]]);
        it.div.style.left = g.x + "%";
        it.div.style.top = g.y + "%";
        wrap.appendChild(it.div);
        this._items.push(it);
        return;
      }

      const box = document.createElement("div");
      box.className = "stack";
      box.style.left = g.x + "%";
      box.style.top = g.y + "%";

      const members = g.members.map((i) => {
        const it = this._makeItem(elements[i]);
        it.div.classList.add("member");
        box.appendChild(it.div);
        this._items.push(it);
        return it;
      });

      const maxSize = Math.max(...members.map((m) => m.size));
      const btn = document.createElement("div");
      btn.className = "item stackbtn";
      btn.style.setProperty("--s", maxSize + "px");
      btn.textContent = String(members.length);
      btn.addEventListener("click", () => {
        if (hasMoved) return;
        const open = !box.classList.contains("open");
        wrap.querySelectorAll(".stack.open").forEach((s) => this._setStackOpen(s, false));
        this._setStackOpen(box, open);
      });
      box.appendChild(btn);

      const n = members.length;
      const base = Math.atan2(50 - g.y, 50 - g.x);
      const step = n >= 7 ? (2 * Math.PI) / n : 1.0;
      const R = Math.max(maxSize * 1.25, (maxSize * 1.15) / (2 * Math.sin(step / 2)));
      members.forEach((m, i) => {
        const a = base + (i - (n - 1) / 2) * step;
        m.div.style.setProperty("--dx", Math.round(Math.cos(a) * R) + "px");
        m.div.style.setProperty("--dy", Math.round(Math.sin(a) * R) + "px");
      });

      box._btn = btn;
      box._count = members.length;
      wrap.appendChild(box);
      this._stacks.push({ box, btn, members });
    });
  }

  _setStackOpen(box, open) {
    box.classList.toggle("open", open);
    if (box._btn) box._btn.textContent = open ? "\u2715" : String(box._count);
  }

  _makeItem(el) {
    const size = el.size || this._config.icon_size || VFP_DEFAULT_SIZE;
    const div = document.createElement("div");
    div.className = "item";
    div.style.setProperty("--s", size + "px");

    const domain = (el.entity || "").split(".")[0];
    let icon = null;
    let label = null;
    if (domain === "sensor") {
      label = document.createElement("span");
      label.className = "label";
      div.appendChild(label);
    } else {
      icon = document.createElement("ha-state-icon");
      div.appendChild(icon);
    }
    let timer = null;
    let held = false;
    const groupTarget = () => (this._groupOf && this._groupOf[el.entity]) || el.entity;
    div.addEventListener("pointerdown", () => {
      held = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        held = true;
        this._run(el, "hold", groupTarget());
      }, 550);
    });
    const cancel = () => clearTimeout(timer);
    div.addEventListener("pointerup", cancel);
    div.addEventListener("pointerleave", cancel);
    div.addEventListener("pointercancel", cancel);
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cancel();
      held = true;
      this._run(el, "hold", groupTarget());
    });
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      if (held) {
        held = false;
        return;
      }
      this._run(el, "tap", groupTarget());
    });
    return { el, div, icon, label, size };
  }

  _styleItem(it) {
    const h = this._hass;
    const { el, div, icon, label } = it;
    const offRgb = vfpHexToRgb(this._config.off_color || VFP_DEFAULT_OFF);
    const st = h.states[el.entity];
    if (!st) {
      div.classList.add("unavailable");
      div.title = el.entity + " not found";
      return { on: false, rgb: offRgb, bf: 0 };
    }
    div.title = st.attributes.friendly_name || el.entity;
    div.classList.toggle("unavailable", st.state === "unavailable");

    const on = VFP_ACTIVE_STATES.includes(st.state);
    const domain = el.entity.split(".")[0];
    let rgb = offRgb;
    let bf = 0;
    if (on) {
      let base = VFP_AMBER;
      bf = 1;
      if (domain === "light") {
        const li = vfpLightInfo(st);
        base = li.rgb;
        bf = li.bf;
      } else if (domain === "media_player" && el.tv_glow) {
        base = VFP_AMBER;
        bf = 0.9;
      }
      const k = 0.25 + 0.75 * bf;
      rgb = base.map((c, i) => Math.round(c * k + offRgb[i] * (1 - k)));
      
      const hasGlow = el.glow !== false;
      if (hasGlow) {
        const customIntensity = el.glow_intensity != null ? el.glow_intensity : 1;
        const a = ((0.2 + 0.5 * bf) * customIntensity).toFixed(2);
        const blur = Math.round((4 + 10 * bf) * Math.max(0.5, customIntensity));
        div.style.boxShadow = "0 0 " + blur + "px 2px rgba(" + base.join(",") + "," + a + ")";
      } else {
        div.style.boxShadow = "0 0 0 1.5px rgba(255,255,255,0.35)";
      }
    } else {
      div.style.boxShadow = "0 0 0 1.5px rgba(255,255,255,0.35)";
    }
    div.style.backgroundColor = "rgb(" + rgb.join(",") + ")";
    div.style.color = vfpContrast(rgb);

    const pic = el.picture !== false ? st.attributes.entity_picture : null;
    if (pic) {
      const url = typeof h.hassUrl === "function" ? h.hassUrl(pic) : pic;
      div.classList.add("pic");
      div.style.backgroundImage = 'url("' + url + '")';
    } else {
      div.classList.remove("pic");
      div.style.backgroundImage = "";
    }

    if (icon) {
      icon.hass = h;
      icon.stateObj = st;
    }
    if (label) {
      const unit = st.attributes.unit_of_measurement || "";
      label.textContent = st.state + (unit ? " " + unit : "");
    }
    return { on, rgb, bf };
  }

  _update() {
    const h = this._hass;
    if (!h || !this._items) return;

    if (this._zones.length) {
      if (this._cEnts !== h.entities || this._cDevs !== h.devices || !this._areaMap) {
        this._areaMap = vfpBuildAreaMap(h);
        this._cEnts = h.entities;
        this._cDevs = h.devices;
      }
      this._zones.forEach((zo) => {
        const ids = this._areaMap[zo.z.area] || [];
        const lights = [];
        let present = false;
        let temp = null;
        let wSum = 0;
        let maxB = 0;
        const onLights = [];
        const acc = [0, 0, 0];
        ids.forEach((id) => {
          const st = h.states[id];
          if (!st) return;
          const d = id.split(".")[0];
          const elConfig = (this._config.elements || []).find((el) => el.entity === id);
          
          if (d === "light" || (d === "media_player" && elConfig && elConfig.tv_glow)) {
            if (!this._pos[id]) return;
            const hasGlow = !elConfig || elConfig.glow !== false;
            if (hasGlow) lights.push(id);
            if (st.state === "on" || (d === "media_player" && st.state === "playing")) {
              const li = d === "light" ? vfpLightInfo(st) : { rgb: VFP_AMBER, bf: 0.9 };
              const intensity = elConfig && elConfig.glow_intensity != null ? elConfig.glow_intensity : 1;
              if (hasGlow) {
                onLights.push({ id, rgb: li.rgb, bf: li.bf, intensity });
                wSum += li.bf * intensity;
                maxB = Math.max(maxB, li.bf * intensity);
                acc[0] += li.rgb[0] * li.bf * intensity;
                acc[1] += li.rgb[1] * li.bf * intensity;
                acc[2] += li.rgb[2] * li.bf * intensity;
              }
            }
          } else if (d === "binary_sensor") {
            if (VFP_PRESENCE.includes(st.attributes.device_class) && st.state === "on") present = true;
          } else if (d === "sensor") {
            if (
              temp === null &&
              st.attributes.device_class === "temperature" &&
              !isNaN(parseFloat(st.state))
            ) {
              temp = Math.round(parseFloat(st.state)) + (st.attributes.unit_of_measurement || "\u00b0");
            }
          }
        });
        zo.lights = lights;
        zo.lit = wSum > 0;
        this._updateGlow(zo, lights, onLights, acc, wSum, maxB);
        zo.poly.classList.toggle("present", present);
        zo.label.textContent = temp || "";
      });
    }

    if (this._out) this._updateOutside();
    this._updateSun();

    const info = new Map();
    this._items.forEach((it) => info.set(it, this._styleItem(it)));

    const offRgb = vfpHexToRgb(this._config.off_color || VFP_DEFAULT_OFF);
    this._stacks.forEach(({ btn, members }) => {
      let best = null;
      members.forEach((m) => {
        const i = info.get(m);
        if (i && i.on && (!best || i.bf > best.bf)) best = i;
      });
      const rgb = best ? best.rgb : offRgb;
      btn.style.backgroundColor = "rgb(" + rgb.join(",") + ")";
      btn.style.color = vfpContrast(rgb);
      btn.style.boxShadow = best
        ? "0 0 " + Math.round(4 + 10 * best.bf) + "px 2px rgba(" + rgb.join(",") + ",0.6)"
        : "0 0 0 1.5px rgba(255,255,255,0.35)";
    });
  }

  _updateOutside() {
    const h = this._hass;
    const cfg = this._config.outside;
    const sun = cfg.sun ? h.states[cfg.sun] : null;
    const moon = cfg.moon ? h.states[cfg.moon] : null;
    this._out.div.style.backgroundColor = "rgb(" + vfpSky(sun, moon).join(",") + ")";

    if (this._cEnts !== h.entities || this._cDevs !== h.devices || !this._areaMap) {
      this._areaMap = vfpBuildAreaMap(h);
      this._cEnts = h.entities;
      this._cDevs = h.devices;
    }
    const ids = (cfg.area && this._areaMap[cfg.area]) || [];
    const lights = [];
    const onLights = [];
    ids.forEach((id) => {
      const st = h.states[id];
      const elConfig = (this._config.elements || []).find((el) => el.entity === id);
      if (!st || !this._pos[id]) return;
      const d = id.split(".")[0];
      const hasGlow = !elConfig || elConfig.glow !== false;
      if (d === "light" || (d === "media_player" && elConfig && elConfig.tv_glow)) {
        if (hasGlow) lights.push(id);
        if (st.state === "on" || (d === "media_player" && st.state === "playing")) {
          const li = d === "light" ? vfpLightInfo(st) : { rgb: VFP_AMBER, bf: 0.9 };
          const intensity = elConfig && elConfig.glow_intensity != null ? elConfig.glow_intensity : 1;
          if (hasGlow) onLights.push({ id, rgb: li.rgb, bf: li.bf, intensity });
        }
      }
    });
    this._outLights = lights;
    this._outOn = onLights.length > 0;

    const aspect = this._aspect();
    lights.forEach((id) => {
      if (!this._out.kids[id]) {
        const k = document.createElement("div");
        k.className = "lg";
        this._out.div.appendChild(k);
        this._out.kids[id] = k;
      }
    });
    const onIds = new Set(onLights.map((l) => l.id));
    Object.keys(this._out.kids).forEach((id) => {
      if (!onIds.has(id)) this._out.kids[id].style.opacity = "0";
    });
    onLights.forEach((l) => {
      const k = this._out.kids[l.id];
      const pos = this._pos[l.id];
      const reach = 40 * (0.5 + 0.5 * l.bf) * l.intensity;
      const a = (0.2 + 0.5 * l.bf) * l.intensity;
      k.style.background = this._glowGradient(l.rgb, a, reach, reach * aspect, pos.x, pos.y);
      k.style.opacity = "1";
    });
  }

  _isOutsideClick(img, e) {
    try {
      if (!img.naturalWidth) return false;
      if (!this._alphaCtx) {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        this._alphaCtx = ctx;
      }
      const r = img.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * img.naturalWidth);
      const y = Math.floor(((e.clientY - r.top) / r.height) * img.naturalHeight);
      return this._alphaCtx.getImageData(x, y, 1, 1).data[3] < 30;
    } catch (err) {
      return false;
    }
  }

  _tapOutside() {
    this._hass.callService("light", this._outOn ? "turn_off" : "turn_on", {
      entity_id: this._outLights,
    });
  }

  _moreInfo(entityId) {
    const now = Date.now();
    if (this._lastMore && now - this._lastMore < 800) return;
    this._lastMore = now;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  _aspect() {
    const img = this.shadowRoot.querySelector("img");
    return img && img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1.15;
  }

  _glowGradient(rgb, a, rx, ry, x, y) {
    const c = rgb.join(",");
    const core = rgb.map((v) => Math.round(v + (255 - v) * 0.35)).join(",");
    const f = (k) => Math.min(1, a * k).toFixed(3);
    return (
      "radial-gradient(ellipse " + rx.toFixed(1) + "% " + ry.toFixed(1) + "% at " + x + "% " + y + "%," +
      "rgba(" + core + "," + f(1) + ") 0%," +
      "rgba(" + c + "," + f(0.85) + ") 10%," +
      "rgba(" + c + "," + f(0.5) + ") 32%," +
      "rgba(" + c + "," + f(0.2) + ") 62%," +
      "rgba(" + c + "," + f(0.06) + ") 82%," +
      "rgba(" + c + ",0) 100%)"
    );
  }

  _updateGlow(zo, lights, onLights, acc, wSum, maxB) {
    const aspect = this._aspect();
    const xs = zo.z.points.map((p) => p[0]);
    const ys = zo.z.points.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    const L = Math.max(bw, bh / aspect);

    lights.forEach((id) => {
      if (!zo.kids[id]) {
        const k = document.createElement("div");
        k.className = "lg";
        zo.zg.appendChild(k);
        zo.kids[id] = k;
      }
    });
    const onIds = new Set(onLights.map((l) => l.id));
    Object.keys(zo.kids).forEach((id) => {
      if (!onIds.has(id)) zo.kids[id].style.opacity = "0";
    });

    onLights.forEach((l) => {
      const k = zo.kids[l.id];
      const pos = this._pos[l.id];
      const reach = L * (0.5 + 0.5 * l.bf) * l.intensity;
      const a = (0.15 + 0.45 * l.bf) * l.intensity;
      k.style.background = this._glowGradient(l.rgb, a, reach, reach * aspect, pos.x, pos.y);
      k.style.opacity = "1";
    });

    if (wSum > 0) {
      const rgb = acc.map((v) => Math.round(v / wSum));
      zo.amb.style.background = "rgba(" + rgb.join(",") + "," + Math.min(1, 0.03 + 0.07 * maxB).toFixed(3) + ")";
      zo.amb.style.opacity = "1";
    } else {
      zo.amb.style.opacity = "0";
    }
  }

  _updateSun() {
    const h = this._hass;
    const cfg = this._config;
    this._zones.forEach((zo) => {
      while (zo.sun.firstChild) zo.sun.removeChild(zo.sun.firstChild);
    });
    const wins = cfg.windows || [];
    if (!wins.length || !this._zones.length) return;

    const o = cfg.outside || {};
    const sources = [];
    let sunElev = -90;
    const sunSt = o.sun && h.states[o.sun];
    if (sunSt) {
      const e = parseFloat(sunSt.attributes.elevation);
      const a = parseFloat(sunSt.attributes.azimuth);
      if (!isNaN(e) && !isNaN(a)) {
        sunElev = e;
        if (e > 0.5) {
          const s = Math.pow(Math.min(1, e / 40), 0.8);
          sources.push({
            az: a,
            elev: e,
            A: 0.08 + 0.32 * s,
            rgb: vfpMix([255, 150, 70], [255, 240, 205], Math.min(1, e / 30)).map(Math.round),
          });
        }
      }
    }
    if (o.moon && sunElev < -2 && h.config && typeof h.config.latitude === "number") {
      const now = new Date();
      const mp = vfpMoonPos(now, h.config.latitude, h.config.longitude);
      if (mp.alt > 1) {
        const mst = h.states[o.moon];
        let ill = mst ? VFP_MOON_PHASES[mst.state] : undefined;
        if (ill === undefined) ill = vfpMoonIllum(now);
        sources.push({
          az: mp.az,
          elev: mp.alt,
          A: 0.03 + 0.15 * ill * Math.sqrt(Math.sin(mp.alt * VFP_RAD)),
          rgb: [150, 175, 255],
        });
      }
    }
    if (!sources.length) return;

    const aspect = this._aspect();
    const reachMul = cfg.sun_reach != null ? cfg.sun_reach : 1;
    const north = cfg.north || 0;
    this._zones.forEach((zo) => zo.sun.setAttribute("viewBox", "0 0 100 " + (100 / aspect).toFixed(3)));
    const zonesOnly = this._zones.map((z) => z.z);

    let gid = 0;
    wins.forEach((win) => {
      const wi = vfpWindowInfo(win, zonesOnly, aspect);
      if (!wi) return;
      const svg = this._zones[wi.zi].sun;
      sources.forEach((src) => {
        const ang = (src.az + north) * VFP_RAD;
        const t = [-Math.sin(ang), Math.cos(ang)];
        const dot = t[0] * wi.nin[0] + t[1] * wi.nin[1];
        if (dot <= 0.05) return;
        const L = Math.max(2.5, Math.min(28, 5.5 / Math.tan(Math.max(src.elev, 3) * VFP_RAD))) * reachMul;
        const A = src.A * (0.35 + 0.65 * Math.sqrt(Math.min(1, dot)));
        const col = src.rgb.join(",");
        const mid = [(wi.p1[0] + wi.p2[0]) / 2, (wi.p1[1] + wi.p2[1]) / 2];

        const id = "vfpsun" + this._uid + "_" + gid++;
        let defs = svg.querySelector("defs");
        if (!defs) {
          defs = document.createElementNS(SVGNS, "defs");
          svg.appendChild(defs);
        }
        const grad = document.createElementNS(SVGNS, "linearGradient");
        grad.setAttribute("id", id);
        grad.setAttribute("gradientUnits", "userSpaceOnUse");
        grad.setAttribute("x1", mid[0].toFixed(2));
        grad.setAttribute("y1", mid[1].toFixed(2));
        grad.setAttribute("x2", (mid[0] + t[0] * L).toFixed(2));
        grad.setAttribute("y2", (mid[1] + t[1] * L).toFixed(2));
        [[0, 1], [0.55, 0.5], [1, 0]].forEach(([off, k]) => {
          const st = document.createElementNS(SVGNS, "stop");
          st.setAttribute("offset", String(off));
          st.setAttribute("stop-color", "rgb(" + col + ")");
          st.setAttribute("stop-opacity", (A * k).toFixed(3));
          grad.appendChild(st);
        });
        defs.appendChild(grad);

        const a = wi.p1, b = wi.p2;
        const c = [b[0] + t[0] * L, b[1] + t[1] * L];
        const d = [a[0] + t[0] * L, a[1] + t[1] * L];
        const poly = document.createElementNS(SVGNS, "polygon");
        poly.setAttribute("points", [a, b, c, d].map((q) => q[0].toFixed(2) + "," + q[1].toFixed(2)).join(" "));
        poly.setAttribute("fill", "url(#" + id + ")");
        svg.appendChild(poly);

        const ln = document.createElementNS(SVGNS, "line");
        ln.setAttribute("x1", a[0].toFixed(2));
        ln.setAttribute("y1", a[1].toFixed(2));
        ln.setAttribute("x2", b[0].toFixed(2));
        ln.setAttribute("y2", b[1].toFixed(2));
        ln.setAttribute("stroke", "rgb(" + col + ")");
        ln.setAttribute("stroke-opacity", Math.min(1, A * 1.6).toFixed(3));
        ln.setAttribute("stroke-width", "0.6");
        svg.appendChild(ln);
      });
    });
  }

  _buzz() {
    try {
      if (navigator.vibrate) navigator.vibrate(40);
    } catch (e) {}
  }

  _onHold(target, fn) {
    let timer = null;
    let sx = 0;
    let sy = 0;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      target.classList.remove("holding");
    };
    target.addEventListener("pointerdown", (e) => {
      sx = e.clientX;
      sy = e.clientY;
      target.classList.add("holding");
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        target.classList.remove("holding");
        this._buzz();
        fn();
      }, 600);
    });
    target.addEventListener("pointermove", (e) => {
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => target.addEventListener(ev, cancel));
    target.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cancel();
      fn();
    });
  }

  _tapZone(zo) {
    if (!zo.lights || !zo.lights.length) return;
    this._hass.callService("light", zo.lit ? "turn_off" : "turn_on", {
      entity_id: zo.lights,
    });
  }

  _run(el, kind, groupTarget) {
    const groupEntity = groupTarget;
    const groupConfig = (this._config.light_groups || []).find((g) => g.entity === groupEntity);
    
    const cfg = kind === "hold" 
      ? (groupConfig && groupConfig.hold_action ? groupConfig.hold_action : el.hold_action)
      : (groupConfig && groupConfig.tap_action ? groupConfig.tap_action : el.tap_action);

    const defaultTarget = groupEntity;
    if (!cfg || !cfg.action) {
      if (kind === "hold") this._moreInfo(defaultTarget);
      else this._tap(el.entity, defaultTarget);
      return;
    }
    const ent = cfg.entity || defaultTarget;
    switch (cfg.action) {
      case "toggle":
        this._hass.callService("homeassistant", "toggle", { entity_id: ent });
        break;
      case "more-info":
        this._moreInfo(ent);
        break;
      case "call-service": {
        const parts = (cfg.service || "").split(".");
        if (parts.length !== 2 || !parts[0] || !parts[1]) break;
        const data = { ...(cfg.data || {}) };
        if (!cfg.no_entity && !data.entity_id) data.entity_id = ent;
        this._hass.callService(parts[0], parts[1], data);
        break;
      }
      case "navigate":
        if (cfg.path) {
          history.pushState(null, "", cfg.path);
          window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
        }
        break;
      case "url":
        if (cfg.url) window.open(cfg.url, "_blank", "noopener");
        break;
      default:
        break;
    }
  }

  _tap(entityId, defaultTarget) {
    const domain = defaultTarget.split(".")[0];
    if (VFP_TOGGLE_DOMAINS.includes(domain)) {
      this._hass.callService("homeassistant", "toggle", { entity_id: defaultTarget });
    } else {
      this._moreInfo(defaultTarget);
    }
  }
}

/* ================================================================== */
/* The visual editor                                                   */
/* ================================================================== */
class VisualFloorplanCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._mode = "items";
    this._selected = "";
    this._selSource = "";
    this._area = "";
    this._drawing = null;
    this._selZone = -1;
    this._selEntityIdx = -1;
    this._drag = null;
    this._suppressClick = false;
    this._itemMode = "place";
  }

  setConfig(config) {
    if (this._drag) return;
    this._config = {
      image: "/local/floorplan-house-dark.png",
      zoom_layout: "vertical",
      zoom_corner: "bottom-right",
      ...config,
      elements: [...(config.elements || [])],
      zones: [...(config.zones || [])],
    };
    if (this._selEntityIdx >= this._config.elements.length) this._selEntityIdx = -1;
    if (!this._built) this._build();
    this._refresh();
  }

  set hass(hass) {
    this._hass = hass;
    this._fillEntities();
    this._fillAreas();
    this._fillRoomFilter();
    this._fillOutside();
    this._fillServices();
    this._refreshIcons();
  }

  _build() {
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        label { display: block; font-weight: 600; margin: 12px 0 4px; }
        input[type=text], select {
          width: 100%;
          box-sizing: border-box;
          padding: 10px;
          border-radius: 6px;
          border: 1px solid var(--divider-color, #888);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #000);
          font-size: 14px;
        }
        input[type=range] { width: 100%; }
        .compassrow { display: flex; align-items: center; gap: 14px; }
        #compass { flex: none; touch-action: none; cursor: grab; }
        .cbtns { display: flex; flex-direction: column; gap: 6px; flex: 1; }
        .colorrow { display: flex; align-items: center; gap: 10px; }
        input[type=color] { width: 64px; height: 38px; padding: 2px; flex: none; }
        .sliderrow { display: flex; align-items: center; gap: 10px; }
        .sliderrow span { min-width: 48px; text-align: right; font-size: 13px; }
        .tabs { display: flex; gap: 8px; margin: 12px 0 4px; }
        button {
          padding: 8px 12px;
          border-radius: 6px;
          border: 1px solid var(--primary-color, #03a9f4);
          background: transparent;
          color: var(--primary-color, #03a9f4);
          font-size: 13px;
          font-weight: 600;
        }
        button.on { background: var(--primary-color, #03a9f4); color: #fff; }
        button.danger { border-color: #e53935; color: #e53935; }
        .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .tabs button { flex: 1; font-size: 12px; }
        .hint { font-size: 12px; opacity: 0.7; margin: 6px 0; }
        .hint.err { color: #e53935; opacity: 1; }
        [hidden] { display: none !important; }

        .wrap { position: relative; line-height: 0; margin-top: 8px; touch-action: none; }
        .wrap img { width: 100%; display: block; border: 1px solid var(--divider-color, #888); box-sizing: border-box; background: #11181c; }
        svg.ed { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
        .wrap.zmode svg.ed polygon { pointer-events: all; }
        svg.ed line.win {
          stroke: #4fc3f7;
          stroke-width: 5px;
          stroke-linecap: round;
          vector-effect: non-scaling-stroke;
        }
        svg.ed line.win.bad { stroke: #e53935; }
        svg.ed polygon {
          fill: rgba(0, 188, 212, 0.15);
          stroke: #00bcd4;
          stroke-width: 2px;
          vector-effect: non-scaling-stroke;
        }
        svg.ed polygon.sel { fill: rgba(255, 193, 7, 0.28); stroke: #ffc107; }
        svg.ed polyline {
          fill: none;
          stroke: #4caf50;
          stroke-width: 2px;
          stroke-dasharray: 5 4;
          vector-effect: non-scaling-stroke;
        }
        .zlabel {
          position: absolute;
          transform: translate(-50%, -50%);
          font: 700 11px/1 sans-serif;
          color: #fff;
          text-shadow: 0 0 3px #000, 0 0 3px #000;
          pointer-events: none;
          white-space: nowrap;
        }
        .marker.sel { box-shadow: 0 0 0 3px #4fc3f7, 0 0 12px 4px rgba(79, 195, 247, 0.85); z-index: 3; }
        .row.col.sel { border-left: 3px solid #4fc3f7; padding-left: 6px; background: rgba(79, 195, 247, 0.08); }
        .marker {
          --s: 32px;
          position: absolute;
          transform: translate(-50%, -50%);
          width: var(--s); height: var(--s);
          border-radius: 50%;
          background: rgba(255, 193, 7, 0.95);
          color: #222;
          display: flex; align-items: center; justify-content: center;
          cursor: grab;
          touch-action: none;
          box-shadow: 0 0 0 2px #fff, 0 1px 4px rgba(0,0,0,.5);
          --mdc-icon-size: calc(var(--s) * 0.62);
        }
        .badge {
          position: absolute; top: -6px; right: -6px;
          min-width: 16px; height: 16px; padding: 0 3px; box-sizing: border-box;
          border-radius: 8px; background: #e53935; color: #fff;
          font: 700 10px/16px sans-serif; text-align: center;
          pointer-events: none;
        }
        .wrap.zmode .marker { pointer-events: none; opacity: 0.35; }
        .handle {
          position: absolute;
          transform: translate(-50%, -50%);
          width: 18px; height: 18px;
          border-radius: 50%;
          background: #fff;
          border: 3px solid #ffc107;
          box-sizing: border-box;
          cursor: grab;
          touch-action: none;
        }
        .handle.dot { border-color: #4caf50; cursor: default; pointer-events: none; width: 12px; height: 12px; }
        .handle.first { border-color: #e53935; width: 18px; height: 18px; pointer-events: auto; cursor: pointer; }
        .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--divider-color, #ccc); font-size: 13px; }
        .row.col { flex-direction: column; align-items: stretch; }
        .row .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .row.sel { font-weight: 700; }
        .row .rb { display: flex; gap: 6px; }
        .row button { padding: 4px 10px; }
        .row .ctl { display: flex; align-items: center; gap: 8px; font-size: 12px; opacity: 0.9; }
        .row .ctl input[type=range] { flex: 1; }
        .row .ctl label { display: inline; font-weight: 400; margin: 0; }
        .row details { margin-top: 6px; }
        .row summary { cursor: pointer; font-weight: 600; font-size: 12px; }
        .act { margin: 8px 0 4px; padding: 8px; border: 1px solid var(--divider-color, #ccc); border-radius: 6px; }
        .act .t { font-weight: 600; font-size: 12px; }
        .act select, .act input[type=text], .act textarea {
          width: 100%;
          box-sizing: border-box;
          margin-top: 6px;
          padding: 8px;
          border-radius: 6px;
          border: 1px solid var(--divider-color, #888);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #000);
          font-size: 13px;
        }
        .act textarea { font-family: monospace; min-height: 64px; }
        .act .bad { border-color: #e53935; }
        .act .note { font-size: 11px; opacity: 0.75; margin-top: 4px; }
        .act .note.err { color: #e53935; opacity: 1; }
        .act .chk { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
        .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; border-radius: 14px; border: 1px solid var(--divider-color, #888); font-size: 12px; }
        .chip button { padding: 0 7px; line-height: 20px; border-radius: 10px; }
        .grp { padding: 8px 0; border-bottom: 1px solid var(--divider-color, #ccc); font-size: 13px; }
        .addrow { display: flex; gap: 6px; }
      </style>

      <label>Floor plan image path</label>
      <input id="image" type="text" placeholder="/local/floorplan-house-dark.png">

      <label>Zoom Controls Layout</label>
      <select id="zoomLayout">
        <option value="vertical">Vertical</option>
        <option value="horizontal">Horizontal</option>
      </select>

      <label>Zoom Controls Corner</label>
      <select id="zoomCorner">
        <option value="bottom-right">Bottom Right</option>
        <option value="bottom-left">Bottom Left</option>
        <option value="top-right">Top Right</option>
        <option value="top-left">Top Left</option>
      </select>

      <label>Color for devices that are off</label>
      <div class="colorrow">
        <input id="offColor" type="color">
        <button id="offReset">Reset to default</button>
      </div>

      <label>Default icon size</label>
      <div class="sliderrow">
        <input id="iconSize" type="range" min="16" max="90" step="1">
        <span id="iconSizeVal"></span>
      </div>

      <label>Stack devices closer than</label>
      <div class="sliderrow">
        <input id="stackRadius" type="range" min="0" max="8" step="0.5">
        <span id="stackRadiusVal"></span>
      </div>

      <label>Outside the layout</label>
      <select id="outArea"><option value="">Area for outdoor lights: none</option></select>
      <select id="outSun" style="margin-top:6px"><option value="">Sun entity: none</option></select>
      <select id="outMoon" style="margin-top:6px"><option value="">Moon entity: none</option></select>

      <label>Which way is north on your map?</label>
      <div class="compassrow">
        <svg id="compass" viewBox="-60 -60 120 120" width="120" height="120">
          <polygon points="0,-59 -4,-52 4,-52" fill="#78909c"></polygon>
          <circle r="50" fill="rgba(120,144,156,0.15)" stroke="#78909c" stroke-width="2"></circle>
          <rect x="-14" y="-10" width="28" height="20" fill="none" stroke="#78909c" stroke-width="1.5" stroke-dasharray="3 2"></rect>
          <line id="cArrow" x1="0" y1="0" x2="0" y2="-34" stroke="#ff7043" stroke-width="3.5" stroke-linecap="round"></line>
          <text id="cN" x="0" y="-38" text-anchor="middle" font-size="12" font-weight="700" fill="#ff7043">N</text>
        </svg>
        <div class="cbtns">
          <div id="northVal" class="hint" style="margin:0"></div>
          <button data-n="0">North is up</button>
          <button data-n="90">North is right</button>
          <button data-n="180">North is down</button>
          <button data-n="270">North is left</button>
        </div>
      </div>

      <label>How far sunlight reaches into rooms</label>
      <div class="sliderrow">
        <input id="sunReach" type="range" min="0.3" max="2" step="0.1">
        <span id="sunReachVal"></span>
      </div>

      <label>Light groups</label>
      <input id="grpEntity" list="entities" type="text" placeholder="Group entity, e.g. light.living_room_group">
      <div class="btns"><button id="grpAdd">Add group</button></div>
      <div id="grpList"></div>

      <div class="tabs">
        <button id="tabItems" class="on">Place</button>
        <button id="tabEntities">Entities</button>
        <button id="tabZones">Rooms</button>
        <button id="tabWins">Windows</button>
      </div>

      <div id="itemsPanel">
        <label>Room</label>
        <select id="roomFilter"><option value="">-- pick a room --</option></select>
        <label>Device in that room</label>
        <select id="roomEntity" disabled><option value="">-- pick a room first --</option></select>
        <label>...or type any entity</label>
        <input id="entity" list="entities" type="text" placeholder="Start typing, e.g. light.living">
        <datalist id="entities"></datalist>
        <datalist id="services"></datalist>
        <div class="hint" id="hintItems">Pick a device, then tap the image to drop it.</div>
      </div>

      <div id="entitiesPanel" hidden>
        <div class="hint">Select a placed entity below to customize its size, glow, artwork, TV backlight simulation, and custom tap/hold actions.</div>
        <div id="entitiesList"></div>
      </div>

      <div id="zonesPanel" hidden>
        <label>Home Assistant Area for the room</label>
        <select id="area"><option value="">-- pick an area --</option></select>
        <div class="btns">
          <button id="zStart">Start tracing room</button>
          <button id="zFinish" hidden>Finish room</button>
          <button id="zUndo" hidden>Undo point</button>
          <button id="zCancel" class="danger" hidden>Cancel</button>
        </div>
        <div class="hint" id="hintZones">Pick an Area, hit Start, then tap each corner of the room.</div>
      </div>

      <div id="winsPanel" hidden>
        <div class="hint" id="hintWins">Tap one end of a window on the wall, then tap the other end.</div>
      </div>

      <div class="wrap" id="wrap"><img id="img"><svg class="ed" id="svg" viewBox="0 0 100 100" preserveAspectRatio="none"></svg></div>

      <label id="listTitle">Placed devices</label>
      <div id="list"></div>
    `;

    const $ = (id) => this.shadowRoot.getElementById(id);
    this._wrap = $("wrap");
    this._img = $("img");
    this._svg = $("svg");
    this._hintItems = $("hintItems");
    this._hintZones = $("hintZones");
    this._hintWins = $("hintWins");
    this._img.addEventListener("load", () => this._refresh());

    $("image").addEventListener("change", (e) => {
      this._config = { ...this._config, image: e.target.value.trim() };
      this._img.src = this._config.image;
      this._fire();
    });

    $("zoomLayout").addEventListener("change", (e) => {
      this._config = { ...this._config, zoom_layout: e.target.value };
      this._fire();
    });

    $("zoomCorner").addEventListener("change", (e) => {
      this._config = { ...this._config, zoom_corner: e.target.value };
      this._fire();
    });

    $("offColor").addEventListener("change", (e) => {
      this._config = { ...this._config, off_color: e.target.value };
      this._fire();
    });
    $("offReset").addEventListener("click", () => {
      const c = { ...this._config };
      delete c.off_color;
      this._config = c;
      $("offColor").value = VFP_DEFAULT_OFF;
      this._fire();
    });
    $("iconSize").addEventListener("input", (e) => {
      $("iconSizeVal").textContent = e.target.value + " px";
    });
    $("iconSize").addEventListener("change", (e) => {
      this._config = { ...this._config, icon_size: Number(e.target.value) };
      this._fire();
      this._refresh();
    });
    $("stackRadius").addEventListener("input", (e) => {
      $("stackRadiusVal").textContent = e.target.value === "0" ? "off" : e.target.value + " %";
    });
    $("stackRadius").addEventListener("change", (e) => {
      this._config = { ...this._config, stack_radius: Number(e.target.value) };
      this._fire();
      this._refresh();
    });

    $("outArea").addEventListener("change", (e) => this._setOutside({ area: e.target.value }));
    $("outSun").addEventListener("change", (e) => this._setOutside({ sun: e.target.value }));
    $("outMoon").addEventListener("change", (e) => this._setOutside({ moon: e.target.value }));

    $("grpAdd").addEventListener("click", () => {
      const id = $("grpEntity").value.trim();
      const st = this._hass && this._hass.states[id];
      if (!st) return;
      if ((this._config.light_groups || []).some((g) => g.entity === id)) return;
      const auto = Array.isArray(st.attributes.entity_id)
        ? st.attributes.entity_id.filter((m) => this._hass.states[m])
        : [];
      this._config = {
        ...this._config,
        light_groups: [...(this._config.light_groups || []), { entity: id, members: auto }],
      };
      $("grpEntity").value = "";
      this._fire();
      this._refresh();
    });

    $("entity").addEventListener("input", (e) => {
      this._selected = e.target.value.trim();
      this._selSource = "manual";
      $("roomEntity").value = "";
    });
    $("roomFilter").addEventListener("change", () => {
      this._selected = "";
      this._selSource = "";
      $("entity").value = "";
      this._fillRoomEntities();
    });
    $("roomEntity").addEventListener("change", (e) => {
      this._selected = e.target.value;
      this._selSource = e.target.value ? "room" : "";
      $("entity").value = "";
      if (e.target.value) {
        const st = this._hass.states[e.target.value];
        const nm = (st && st.attributes.friendly_name) || e.target.value;
        this._hintItems.textContent = 'Now tap the image where "' + nm + '" goes.';
        this._hintItems.classList.remove("err");
      }
    });
    $("area").addEventListener("change", (e) => {
      this._area = e.target.value;
    });

    $("tabItems").addEventListener("click", () => this._setMode("items"));
    $("tabEntities").addEventListener("click", () => this._setMode("entities"));
    $("tabZones").addEventListener("click", () => this._setMode("zones"));
    $("tabWins").addEventListener("click", () => this._setMode("wins"));

    const cp = $("compass");
    const angleFrom = (e) => {
      const r = cp.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < 4) return null;
      let a = (Math.atan2(dx, -dy) / VFP_RAD + 360) % 360;
      const snap = Math.round(a / 90) * 90;
      if (Math.abs(a - snap) < 4) a = snap % 360;
      return Math.round(a);
    };
    this._cDrag = false;
    this._cVal = null;
    cp.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this._cDrag = true;
      if (cp.setPointerCapture) cp.setPointerCapture(e.pointerId);
      const a = angleFrom(e);
      if (a != null) {
        this._cVal = a;
        this._drawCompass(a);
      }
    });
    cp.addEventListener("pointermove", (e) => {
      if (!this._cDrag) return;
      const a = angleFrom(e);
      if (a != null) {
        this._cVal = a;
        this._drawCompass(a);
      }
    });
    const cEnd = () => {
      if (!this._cDrag) return;
      this._cDrag = false;
      if (this._cVal != null) this._setNorth(this._cVal);
      this._cVal = null;
    };
    cp.addEventListener("pointerup", cEnd);
    cp.addEventListener("pointercancel", cEnd);
    this.shadowRoot.querySelectorAll(".cbtns button").forEach((b) => {
      b.addEventListener("click", () => this._setNorth(Number(b.getAttribute("data-n"))));
    });
    $("sunReach").addEventListener("input", (e) => {
      $("sunReachVal").textContent = "x" + e.target.value;
    });
    $("sunReach").addEventListener("change", (e) => {
      const c = { ...this._config };
      const v = Number(e.target.value);
      if (v !== 1) c.sun_reach = v;
      else delete c.sun_reach;
      this._config = c;
      this._fire();
    });

    $("zStart").addEventListener("click", () => {
      if (!this._area) {
        this._zoneHint("Pick an Area first.", true);
        return;
      }
      this._drawing = [];
      this._selZone = -1;
      this._zoneHint("Tap each corner of the room. Tap the red dot or hit Finish to close it.", false);
      this._refresh();
    });
    $("zFinish").addEventListener("click", () => this._finishZone());
    $("zUndo").addEventListener("click", () => {
      if (this._drawing && this._drawing.length) {
        this._drawing.pop();
        this._refresh();
      }
    });
    $("zCancel").addEventListener("click", () => {
      this._drawing = null;
      this._zoneHint("Cancelled.", false);
      this._refresh();
    });

    this._wrap.addEventListener("click", (e) => this._onWrapClick(e));
    this._fillEntities();
    this._fillAreas();
    this._fillRoomFilter();
    this._fillOutside();
  }

  _setMode(m) {
    this._mode = m;
    this._drawing = null;
    this._winStart = null;
    const $ = (id) => this.shadowRoot.getElementById(id);
    $("tabItems").classList.toggle("on", m === "items");
    $("tabEntities").classList.toggle("on", m === "entities");
    $("tabZones").classList.toggle("on", m === "zones");
    $("tabWins").classList.toggle("on", m === "wins");
    $("itemsPanel").hidden = m !== "items";
    $("entitiesPanel").hidden = m !== "entities";
    $("zonesPanel").hidden = m !== "zones";
    $("winsPanel").hidden = m !== "wins";
    this._wrap.classList.toggle("zmode", m !== "items");
    $("listTitle").textContent = m === "items" ? "Placed devices" : m === "entities" ? "Configured entities" : m === "wins" ? "Windows" : "Rooms";
    this._refresh();
  }

  _zoneHint(msg, err) {
    this._hintZones.textContent = msg;
    this._hintZones.classList.toggle("err", !!err);
  }

  _pt(e) {
    const r = this._wrap.getBoundingClientRect();
    return {
      x: vfpRound(vfpClamp(((e.clientX - r.left) / r.width) * 100)),
      y: vfpRound(vfpClamp(((e.clientY - r.top) / r.height) * 100)),
    };
  }

  _areaName(id) {
    const a = this._hass && this._hass.areas && this._hass.areas[id];
    return a ? a.name : id;
  }

  _areaMapCached() {
    const h = this._hass;
    if (!h) return {};
    if (this._cEnts !== h.entities || this._cDevs !== h.devices || !this._amap) {
      this._amap = vfpBuildAreaMap(h);
      this._cEnts = h.entities;
      this._cDevs = h.devices;
    }
    return this._amap;
  }

  _fillEntities() {
    if (!this._built || !this._hass) return;
    const dl = this.shadowRoot.getElementById("entities");
    if (dl.childElementCount) return;
    dl.innerHTML = Object.keys(this._hass.states)
      .sort()
      .map((id) => `<option value="${id}"></option>`)
      .join("");
  }

  _fillRoomFilter() {
    if (!this._built || !this._hass || !this._hass.areas) return;
    const sel = this.shadowRoot.getElementById("roomFilter");
    if (sel.options.length > 1) return;
    const map = this._areaMapCached();
    Object.values(this._hass.areas)
      .filter((a) => (map[a.area_id] || []).length)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((a) => {
        const o = document.createElement("option");
        o.value = a.area_id;
        o.textContent = a.name;
        sel.appendChild(o);
      });
  }

  _fillRoomEntities() {
    if (!this._built || !this._hass || !this._config) return;
    const area = this.shadowRoot.getElementById("roomFilter").value;
    const sel = this.shadowRoot.getElementById("roomEntity");
    const prev = this._selSource === "room" ? this._selected : "";
    sel.innerHTML = "";
    const first = document.createElement("option");
    first.value = "";
    sel.appendChild(first);
    if (!area) {
      first.textContent = "-- pick a room first --";
      sel.disabled = true;
      return;
    }
    first.textContent = "-- pick a device --";
    sel.disabled = false;

    const h = this._hass;
    const placed = new Set(this._config.elements.map((e) => e.entity));
    const nameOf = (id) => (h.states[id] && h.states[id].attributes.friendly_name) || id;
    (this._areaMapCached()[area] || [])
      .filter((id) => h.states[id])
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
      .forEach((id) => {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = (placed.has(id) ? "\u2713 " : "") + nameOf(id) + "  (" + id + ")";
        sel.appendChild(o);
      });
    if (prev) sel.value = prev;
  }

  _fillAreas() {
    if (!this._built || !this._hass || !this._hass.areas) return;
    const sel = this.shadowRoot.getElementById("area");
    if (sel.options.length > 1) return;
    Object.values(this._hass.areas)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((a) => {
        const o = document.createElement("option");
        o.value = a.area_id;
        o.textContent = a.name;
        sel.appendChild(o);
      });
  }

  _addElement(x, y) {
    if (!this._hass || !this._hass.states[this._selected]) {
      this._hintItems.textContent = "Pick a valid entity first.";
      this._hintItems.classList.add("err");
      return;
    }
    this._hintItems.textContent = "Placed.";
    this._hintItems.classList.remove("err");
    const elements = [...this._config.elements, { entity: this._selected, x, y }];
    this._config = { ...this._config, elements };
    if (this._selSource === "room") {
      this._selected = "";
      this._selSource = "";
      this.shadowRoot.getElementById("roomEntity").value = "";
    }
    this._fire();
    this._refresh();
  }

  _onWrapClick(e) {
    const mk = e.target.closest && e.target.closest(".marker");
    if (mk) {
      if (this._mode !== "items" || this._suppressClick) return;
      const gi = Number(mk.getAttribute("data-gi"));
      const g = this._groups && this._groups[gi];
      if (!g) return;
      if (this._selected) {
        this._addElement(g.x, g.y);
      } else {
        this._selEntityIdx = g.members[0];
        this._setMode("entities");
      }
      return;
    }
    if (e.target.classList && e.target.classList.contains("handle") && !e.target.classList.contains("first")) return;

    const p = this._pt(e);

    if (this._mode === "items") {
      if (e.target !== this._img) return;
      this._addElement(p.x, p.y);
      return;
    }

    if (this._mode === "wins") {
      if (!this._winStart) {
        this._winStart = [p.x, p.y];
        this._hintWins.textContent = "Now tap the other end of the window.";
        this._hintWins.classList.remove("err");
        this._refresh();
      } else {
        this._finishWindow(p);
      }
      return;
    }

    if (this._drawing) {
      if (e.target.classList && e.target.classList.contains("first")) {
        this._finishZone();
        return;
      }
      this._drawing.push([p.x, p.y]);
      this._refresh();
      return;
    }

    if (e.target.tagName && e.target.tagName.toLowerCase() === "polygon") {
      this._selZone = Number(e.target.getAttribute("data-i"));
      this._refresh();
    }
  }

  _drawCompass(v) {
    const root = this.shadowRoot;
    const ar = root.getElementById("cArrow");
    if (!ar) return;
    const r = v * VFP_RAD;
    ar.setAttribute("x2", (Math.sin(r) * 34).toFixed(1));
    ar.setAttribute("y2", (-Math.cos(r) * 34).toFixed(1));
    const nl = root.getElementById("cN");
    nl.setAttribute("x", (Math.sin(r) * 42).toFixed(1));
    nl.setAttribute("y", (-Math.cos(r) * 42 + 4).toFixed(1));
    const words = ["up", "up-right", "right", "down-right", "down", "down-left", "left", "up-left"];
    root.getElementById("northVal").textContent = "North points " + words[Math.round(v / 45) % 8] + " (" + v + "\u00b0)";
  }

  _setNorth(v) {
    v = ((Math.round(v) % 360) + 360) % 360;
    const c = { ...this._config };
    if (v) c.north = v;
    else delete c.north;
    this._config = c;
    this._drawCompass(v);
    this._fire();
  }

  _aspectEd() {
    const i = this._img;
    return i && i.naturalWidth && i.naturalHeight ? i.naturalWidth / i.naturalHeight : 1.15;
  }

  _finishWindow(p) {
    const s = this._winStart;
    this._winStart = null;
    if (Math.hypot(p.x - s[0], p.y - s[1]) < 0.5) {
      this._hintWins.textContent = "Too close together. Start again.";
      this._hintWins.classList.add("err");
      this._refresh();
      return;
    }
    const wins = [...(this._config.windows || []), { x1: s[0], y1: s[1], x2: p.x, y2: p.y }];
    this._config = { ...this._config, windows: wins };
    this._hintWins.textContent = "Window added.";
    this._hintWins.classList.remove("err");
    this._fire();
    this._refresh();
  }

  _finishZone() {
    if (!this._drawing || this._drawing.length < 3) {
      this._zoneHint("Need at least 3 corners.", true);
      return;
    }
    const zone = {
      area: this._area,
      name: this._areaName(this._area),
      has_walls: true,
      points: this._drawing.map((p) => [p[0], p[1]]),
    };
    const zones = [...this._config.zones, zone];
    this._config = { ...this._config, zones };
    this._drawing = null;
    this._selZone = zones.length - 1;
    this._zoneHint("Room added.", false);
    this._fire();
    this._refresh();
  }

  _refresh() {
    if (!this._built) return;
    const root = this.shadowRoot;
    const $ = (id) => root.getElementById(id);
    $("image").value = this._config.image || "";
    $("zoomLayout").value = this._config.zoom_layout || "vertical";
    $("zoomCorner").value = this._config.zoom_corner || "bottom-right";
    $("offColor").value = this._config.off_color || VFP_DEFAULT_OFF;
    const size = this._config.icon_size || VFP_DEFAULT_SIZE;
    $("iconSize").value = size;
    $("iconSizeVal").textContent = size + " px";
    const radius = this._config.stack_radius != null ? this._config.stack_radius : VFP_DEFAULT_RADIUS;
    $("stackRadius").value = radius;
    $("stackRadiusVal").textContent = radius === 0 ? "off" : radius + " %";
    const north = this._config.north || 0;
    this._drawCompass(north);
    const reach = this._config.sun_reach != null ? this._config.sun_reach : 1;
    $("sunReach").value = reach;
    $("sunReachVal").textContent = "x" + reach;
    if (this._img.getAttribute("src") !== this._config.image) this._img.src = this._config.image || "";

    this._wrap.querySelectorAll(".marker, .handle, .zlabel").forEach((n) => n.remove());
    this._svg.innerHTML = "";
    this._polys = [];
    this._markers = [];

    this._config.zones.forEach((z, i) => {
      const poly = document.createElementNS(SVGNS, "polygon");
      poly.setAttribute("points", vfpPts(z.points));
      poly.setAttribute("data-i", i);
      if (i === this._selZone && this._mode === "zones") poly.setAttribute("class", "sel");
      this._svg.appendChild(poly);
      this._polys.push(poly);

      const lab = document.createElement("div");
      lab.className = "zlabel";
      const c = vfpCentroid(z.points);
      lab.style.left = c[0] + "%";
      lab.style.top = c[1] + "%";
      lab.textContent = z.name || z.area;
      this._wrap.appendChild(lab);
    });

    const winInfo = (this._config.windows || []).map((w) => vfpWindowInfo(w, this._config.zones, this._aspectEd()));
    (this._config.windows || []).forEach((w, i) => {
      const ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("x1", w.x1);
      ln.setAttribute("y1", w.y1);
      ln.setAttribute("x2", w.x2);
      ln.setAttribute("y2", w.y2);
      ln.setAttribute("class", "win" + (winInfo[i] ? "" : " bad"));
      this._svg.appendChild(ln);
    });
    if (this._winStart) {
      const h = document.createElement("div");
      h.className = "handle dot";
      h.style.left = this._winStart[0] + "%";
      h.style.top = this._winStart[1] + "%";
      this._wrap.appendChild(h);
    }

    if (this._drawing) {
      const pl = document.createElementNS(SVGNS, "polyline");
      pl.setAttribute("points", vfpPts(this._drawing));
      this._svg.appendChild(pl);
      this._drawing.forEach((pt, i) => {
        const h = document.createElement("div");
        h.className = "handle dot" + (i === 0 && this._drawing.length >= 3 ? " first" : "");
        h.style.left = pt[0] + "%";
        h.style.top = pt[1] + "%";
        this._wrap.appendChild(h);
      });
    }

    if (this._mode === "zones" && !this._drawing && this._selZone >= 0 && this._config.zones[this._selZone]) {
      this._config.zones[this._selZone].points.forEach((pt, pi) => {
        const h = document.createElement("div");
        h.className = "handle";
        h.style.left = pt[0] + "%";
        h.style.top = pt[1] + "%";
        this._attachVertexDrag(h, this._selZone, pi);
        this._wrap.appendChild(h);
      });
    }

    this._groups = vfpGroup(this._config.elements, radius);
    this._groups.forEach((g, gi) => {
      const m = document.createElement("div");
      m.className = "marker" + (g.members.includes(this._selEntityIdx) ? " sel" : "");
      m.setAttribute("data-gi", gi);
      m.style.left = g.x + "%";
      m.style.top = g.y + "%";
      const sizes = g.members.map((i) => this._config.elements[i].size || size);
      m.style.setProperty("--s", Math.max(...sizes) + "px");
      m.title = g.members.map((i) => this._config.elements[i].entity).join(", ");
      const icon = document.createElement("ha-state-icon");
      m.appendChild(icon);
      if (g.members.length > 1) {
        const b = document.createElement("div");
        b.className = "badge";
        b.textContent = String(g.members.length);
        m.appendChild(b);
      }
      this._attachGroupDrag(m, gi);
      this._wrap.appendChild(m);
      this._markers.push({ entity: this._config.elements[g.members[0]].entity, icon });
    });
    this._refreshIcons();

    const d = !!this._drawing;
    $("zStart").hidden = d;
    $("zFinish").hidden = !d;
    $("zUndo").hidden = !d;
    $("zCancel").hidden = !d;

    this._fillRoomEntities();
    this._syncOutside();
    this._renderGroups();
    this._renderList();
  }

  _fillOutside() {
    if (!this._built || !this._hass) return;
    const $ = (id) => this.shadowRoot.getElementById(id);
    const add = (sel, value, text) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    };
    if ($("outArea").options.length <= 1 && this._hass.areas) {
      Object.values(this._hass.areas)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((a) => add($("outArea"), a.area_id, a.name));
    }
    const ids = Object.keys(this._hass.states).sort();
    if ($("outSun").options.length <= 1) {
      ids.filter((i) => i.startsWith("sun.")).forEach((i) => add($("outSun"), i, i));
    }
    if ($("outMoon").options.length <= 1) {
      ids.filter((i) => i.includes("moon")).forEach((i) => add($("outMoon"), i, i));
    }
    this._syncOutside();
  }

  _syncOutside() {
    if (!this._built || !this._config) return;
    const $ = (id) => this.shadowRoot.getElementById(id);
    const o = this._config.outside || {};
    $("outArea").value = o.area || "";
    $("outSun").value = o.sun || "";
    $("outMoon").value = o.moon || "";
  }

  _setOutside(patch) {
    const o = { ...(this._config.outside || {}), ...patch };
    Object.keys(o).forEach((k) => {
      if (!o[k]) delete o[k];
    });
    const c = { ...this._config };
    if (Object.keys(o).length) c.outside = o;
    else delete c.outside;
    this._config = c;
    this._fire();
  }

  _renderGroups() {
    const box = this.shadowRoot.getElementById("grpList");
    box.innerHTML = "";
    this._fillServices();
    const nameOf = (id) => {
      const st = this._hass && this._hass.states[id];
      return (st && st.attributes.friendly_name) || id;
    };
    const groups = this._config.light_groups || [];
    const save = (next) => {
      const c = { ...this._config };
      if (next.length) c.light_groups = next;
      else delete c.light_groups;
      this._config = c;
      this._fire();
      this._refresh();
    };
    groups.forEach((g, gi) => {
      const wrap = document.createElement("div");
      wrap.className = "grp";

      const top = document.createElement("div");
      top.className = "row";
      top.style.borderBottom = "none";
      const t = document.createElement("span");
      t.textContent = nameOf(g.entity) + "  (" + g.entity + ")";
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => save(groups.filter((_, i) => i !== gi)));
      top.appendChild(t);
      top.appendChild(del);
      wrap.appendChild(top);

      const chips = document.createElement("div");
      chips.className = "chips";
      (g.members || []).forEach((m) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.appendChild(document.createTextNode(nameOf(m)));
        const x = document.createElement("button");
        x.textContent = "\u2715";
        x.addEventListener("click", () =>
          save(groups.map((q, i) => (i === gi ? { ...q, members: q.members.filter((z) => z !== m) } : q)))
        );
        chip.appendChild(x);
        chips.appendChild(chip);
      });
      wrap.appendChild(chips);

      const addrow = document.createElement("div");
      addrow.className = "addrow";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.setAttribute("list", "entities");
      inp.placeholder = "Add a light to this group";
      const btn = document.createElement("button");
      btn.textContent = "Add";
      btn.addEventListener("click", () => {
        const id = inp.value.trim();
        if (!this._hass || !this._hass.states[id] || (g.members || []).includes(id)) return;
        save(groups.map((q, i) => (i === gi ? { ...q, members: [...(q.members || []), id] } : q)));
      });
      addrow.appendChild(inp);
      addrow.appendChild(btn);
      wrap.appendChild(addrow);

      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "Group tap and hold actions" + (g.tap_action || g.hold_action ? " (custom)" : "");
      det.appendChild(sum);
      det.appendChild(this._actionBlockForGroup(gi, g, "tap_action", "When group is tapped", "toggle"));
      det.appendChild(this._actionBlockForGroup(gi, g, "hold_action", "When group is held (or right-clicked)", "more info"));
      wrap.appendChild(det);

      box.appendChild(wrap);
    });
  }

  _updateElement(idx, patch, removeKeys) {
    const elements = this._config.elements.map((e, i) => {
      if (i !== idx) return e;
      const n = { ...e, ...patch };
      (removeKeys || []).forEach((k) => delete n[k]);
      return n;
    });
    this._config = { ...this._config, elements };
    this._fire();
    this._refresh();
  }

  _updateGroup(gi, patch, removeKeys) {
    const groups = (this._config.light_groups || []).map((g, i) => {
      if (i !== gi) return g;
      const n = { ...g, ...patch };
      (removeKeys || []).forEach((k) => delete n[k]);
      return n;
    });
    this._config = { ...this._config, light_groups: groups };
    this._fire();
    this._refresh();
  }

  _updateZone(idx, patch) {
    const zones = this._config.zones.map((z, i) => (i === idx ? { ...z, ...patch } : z));
    this._config = { ...this._config, zones };
    this._fire();
    this._refresh();
  }

  _fillServices() {
    if (!this._built || !this._hass || !this._hass.services) return;
    const dl = this.shadowRoot.getElementById("services");
    if (!dl || dl.childElementCount) return;
    const out = [];
    Object.keys(this._hass.services).forEach((d) =>
      Object.keys(this._hass.services[d]).forEach((sv) => out.push(d + "." + sv))
    );
    out.sort();
    dl.innerHTML = out.map((v) => `<option value="${v}"></option>`).join("");
  }

  _actionBlock(idx, el, key, title, defText) {
    const cfg = el[key] || {};
    const box = document.createElement("div");
    box.className = "act";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = title;
    box.appendChild(t);

    const sel = document.createElement("select");
    [
      ["", "Default (" + defText + ")"],
      ["toggle", "Toggle"],
      ["more-info", "Open the more info page"],
      ["call-service", "Call a service"],
      ["navigate", "Go to a dashboard page"],
      ["url", "Open a web link"],
      ["none", "Do nothing"],
    ].forEach(([v, l]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      sel.appendChild(o);
    });
    sel.value = cfg.action || "";
    sel.addEventListener("change", () => {
      if (!sel.value) this._updateElement(idx, {}, [key]);
      else this._updateElement(idx, { [key]: { action: sel.value } });
    });
    box.appendChild(sel);

    const save = (patch, removes) => {
      const current = this._config.elements[idx][key] || {};
      const next = { ...current, ...patch };
      (removes || []).forEach((k) => delete next[k]);
      this._updateElement(idx, { [key]: next });
    };
    const field = (ph, val, list, onChange) => {
      const i = document.createElement("input");
      i.type = "text";
      i.placeholder = ph;
      i.value = val || "";
      if (list) i.setAttribute("list", list);
      i.addEventListener("change", () => onChange(i.value.trim()));
      box.appendChild(i);
      return i;
    };
    const entField = () =>
      field("Entity (blank = this device)", cfg.entity, "entities", (v) =>
        v ? save({ entity: v }) : save({}, ["entity"])
      );

    const a = cfg.action;
    if (a === "toggle" || a === "more-info") {
      entField();
    } else if (a === "call-service") {
      field("Service, e.g. light.turn_on", cfg.service, "services", (v) => save({ service: v }));
      entField();
      const ta = document.createElement("textarea");
      ta.placeholder = 'Extra data as JSON, e.g. {"brightness_pct": 50}';
      ta.value = cfg.data && Object.keys(cfg.data).length ? JSON.stringify(cfg.data, null, 2) : "";
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "The entity above is sent along with the service unless you tick the box below.";
      ta.addEventListener("change", () => {
        const txt = ta.value.trim();
        if (!txt) {
          save({}, ["data"]);
          return;
        }
        try {
          const obj = JSON.parse(txt);
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
          save({ data: obj });
          ta.classList.remove("bad");
          note.classList.remove("err");
          note.textContent = "The entity above is sent along with the service unless you tick the box below.";
        } catch (e) {
          ta.classList.add("bad");
          note.classList.add("err");
          note.textContent = "That is not valid JSON, so it was not saved.";
        }
      });
      box.appendChild(ta);
      box.appendChild(note);
      const cl = document.createElement("label");
      cl.className = "chk";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!cfg.no_entity;
      cb.addEventListener("change", () => (cb.checked ? save({ no_entity: true }) : save({}, ["no_entity"])));
      cl.appendChild(cb);
      cl.appendChild(document.createTextNode("Don't send an entity (for scripts, notifications, etc.)"));
      box.appendChild(cl);
    } else if (a === "navigate") {
      field("Path, e.g. /lovelace/cameras", cfg.path, null, (v) => save({ path: v }));
    } else if (a === "url") {
      field("https://...", cfg.url, null, (v) => save({ url: v }));
    }
    return box;
  }

  _actionBlockForGroup(gi, g, key, title, defText) {
    const cfg = g[key] || {};
    const box = document.createElement("div");
    box.className = "act";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = title;
    box.appendChild(t);

    const sel = document.createElement("select");
    [
      ["", "Default (" + defText + ")"],
      ["toggle", "Toggle"],
      ["more-info", "Open the more info page"],
      ["call-service", "Call a service"],
      ["navigate", "Go to a dashboard page"],
      ["url", "Open a web link"],
      ["none", "Do nothing"],
    ].forEach(([v, l]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      sel.appendChild(o);
    });
    sel.value = cfg.action || "";
    sel.addEventListener("change", () => {
      if (!sel.value) this._updateGroup(gi, {}, [key]);
      else this._updateGroup(gi, { [key]: { action: sel.value } });
    });
    box.appendChild(sel);

    const save = (patch, removes) => {
      const current = (this._config.light_groups[gi] && this._config.light_groups[gi][key]) || {};
      const next = { ...current, ...patch };
      (removes || []).forEach((k) => delete next[k]);
      this._updateGroup(gi, { [key]: next });
    };
    const field = (ph, val, list, onChange) => {
      const i = document.createElement("input");
      i.type = "text";
      i.placeholder = ph;
      i.value = val || "";
      if (list) i.setAttribute("list", list);
      i.addEventListener("change", () => onChange(i.value.trim()));
      box.appendChild(i);
      return i;
    };
    const entField = () =>
      field("Entity (blank = this group)", cfg.entity, "entities", (v) =>
        v ? save({ entity: v }) : save({}, ["entity"])
      );

    const a = cfg.action;
    if (a === "toggle" || a === "more-info") {
      entField();
    } else if (a === "call-service") {
      field("Service, e.g. light.turn_on", cfg.service, "services", (v) => save({ service: v }));
      entField();
      const ta = document.createElement("textarea");
      ta.placeholder = 'Extra data as JSON, e.g. {"brightness_pct": 50}';
      ta.value = cfg.data && Object.keys(cfg.data).length ? JSON.stringify(cfg.data, null, 2) : "";
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "The entity above is sent along with the service unless you tick the box below.";
      ta.addEventListener("change", () => {
        const txt = ta.value.trim();
        if (!txt) {
          save({}, ["data"]);
          return;
        }
        try {
          const obj = JSON.parse(txt);
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
          save({ data: obj });
          ta.classList.remove("bad");
          note.classList.remove("err");
          note.textContent = "The entity above is sent along with the service unless you tick the box below.";
        } catch (e) {
          ta.classList.add("bad");
          note.classList.add("err");
          note.textContent = "That is not valid JSON, so it was not saved.";
        }
      });
      box.appendChild(ta);
      box.appendChild(note);
      const cl = document.createElement("label");
      cl.className = "chk";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!cfg.no_entity;
      cb.addEventListener("change", () => (cb.checked ? save({ no_entity: true }) : save({}, ["no_entity"])));
      cl.appendChild(cb);
      cl.appendChild(document.createTextNode("Don't send an entity (for scripts, notifications, etc.)"));
      box.appendChild(cl);
    } else if (a === "navigate") {
      field("Path, e.g. /lovelace/cameras", cfg.path, null, (v) => save({ path: v }));
    } else if (a === "url") {
      field("https://...", cfg.url, null, (v) => save({ url: v }));
    }
    return box;
  }

  _renderList() {
    const list = this.shadowRoot.getElementById("list");
    const entitiesList = this.shadowRoot.getElementById("entitiesList");
    this._fillServices();
    list.innerHTML = "";
    entitiesList.innerHTML = "";
    const globalSize = this._config.icon_size || VFP_DEFAULT_SIZE;

    if (this._mode === "entities") {
      this._config.elements.forEach((el, idx) => {
        const row = document.createElement("div");
        row.className = "row col" + (idx === this._selEntityIdx ? " sel" : "");

        const top = document.createElement("div");
        top.className = "top";
        const name = document.createElement("span");
        name.textContent = el.entity;
        top.appendChild(name);
        const del = document.createElement("button");
        del.className = "danger";
        del.textContent = "Delete";
        del.addEventListener("click", () => {
          this._config = { ...this._config, elements: this._config.elements.filter((_, i) => i !== idx) };
          this._selEntityIdx = -1;
          this._fire();
          this._refresh();
        });
        top.appendChild(del);
        row.appendChild(top);

        const ctl = document.createElement("div");
        ctl.className = "ctl";
        const lbl = document.createElement("span");
        lbl.textContent = "Size";
        const rng = document.createElement("input");
        rng.type = "range";
        rng.min = "16";
        rng.max = "90";
        rng.step = "1";
        rng.value = String(el.size || globalSize);
        const val = document.createElement("span");
        val.textContent = rng.value + " px";
        rng.addEventListener("input", () => {
          val.textContent = rng.value + " px";
        });
        rng.addEventListener("change", () => this._updateElement(idx, { size: Number(rng.value) }));
        ctl.appendChild(lbl);
        ctl.appendChild(rng);
        ctl.appendChild(val);
        row.appendChild(ctl);

        const glowCtl = document.createElement("div");
        glowCtl.className = "ctl";
        const glowCb = document.createElement("input");
        glowCb.type = "checkbox";
        glowCb.checked = el.glow !== false;
        glowCb.id = "glowchk" + idx;
        glowCb.addEventListener("change", () => {
          if (glowCb.checked) this._updateElement(idx, {}, ["glow"]);
          else this._updateElement(idx, { glow: false });
        });
        const glowCl = document.createElement("label");
        glowCl.setAttribute("for", glowCb.id);
        glowCl.textContent = "Glow Effect (glows/casts aura when active)";
        glowCtl.appendChild(glowCb);
        glowCtl.appendChild(glowCl);
        row.appendChild(glowCtl);

        const intensityCtl = document.createElement("div");
        intensityCtl.className = "ctl";
        const intensityLbl = document.createElement("span");
        intensityLbl.textContent = "Intensity";
        const intensityRng = document.createElement("input");
        intensityRng.type = "range";
        intensityRng.min = "0";
        intensityRng.max = "3";
        intensityRng.step = "0.1";
        intensityRng.value = String(el.glow_intensity != null ? el.glow_intensity : 1);
        const intensityVal = document.createElement("span");
        intensityVal.textContent = intensityRng.value + "x";
        intensityRng.addEventListener("input", () => {
          intensityVal.textContent = intensityRng.value + "x";
        });
        intensityRng.addEventListener("change", () => this._updateElement(idx, { glow_intensity: Number(intensityRng.value) }));
        intensityCtl.appendChild(intensityLbl);
        intensityCtl.appendChild(intensityRng);
        intensityCtl.appendChild(intensityVal);
        row.appendChild(intensityCtl);

        const domain = el.entity.split(".")[0];

        if (domain === "media_player") {
          const tvCtl = document.createElement("div");
          tvCtl.className = "ctl";
          const tvCb = document.createElement("input");
          tvCb.type = "checkbox";
          tvCb.checked = !!el.tv_glow;
          tvCb.id = "tvglow" + idx;
          tvCb.addEventListener("change", () => {
            if (tvCb.checked) this._updateElement(idx, { tv_glow: true });
            else this._updateElement(idx, {}, ["tv_glow"]);
          });
          const tvCl = document.createElement("label");
          tvCl.setAttribute("for", tvCb.id);
          tvCl.textContent = "Simulate TV Glow (ambient backlight)";
          tvCtl.appendChild(tvCb);
          tvCtl.appendChild(tvCl);
          row.appendChild(tvCtl);
        }

        if (VFP_PICTURE_DOMAINS.includes(domain)) {
          const pc = document.createElement("div");
          pc.className = "ctl";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = el.picture !== false;
          cb.id = "pic" + idx;
          cb.addEventListener("change", () => {
            if (cb.checked) this._updateElement(idx, {}, ["picture"]);
            else this._updateElement(idx, { picture: false });
          });
          const cl = document.createElement("label");
          cl.setAttribute("for", cb.id);
          cl.textContent = "Show artwork / photo when available";
          pc.appendChild(cb);
          pc.appendChild(cl);
          row.appendChild(pc);
        }

        const groupMatch = (this._config.light_groups || []).find((g) => (g.members || []).includes(el.entity));
        if (groupMatch) {
          const note = document.createElement("div");
          note.className = "hint";
          note.textContent = "Actions for this entity are handled by its light group (" + groupMatch.entity + "). Configure them under Light Groups above.";
          row.appendChild(note);
        } else {
          const defTap = VFP_TOGGLE_DOMAINS.includes(domain) ? "toggle" : "more info";
          const det = document.createElement("details");
          const sum = document.createElement("summary");
          sum.textContent = "Tap and hold actions" + (el.tap_action || el.hold_action ? " (custom)" : "");
          det.appendChild(sum);
          if (idx === this._selEntityIdx) det.open = true;
          det.appendChild(this._actionBlock(idx, el, "tap_action", "When tapped", defTap));
          det.appendChild(this._actionBlock(idx, el, "hold_action", "When held (or right-clicked)", "more info"));
          row.appendChild(det);
        }

        entitiesList.appendChild(row);
      });
      return;
    }

    if (this._mode === "items") {
      this._config.elements.forEach((el, idx) => {
        const row = document.createElement("div");
        row.className = "row";
        const name = document.createElement("span");
        name.textContent = el.entity;
        row.appendChild(name);
        const del = document.createElement("button");
        del.className = "danger";
        del.textContent = "Delete";
        del.addEventListener("click", () => {
          this._config = { ...this._config, elements: this._config.elements.filter((_, i) => i !== idx) };
          this._fire();
          this._refresh();
        });
        row.appendChild(del);
        list.appendChild(row);
      });
      return;
    }

    if (this._mode === "wins") {
      const aspect = this._aspectEd();
      (this._config.windows || []).forEach((w, idx) => {
        const info = vfpWindowInfo(w, this._config.zones, aspect);
        const row = document.createElement("div");
        row.className = "row";
        const name = document.createElement("span");
        const zn = info ? this._config.zones[info.zi] : null;
        name.textContent = "Window " + (idx + 1) + (zn ? "  (" + (zn.name || zn.area) + ")" : "  (not next to a room)");
        row.appendChild(name);
        const del = document.createElement("button");
        del.className = "danger";
        del.textContent = "Delete";
        del.addEventListener("click", () => {
          this._config = { ...this._config, windows: this._config.windows.filter((_, i) => i !== idx) };
          if (!this._config.windows.length) {
            const c = { ...this._config };
            delete c.windows;
            this._config = c;
          }
          this._fire();
          this._refresh();
        });
        row.appendChild(del);
        list.appendChild(row);
      });
      return;
    }

    this._config.zones.forEach((z, idx) => {
      const row = document.createElement("div");
      row.className = "row col" + (idx === this._selZone ? " sel" : "");
      
      const top = document.createElement("div");
      top.className = "top";
      const name = document.createElement("span");
      name.textContent = (z.name || z.area) + "  (" + this._areaName(z.area) + ")";
      top.appendChild(name);

      const rb = document.createElement("div");
      rb.className = "rb";
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        this._selZone = idx;
        this._drawing = null;
        this._refresh();
      });
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        this._config = { ...this._config, zones: this._config.zones.filter((_, i) => i !== idx) };
        this._selZone = -1;
        this._fire();
        this._refresh();
      });
      rb.appendChild(edit);
      rb.appendChild(del);
      top.appendChild(rb);
      row.appendChild(top);

      const wallCtl = document.createElement("div");
      wallCtl.className = "ctl";
      const wallCb = document.createElement("input");
      wallCb.type = "checkbox";
      wallCb.checked = z.has_walls !== false;
      wallCb.id = "walls" + idx;
      wallCb.addEventListener("change", () => {
        this._updateZone(idx, { has_walls: wallCb.checked });
      });
      const wallCl = document.createElement("label");
      wallCl.setAttribute("for", wallCb.id);
      wallCl.textContent = "Has Walls & Roof (clips indoor lighting)";
      wallCtl.appendChild(wallCb);
      wallCtl.appendChild(wallCl);
      row.appendChild(wallCtl);

      list.appendChild(row);
    });
  }

  _refreshIcons() {
    if (!this._hass || !this._markers) return;
    this._markers.forEach(({ entity, icon }) => {
      const st = this._hass.states[entity];
      icon.hass = this._hass;
      if (st) icon.stateObj = st;
    });
  }

  _attachGroupDrag(m, gi) {
    m.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      m.setPointerCapture(e.pointerId);
      this._drag = { kind: "group", gi, moved: false, x: 0, y: 0 };
    });
    m.addEventListener("pointermove", (e) => {
      if (!this._drag || this._drag.kind !== "group" || this._drag.gi !== gi) return;
      const p = this._pt(e);
      m.style.left = p.x + "%";
      m.style.top = p.y + "%";
      this._drag.x = p.x;
      this._drag.y = p.y;
      this._drag.moved = true;
    });
    const end = () => {
      if (!this._drag || this._drag.kind !== "group" || this._drag.gi !== gi) return;
      const { moved, x, y } = this._drag;
      this._drag = null;
      if (moved) {
        this._suppressClick = true;
        setTimeout(() => {
          this._suppressClick = false;
        }, 100);
        const members = new Set(this._groups[gi].members);
        const elements = this._config.elements.map((el, i) => (members.has(i) ? { ...el, x, y } : el));
        this._config = { ...this._config, elements };
        this._fire();
        this._refresh();
      } else {
        const g = this._groups[gi];
        if (g) {
          this._selEntityIdx = g.members[0];
          this._setMode("entities");
        }
      }
    };
    m.addEventListener("pointerup", end);
    m.addEventListener("pointercancel", end);
  }

  _attachVertexDrag(h, zi, pi) {
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      this._drag = { kind: "vertex", zi, pi, moved: false, x: 0, y: 0 };
    });
    h.addEventListener("pointermove", (e) => {
      if (!this._drag || this._drag.kind !== "vertex" || this._drag.zi !== zi || this._drag.pi !== pi) return;
      const p = this._pt(e);
      h.style.left = p.x + "%";
      h.style.top = p.y + "%";
      const pts = this._config.zones[zi].points.map((q, i) => (i === pi ? [p.x, p.y] : q));
      this._polys[zi].setAttribute("points", vfpPts(pts));
      this._drag.x = p.x;
      this._drag.y = p.y;
      this._drag.moved = true;
    });
    const end = () => {
      if (!this._drag || this._drag.kind !== "vertex" || this._drag.zi !== zi || this._drag.pi !== pi) return;
      const { moved, x, y } = this._drag;
      this._drag = null;
      if (moved) {
        const zones = this._config.zones.map((z, i) =>
          i === zi ? { ...z, points: z.points.map((q, j) => (j === pi ? [x, y] : q)) } : z
        );
        this._config = { ...this._config, zones };
        this._fire();
      }
    };
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
  }

  _fire() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: { ...this._config } },
        bubbles: true,
        composed: true,
      })
    );
  }
}

customElements.define("visual-floorplan-card", VisualFloorplanCard);
customElements.define("visual-floorplan-card-editor", VisualFloorplanCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "visual-floorplan-card",
  name: "Visual Floorplan",
  description: "Floor plan image with drag-and-drop devices, stacks, artwork, and glowing rooms bound to HA Areas. No YAML.",
});
