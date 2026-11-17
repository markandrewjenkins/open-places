// Airline names for the Air Traffic card's "Operator" row (src/air/operator.js): the three-letter ICAO prefix of a
// callsign (ACA810 → Air Canada). From OpenFlights' airline database (airlines.dat), whose data is under the Open
// Database License (ODbL 1.0, openflights.org/data.php; the repository's code is AGPL, the data is not). Kept: airlines
// marked active, plus the ones the callsign table in src/air/airlines.js already knows and a few freight / charter
// operators the file marks inactive though they still fly here. Writes site/public/data/air/airline-names.json as
// { credit, names: { ICAO: [name, country] } }. Run by hand: node tools/fetch_airline_names.mjs (one request).
import { writeFileSync, readFileSync } from "node:fs";

const SRC = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat";
const OUT = new URL("../site/public/data/air/airline-names.json", import.meta.url);
const UA = { "User-Agent": "openplaces-airlines/1.0 (static file build)" };
// marked inactive in airlines.dat, still flying in this region
const EXTRA = new Set(["FDX", "UPS", "FLE", "NRL", "ASP", "GTI", "ABX", "ATN", "KFA", "CJT"]);
// tidier names for a few (the file's own names are kept otherwise)
const FIX = { FDX: ["FedEx", "United States"], UPS: ["UPS Airlines", "United States"], JZA: ["Jazz (Air Canada Express)", "Canada"], ASA: ["Alaska Airlines", "United States"],
  ROU: ["Air Canada Rouge", "Canada"], PCO: ["Pacific Coastal Airlines", "Canada"] };

// the callsign table's ICAO codes (five-character records, three-letter ICAO first)
const packed = readFileSync(new URL("../site/src/air/airlines.js", import.meta.url), "utf8").match(/"([A-Z0-9]+)"/g).map((s) => s.slice(1, -1)).join("");
const known = new Set(Array.from({ length: packed.length / 5 }, (_, i) => packed.slice(i * 5, i * 5 + 3)));

const text = await fetch(SRC, { headers: UA }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
// CSV with quoted fields and \N for null
const parse = (line) => [...line.matchAll(/("([^"]*)"|\\N|[^,]*)(,|$)/g)].map((m) => (m[2] ?? (m[1] === "\\N" ? "" : m[1]))).slice(0, 8);
const names = {};
for (const line of text.split(/\r?\n/)) {
  if (!line) continue;
  const [, name, , , icao, , country, active] = parse(line);
  if (!/^[A-Z]{3}$/.test(icao || "") || !name) continue;
  const keep = active === "Y" || known.has(icao) || EXTRA.has(icao);
  if (!keep) continue;
  // the same code twice: the active row wins
  if (names[icao] && active !== "Y") continue;
  names[icao] = [name.trim(), (country || "").trim()];
}
for (const [k, v] of Object.entries(FIX)) names[k] = v;
writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), credit: "Airline names: OpenFlights airline database (ODbL 1.0)", names }));
console.log(`${Object.keys(names).length} airlines → ${OUT.pathname}`);
