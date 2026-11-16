// Generic vehicle icons for the Public Transit map, by GTFS route_type and route colour: a side view of a bus,
// streetcar, subway train, train, ferry or cabin, drawn on a canvas on demand (MapLibre's styleimagemissing) so any
// route colour works. No agency liveries, logos or marks. Greater Victoria keeps its own double-decker drawings
// (./buses.js). Image ids: "veh|<mode>|<#rrggbb>|<r|l>".
const W = 56, H = 32;     // drawn at 2× (pixelRatio 2): 28 × 16 on screen at icon-size 1

function body(c, mode, fill) {
  const glass = "rgba(255,255,255,0.88)", ink = "#1b2127", wheel = "#20262c";
  c.lineJoin = "round";
  const rr = (x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, w, h, r); };
  const wheels = (xs, y, r) => { c.fillStyle = wheel; for (const x of xs) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); } };
  const outline = () => { c.lineWidth = 2.4; c.strokeStyle = "#ffffff"; c.stroke(); c.lineWidth = 1; c.strokeStyle = ink; c.stroke(); };
  if (mode === "ferry") {
    c.beginPath(); c.moveTo(3, 18); c.lineTo(53, 18); c.lineTo(46, 28); c.lineTo(9, 28); c.closePath(); c.fillStyle = fill; c.fill(); outline();
    rr(14, 8, 26, 10, 3); c.fillStyle = "#ffffff"; c.fill(); c.lineWidth = 1; c.strokeStyle = ink; c.stroke();
    c.fillStyle = fill; for (const x of [17, 24, 31]) c.fillRect(x, 11, 5, 4);
    return;
  }
  if (mode === "cable" || mode === "gondola" || mode === "funicular") {
    c.strokeStyle = ink; c.lineWidth = 1.4; c.beginPath(); c.moveTo(4, 4); c.lineTo(52, 2); c.stroke();
    c.beginPath(); c.moveTo(28, 3); c.lineTo(28, 9); c.stroke();
    rr(15, 9, 26, 19, 5); c.fillStyle = fill; c.fill(); outline();
    rr(18, 12, 20, 7, 2); c.fillStyle = glass; c.fill();
    return;
  }
  if (mode === "subway" || mode === "monorail") {
    rr(2, 7, 51, 17, 7); c.fillStyle = fill; c.fill(); outline();
    c.fillStyle = glass; for (const x of [7, 17, 27, 37]) c.fillRect(x, 11, 7, 6);
    c.beginPath(); c.roundRect(46, 10, 5, 8, 2); c.fill();
    wheels([12, 42], 25, 2.6);
    return;
  }
  if (mode === "rail") {
    c.beginPath(); c.moveTo(2, 8); c.lineTo(42, 8); c.quadraticCurveTo(53, 9, 54, 20); c.lineTo(54, 24); c.lineTo(2, 24); c.closePath(); c.fillStyle = fill; c.fill(); outline();
    c.fillStyle = glass; for (const x of [6, 15, 24, 33]) c.fillRect(x, 11, 6, 5);
    c.beginPath(); c.moveTo(43, 11); c.lineTo(49, 12); c.lineTo(50, 16); c.lineTo(43, 16); c.closePath(); c.fill();
    c.fillStyle = "rgba(255,255,255,0.55)"; c.fillRect(3, 19, 50, 1.6);
    wheels([10, 18, 38, 46], 25, 2.4);
    return;
  }
  if (mode === "tram") {
    c.strokeStyle = ink; c.lineWidth = 1.2; c.beginPath(); c.moveTo(22, 7); c.lineTo(28, 2); c.lineTo(34, 7); c.stroke();
    c.beginPath(); c.moveTo(6, 7); c.lineTo(50, 7); c.quadraticCurveTo(54, 8, 54, 13); c.lineTo(54, 24); c.lineTo(2, 24); c.lineTo(2, 13); c.quadraticCurveTo(2, 8, 6, 7); c.closePath();
    c.fillStyle = fill; c.fill(); outline();
    c.fillStyle = glass; for (const x of [6, 16, 26, 36]) c.fillRect(x, 10, 8, 7); c.fillRect(46, 10, 6, 8);
    wheels([12, 44], 25, 2.4);
    return;
  }
  // bus / trolleybus
  if (mode === "trolleybus") { c.strokeStyle = ink; c.lineWidth = 1.1; c.beginPath(); c.moveTo(16, 6); c.lineTo(34, 1); c.moveTo(20, 6); c.lineTo(38, 1); c.stroke(); }
  rr(2, 6, 51, 18, 4.5); c.fillStyle = fill; c.fill(); outline();
  c.fillStyle = glass; c.beginPath(); c.roundRect(6, 9, 33, 7, 1.5); c.fill();
  c.beginPath(); c.moveTo(45, 9); c.lineTo(50.5, 9); c.quadraticCurveTo(52, 9, 52, 11); c.lineTo(52, 17); c.lineTo(45, 17); c.closePath(); c.fill();
  c.fillStyle = "rgba(0,0,0,0.28)"; c.fillRect(40, 10, 3.5, 12);
  wheels([12, 42], 24.5, 4);
  c.fillStyle = "#c9ced3"; for (const x of [12, 42]) { c.beginPath(); c.arc(x, 24.5, 1.5, 0, 7); c.fill(); }
}

/** ImageData for an icon id, or null if the id isn't ours */
export function vehicleImage(id) {
  const [k, mode, color, face] = id.split("|");
  if (k !== "veh") return null;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (face === "l") { c.translate(W, 0); c.scale(-1, 1); }
  body(c, mode, /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb");
  return c.getImageData(0, 0, W, H);
}
/** a data: URI for legends (same drawing) */
export function vehicleURI(mode, color, face = "r") {
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  cv.getContext("2d").putImageData(vehicleImage(`veh|${mode}|${color}|${face}`), 0, 0);
  return cv.toDataURL();
}
import { isoImage } from "./iso.js";
/** wire on-demand icons into a map (call once per map; images survive style reloads via the same event) */
export function useVehicleIcons(map) {
  map.on("styleimagemissing", (e) => {
    if (map.hasImage(e.id)) return;
    const img = vehicleImage(e.id) || isoImage(e.id);
    if (img) map.addImage(e.id, img, { pixelRatio: 2 });
  });
}
/** icon facing from a bearing (degrees, 0 = north): right when heading east-ish */
export const face = (bearing) => (bearing == null || Number.isNaN(+bearing) ? "r" : +bearing % 360 < 180 ? "r" : "l");
