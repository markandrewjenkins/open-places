// A ship's AIS destination in words. The destination is free text the crew types: usually a UN/LOCODE ("CAVAN",
// "CA VAN", "US-SEA"), sometimes a place name or an abbreviation ("VANCOUVER ANCH", "PT ANGELES"), sometimes a voyage
// ("CAVAN>USSEA", "CNSHA => CAVAN"). Known ports (locodes.js, from UN/LOCODE) come back as "Vancouver, BC (CAVAN)";
// anything else is left exactly as broadcast.
//
//   destination(raw) → { text, known } | null      text: "Vancouver, BC (CAVAN), anchorage", "Tacoma, WA (USTIW) → …"
import { LOCODES, LOCODE_CREDIT } from "./locodes.js";
export { LOCODE_CREDIT };

const plain = (s) => s.replace(/\s+/g, " ").trim();
// port name → code; the file lists Canada before the US, so "VANCOUVER" is Vancouver, BC (Vancouver, WA is USVAN)
const BY_NAME = new Map();
for (const [code, n] of Object.entries(LOCODES)) { const k = plain(n.split(",")[0].toUpperCase()); if (!BY_NAME.has(k)) BY_NAME.set(k, code); }
// names crews use that aren't UN/LOCODE names
const ALIAS = { "ROBERTS BANK": "CADEL", DELTAPORT: "CADEL", "VANCOUVER HARBOUR": "CAVAN", "BURRARD INLET": "CAVAN", "ENGLISH BAY": "CAVAN", "VICTORIA HARBOUR": "CAVIC", "PORT ANGELES": "USNOW" };

const ANCH = /\s*\b(ANCH(ORAGE)?|ANCHORED|ANCHOR|ANC)\.?$/;
function one(part) {
  const raw = part.trim();
  let s = plain(raw.toUpperCase().replace(/[.,;:]+$/, ""));
  let anch = false;
  const m = ANCH.exec(s);
  if (m && m.index > 0) { anch = true; s = s.slice(0, m.index).trim(); }
  const squeezed = s.replace(/[\s-]+/g, "");
  let code = /^[A-Z]{2}[A-Z2-9]{3}$/.test(squeezed) && LOCODES[squeezed] ? squeezed : null;
  if (!code) {
    const name = plain(s.replace(/\b(B\.?C\.?|WA|USA|U\.S\.A\.|CANADA|CDA)\b/g, " ").replace(/\bPT\.?\b/g, "PORT").replace(/\bN\.?\s?(?=VAN)/, "NORTH "));
    code = ALIAS[name] && LOCODES[ALIAS[name]] ? ALIAS[name] : BY_NAME.get(name) || null;
  }
  return code ? { ok: true, text: `${LOCODES[code]} (${code})${anch ? ", anchorage" : ""}` } : { ok: false, text: raw };
}
export function destination(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const parts = t.split(/\s*(?:=>|->|>)\s*/).filter(Boolean);
  const out = parts.map(one);
  return out.some((p) => p.ok) ? { text: out.map((p) => p.text).join(" → "), known: true } : { text: t, known: false };
}
