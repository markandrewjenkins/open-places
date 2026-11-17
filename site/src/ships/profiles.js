// Side-profile drawings of the Sea Traffic vessel classes (classes.js), for the ship card when no example photo is on
// file (src/shared/typephoto.js). Plain generic outlines drawn in code, bow to the right, sitting on a waterline: no
// operator colours, funnel marks or liveries. The hull carries the class's legend colour.
//
//   vesselProfileSVG(classId, { dark }) → SVG string (viewBox 200×64)
import { CLASS } from "./classes.js";

export function vesselProfileSVG(id, { dark = false } = {}) {
  const c = CLASS[id] || CLASS.other;
  const hull = c.color === "#eef1f4" ? (dark ? "#c4ccd6" : "#dfe4ea") : c.color;
  const top = dark ? "#e6eaf0" : "#f7f9fb", line = dark ? "#8392a5" : "#4a5568", win = dark ? "#2a3442" : "#39475a", grey = dark ? "#9aa5b2" : "#8d99a8", sea = dark ? "#3b6c93" : "#8fbcdc";
  const P = (d, f = top, extra = "") => `<path d="${d}" fill="${f}"${extra}/>`;
  const wins = (x0, x1, y, step = 5, w = 3, h = 2) => { let s = ""; for (let x = x0; x <= x1; x += step) s += `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`; return `<g fill="${win}" stroke="none">${s}</g>`; };
  const water = `<path d="M2 50 Q12 48 22 50 T42 50 T62 50 T82 50 T102 50 T122 50 T142 50 T162 50 T182 50 T198 50" fill="none" stroke="${sea}" stroke-width="1.6"/>`;
  const D = {
    // big double-ended car ferry: long hull, car deck, two passenger decks, a bridge at each end, a funnel amidships
    "ferry-l": P("M8 38 L192 38 L186 49 L14 49 Z", hull) + P("M14 30 L186 30 L186 38 L14 38 Z") + P("M30 22 L170 22 L172 30 L28 30 Z") + P("M22 17 L38 17 L40 22 L20 22 Z") + P("M162 17 L178 17 L180 22 L160 22 Z")
      + P("M94 10 L106 10 L108 22 L92 22 Z", grey) + wins(32, 166, 25, 5) + wins(18, 180, 33, 6, 3, 1.6),
    // smaller double-ended ferry: one passenger deck over the car deck
    "ferry-s": P("M28 40 L172 40 L166 49 L34 49 Z", hull) + P("M34 33 L166 33 L166 40 L34 40 Z") + P("M60 25 L140 25 L142 33 L58 33 Z") + P("M90 18 L110 18 L112 25 L88 25 Z") + wins(64, 134, 28, 6),
    // foot ferry / water taxi: small hull, long cabin
    foot: P("M50 42 L160 42 C156 47 150 49 144 49 L58 49 Z", hull) + P("M66 32 L138 32 L146 42 L62 42 Z") + P("M70 28 L120 28 L124 32 L68 32 Z", grey) + wins(70, 136, 35, 7, 4, 3),
    // fast boat / catamaran: low raked superstructure
    hsc: P("M36 42 L176 42 C170 47 162 49 152 49 L44 49 Z", hull) + P("M50 32 L136 32 L160 42 L46 42 Z") + P("M70 26 L120 26 L134 32 L66 32 Z") + wins(54, 140, 35, 6, 4, 2.4),
    // cruise ship: tall white decks, a funnel aft, a raked bow
    cruise: P("M6 34 L196 32 L184 49 L14 49 Z", hull) + P("M14 18 L176 18 L184 34 L10 34 Z") + P("M24 12 L160 12 L164 18 L22 18 Z") + P("M40 4 L52 4 L56 12 L40 12 Z", grey)
      + wins(16, 176, 21, 4, 2.4, 1.6) + wins(16, 178, 26, 4, 2.4, 1.6) + wins(26, 156, 14.5, 4, 2.4, 1.4),
    // container ship: stacked boxes, the bridge aft
    cargo: P("M6 36 L194 34 L182 49 L14 49 Z", hull) + P("M20 16 L38 16 L38 36 L20 36 Z") + P("M18 12 L40 12 L40 16 L18 16 Z")
      + [44, 64, 84, 104, 124, 144, 164].map((x, i) => P(`M${x} ${i % 2 ? 24 : 22} L${x + 18} ${i % 2 ? 24 : 22} L${x + 18} 36 L${x} 36 Z`, i % 3 === 0 ? grey : i % 3 === 1 ? top : (dark ? "#c9a46a" : "#e2c8a0"))).join("")
      + wins(22, 34, 18, 5),
    // tanker: low, long, flat deck with a pipe run; the bridge aft
    tanker: P("M6 38 L194 36 L184 49 L14 49 Z", hull) + P("M18 20 L38 20 L38 38 L18 38 Z") + P("M16 16 L40 16 L40 20 L16 20 Z") + P("M44 35 L184 34 L184 36 L44 37 Z", grey) + P("M100 28 L104 28 L104 35 L100 35 Z", grey) + wins(20, 34, 23, 5),
    // tugboat: short, deep, a high wheelhouse forward, a fender at the bow
    tug: P("M56 38 L150 36 C150 44 146 49 136 49 L62 49 Z", hull) + P("M92 26 L130 26 L132 36 L90 37 Z") + P("M100 16 L126 16 L128 26 L98 26 Z") + P("M108 8 L112 8 L112 16 L108 16 Z", grey) + wins(102, 122, 19, 6, 4, 3)
      + `<circle cx="150" cy="40" r="3" fill="${grey}"/>`,
    // fishing boat: wheelhouse forward, a gantry and boom aft
    fishing: P("M40 38 L162 34 C160 44 154 49 144 49 L46 49 Z", hull) + P("M118 22 L146 22 L148 35 L116 36 Z") + wins(122, 140, 26, 6, 4, 3)
      + P("M60 14 L63 14 L63 37 L60 37 Z", grey) + `<path d="M62 14 L100 34" fill="none" stroke="${grey}" stroke-width="1.6"/>` + P("M48 30 L76 30 L76 37 L48 37 Z", grey),
    // Coast Guard / rescue / pilot boat: a sturdy patrol hull with a plain orange diagonal band, a wheelhouse with a mast
    gov: P("M36 40 L170 36 C166 45 158 49 148 49 L44 49 Z", hull) + `<path d="M118 37 L126 37 L118 49 L110 49 Z" fill="#e8742a" stroke="none"/>`
      + P("M84 26 L134 26 L142 37 L80 38 Z") + P("M96 18 L124 18 L128 26 L94 26 Z") + P("M108 8 L111 8 L111 18 L108 18 Z", grey) + wins(98, 122, 21, 6, 4, 3) + wins(86, 136, 30, 7, 4, 3),
    // motorboat / yacht
    pleasure: P("M48 40 L166 38 C160 46 152 49 142 49 L56 49 Z", hull) + P("M70 30 L128 30 L140 38 L66 39 Z") + P("M80 24 L116 24 L122 30 L78 30 Z") + wins(82, 132, 33, 7, 4, 2.4),
    // sailboat: hull, mast, mainsail and jib
    sail: P("M50 42 L160 42 C152 48 140 50 126 50 L66 50 Z", hull) + P("M98 4 L101 4 L101 42 L98 42 Z", grey)
      + P("M97 7 L97 40 L62 40 Z") + P("M102 8 L144 41 L102 41 Z"),
    // other / workboat
    other: P("M30 38 L170 38 L162 49 L38 49 Z", hull) + P("M108 24 L140 24 L142 38 L106 38 Z") + P("M50 30 L96 30 L96 38 L50 38 Z", grey) + wins(112, 134, 28, 6, 4, 3),
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 64" width="200" height="64"><g stroke="${line}" stroke-width="1" stroke-linejoin="round">${D[c.id] || D.other}</g>${water}</svg>`;
}
export const vesselProfileURI = (id, opts) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(vesselProfileSVG(id, opts))}`;
