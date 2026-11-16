// Personal names out of police news headlines (Open Places "Police News").
//
// One function, used in three places (defence in depth):
//   * the relay, workers/bct-relay/src/local.js (/local/police.json), imports it from here (wrangler bundles it);
//   * the snapshot pipeline, pipelines/local/build.py, runs it through node (pipelines/local/redact_names.mjs);
//   * the page, site/places/civic-mod-local.js, runs it again on whatever it reads.
//
//   redactHeadline(title) → title without the names of missing people, suspects, accused or victims.
//   e.g. "Sooke RCMP searching for 49 year old missing man, Nathan Head" → "Sooke RCMP searching for 49 year old missing man"
//        "John Smith charged with robbery"                                → "Person charged with robbery"
//        "Police seek help locating Jane Doe, 34"                         → "Police seek help locating a missing person, 34"
//        "Cst. Jane Doe honoured"                                         → "Cst. [name withheld] honoured"
//
// How: the headline is split into words; known places, streets, parks, agencies, vessels, days, months, events and
// ranks are marked first (allow-lists and suffix/prefix rules: "… Road", "… Park", "Mount …", "HMCS …"). What is left
// is checked for name-like runs of capitalised words:
//   * sentence-case headlines ("Man found deceased in Goldstream River"): two or more capitalised words in a row of which
//     at least one is not an everyday headline word;
//   * Title Case headlines ("Suspect Arrested Following Break and Enter"): capitals mean nothing there, so a name is two or
//     more words in a row that are not everyday headline words (a surname-like word such as Head or King may follow);
//   * one unknown capitalised word straight after a cue ("missing man, Nathan", "arrested Smith", "Cst. Smith").
// A name after a person noun ("missing man, Jane Doe") is dropped; elsewhere it becomes "Person" (headline start),
// "a person", "a missing person" (after locate/find/search for) or "[name withheld]" (after a rank or title).
// Errs on the side of masking: an unknown two-word place may read "a person"; add it to PROPER below.
// Pure, no DOM, no dependencies; works in browsers, Workers and node.

const W = (s) => new Set(s.trim().toLowerCase().split(/\s+/));

// everyday words that Title Case headlines capitalise (not names)
const VOCAB = W(`
a about above abuse access accident accidents accused achievement across act action actions active activity additional address adult adults advance advances advice advises advisory advisories
affected affordable after again against aggravated agencies agency agreement aid aimed air aircraft aircraftsystem alert alerts all alleged allegedly also always ambulance amid among an and animal animals
announce announces announced annual another anniversary anti any apartment appeal appeals approach approves are area areas arrest arrested arrests arson arts as assault assaulted assaults assist assistance
assisted at attack attempt attempted attempts attention auto available avenue avoid award awards awareness away back bad bail ban banned bans bear bears become begin begins behind being believed
best between beware bicycle bike bikes bird birds bit block blocked blocks board boat boats body bold bomb border both bowling box break breaks breaking brief bring brings broken brought building
buildings burglar burglaries burglary burn burned bus buses business businesses busy but by bylaw bystander bystanders call callers calls camera cameras camp campaign campfire can cancelled canine
car care cars carry case cases cash catalytic caught cause caused causes caution celebrate celebrates centre ceremonies ceremony chain chair challenge chamber change changes charge charged charges
check checks checkstop checkstops child children chooses citizen citizens city civic claims clean cleanup clear clearing close closed closes closure closures club clubs coast cold collect collection
collision collisions come comes coming commercial commitment common communities community complete completed concern concerned concerns concrete condition conditions confirm confirmed conflict connected
connection construction contact continue continues control convicted cost costs could council counter country court courts covid crash crashes create crew crews crime crimes criminal crisis cross
cruelty crowd culture curfew custody cut cyber cyclist cyclists damage damaged danger dangerous dash data date day days dead deadly deal death deaths deceased decision dedication deer delay delays
delivery department deployment deputy design designation despite detachment details detained detectives development dies difficult disruption disruptions distracted district do doctor dog dogs domestic
door doors down downtown drive driven driver drivers drives driving drone drones drop drug drugs drunk during each early east education effort efforts elder elderly emergency end ends enforcement
engagement enter enters environment era erratic escape escaped estate evacuation evacuations event events every evidence excessive expansion expected explosion extended extortion facility fail failed
failing fall false families family fatal fatality fatalities fees fentanyl few field file files final find finding fire firearm firearms fires fireworks first fleet flood flooding follow following
footage for force foreign forest found fraud frauds fraudulent free from front full funding further gang gas get getting give given glass go good government grand grant great green grow group
guard gun guns habitat half halloween hand handgun harassment harm hate hazard head headed health hearing heavy help helps here high highway highlights hiker hikers hit holiday holidays home homes
homicide honour honoured hospital host hour hours house housing human humanity identified identify identifies identifying illegal impaired impersonating important improve in incident incidents
include includes including incomplete increase increased individual individuals information initiative injured injuries injury innovative inquiry inside instead intersection interest into investigate
investigated investigates investigating investigation investigations invites involved involving is island issue issued issues it its jewellery joint june just keep key kids kill killed knife know known
label land landmark language large last late latest launch launches law laws lawn lead leads leak learn leave left legal less life lifetime light like line liquor list little live lives local located
locate locating location locked long look looking lost low lower made mail major make makes male man many market marathon march mark media meet meeting meetings member members memorandum memorial men
mental message mischief miss missing modernized month months more most motor motorcycle motorcyclist motorcyclists move multiple municipal murder must name named national near nearby need needed
needs negotiates neighbourhood network new news next night no non north not notice now number numbers occupied of off offence offences offender offenders office officer officers official officials
old on once one ongoing online only open opening opens operation operations or order other outcomes out outreach over overdose overnight owner owners pack park parking parkland part partial partnership
party passenger past patrol patrols pauses pedestrian pedestrians people person personal persons pet phone photo photos piloted place plan planned plans plate plates please point poisoning police pool
possible post power prevent prevention priority prison program project prohibited project property proposal protect public pursuit put question questions quick raise raises rally ransom re
reach ready reassures receives recent recognize recognized record recover recovered recovering red reduce reduction regarding region regional related release released releases relocating relocation
remain remains remember remembrance remind reminder reminders reminds remote remotely removal removed repeat report reported reports request rescue rescued residence residential resident residents
resolved respond responds response responding restricted result results return returned returns review rise risk road roads robbery robberies rock round rule rules run runs rural safe safely safety sale
scam scams scene school schools search searching season second secure secures security see seek seeking seeks seen seize seized seizure seizes senior seniors sentence sentenced series serious service services
set several sex sexual share shooting shop shoplifting short shortage shot show shows sign significant signs since single site slow small social some space speed speeding spray stabbing staff start
statement station steal step steps stolen stop stopped stoppers stops storm strategic strategy street streets strengthen strike student students suicide summer sunday support suspect suspected suspects
suspicious swimming system take takes taken targeted targeting team teen teenager teenagers teens temporary than thank thanks that the theft thefts their them they things this those threat threats
three through ticket tickets time tips to today tool top tour town towards tracker traffic trafficking trail trails training transit trial truck trucks two under understanding unit university update
updated updates urge urged urges use used utility vandalism vehicle vehicles victim victims video violence violent visit voluntary volunteer volunteers waiting walk wanted war warming warn warning warnings
warrant warrants was waste watch water way weapon weapons week weekend weekly welcome well wellness were west what when where which while white who wildlife will window winter with witness
witnesses woman women work workers world wrong yard year years you young youth youths zone
sought grandparent grandparents romance rental crypto bitcoin cryptocurrency investment tax phishing imposter impostor employment lottery prize gift card cards text texts email emails
centennial heritage veterans provincial ecological reserve athletic legion lions rotary kinsmen gyro skate splash dog off-leash leash playground spray wading beachfront waterfront seawall
vandalized vandalised graffiti standoff barricaded lockdown shelter-in-place hold evacuate evacuated medical overdoses naloxone opioid toxic drowning drowned overturned rollover head-on
hit-and-run pursuit stolen-vehicle tow towed impound impounded roadside prohibition prohibitions speeders racing street-racing stunt excessive-speed seatbelt cellphone distracted-driving
counterfeit forged forgery identity theft-ritual porch pirates pirate parcel parcels package packages mail-theft trespass trespassing assaulting threatening uttering harassing stalking
breach breaches probation parole conditions released-on remand bail-hearing custody court-date appearance appear sentencing guilty plea pleads pleaded acquitted stay stayed jury verdict
homicide manslaughter murder murdered body found remains skeletal coroner autopsy suspicious non-suspicious unsuspicious death investigation
cougar cougars wolves deer elk raccoons coyote coyotes orca orcas whale whales seal sea lion otters eagle eagles owl owls snake
prolific spree wanted-person hosts host hosted hosting coffee cop cops tea breakfast lunch dinner bbq barbecue pancake food drive toy toys coat coats sock socks blanket
swiss army rabid bat bats knife knives machete axe hammer bat-wielding baseball replica pellet airsoft bb crossbow taser pepper spray bear-spray firework explosive device suspicious-package package
loaded shotgun rifle ammunition ammo magazine prohibited-weapon brass knuckles weapons-call call-out callout tactical emergency-response erT response-team crisis negotiator canine-unit police-dog
helicopter drone rpas boat-patrol marine unit bike-patrol foot patrol mounted school-zone crosswalk intersection signal lights light red-light speed-watch speedwatch radar laser checkpoint
tire tires winter-tires chains snow ice black-ice fog wind windstorm rain heavy-rain flooding washout landslide mudslide rockslide sinkhole power-outage outage outages downed wires lines hydro
gas-leak leak smell odour smoke smoky haze heat heatwave extreme cold-weather warming-centre cooling centre centres shelter shelters housing encampment encampments tent tents unhoused homeless homelessness
sweep sweeps cleanup clean-up litter garbage dumping illegal-dumping recycling compost bin bins bear-aware aware awareness fair fairs show market markets craft holiday-market farmers farmer
struck strikes striking hits hitting ran running walked walking jogging jogger biking kayak kayaker kayakers paddler paddlers boater boaters swimmer swimmers surfer surfers diver divers climber climbers
seriously critically fatally minor major-injuries life-threatening non-life-threatening stable condition hospitalized airlifted transported treated released charged-with facing faces face
remain remains remained scene scenes stayed fled flee fleeing escaped chased chase apprehended apprehend detained custody in-custody released-from wanted-on province-wide canada-wide nationwide
approved approve laid lay layed recommend recommended crown counsel prosecutor prosecution charges-approved forwarded report-to
grizzly grizzlies black-bear cub cubs sighting sightings encounter encounters attack attacked bite bitten bites
help helping helped thank thanking appreciation volunteer-of recognition medal medals honoured honouring bravery commendation commendations ceremony ceremonies graduation graduates recruit recruits
recruiting hiring career careers job jobs applications apply applicants new-officers swearing-in sworn retire retires retired retirement farewell welcome welcomes welcomed joins joined appointed appointment
announces announced announcement named-new new-chief interim acting deputy-chief inspector-general
grand opening reopening re-opening ribbon cutting open-house open house anniversary celebration festival parade fireworks lantern pumpkin costume trick-or-treat trick treat
`);
// common words that are also frequent surnames: may follow an unknown first name ("Nathan Head", "Ana King")
const SURNAMEISH = W(`head king black white brown green young wood hill stone bell hall long little cook baker day love page fox wolf lane bird price rice rose field marsh ford hunt hunter parker mason
porter walker turner carter miller fisher taylor cooper ward wells west north south east knight bishop church banks mills waters rivers brook brooks bush gill grant hope hart may moon power reid shore
small strong sharp swift wise winter summer spring frost storm lake park pool steel gold silver cross fair noble chase dean grace joy`);
// common words (and places) that are also given names: may lead an unknown surname ("Will Smith", "Victoria Lee")
const GIVENISH = W(`will mark bill bob rose grace hope june april may august faith joy summer dawn robin jack frank art pat sue ray guy drew chase hunter mason victoria sidney jordan shirley florence duncan
gordon douglas carey victor sunny holly ivy iris amber crystal heather hazel jade ruby pearl angel autumn destiny harmony melody misty sky storm brook brooke earl major king prince rich chip ace`);
// rank or title words: a name right after becomes "[name withheld]"
const RANKS = W(`cst. const. constable sgt. sergeant s/sgt. cpl. corporal insp. inspector supt. superintendent chief det. detective officer mayor councillor coun. premier minister mp mla dr. mr. mrs. ms. mx.
judge justice sheriff staff deputy commissioner reverend rev. pastor father sister brother captain capt. lt. lieutenant`);
// person nouns: a name right after one ("missing man, Jane Doe") is dropped
const PERSON = W(`man men woman women person persons people teen teens teenager teenagers boy boys girl girls youth youths senior seniors male males female females adult adults child children kid suspect
suspects driver drivers victim victims resident residents individual individuals cyclist pedestrian motorcyclist hiker hikers mother father son daughter grandmother grandfather husband wife
brother sister student worker accused offender offenders inmate fugitive missing member members
resident tenant tenants owner neighbour neighbor friend partner employee customer passenger patient kayaker paddler boater swimmer jogger climber diver surfer skier
snowboarder hiker camper fisher fisherman`);
// words before a name that mark it as a person even when it's a single word ("arrested Smith", "missing man Nathan")
const CUE = W(`arrest arrests arrested charge charges charged against locate locating located find finding found identify identifies identified named seek seeks seeking sought warrant victim accused
suspect convicted sentenced search searching looking`);
const LOCATE = W(`locate locating find finding search searching looking`);
const ARTICLE = W(`a an the`);
// tokens that keep the abbreviation dot
const ABBR = W(`cst const sgt s/sgt cpl insp supt det dr mr mrs ms mx st mt ft pt jr sr rev capt lt coun no hwy ave rd blvd jan feb mar apr aug sept sep oct nov dec mon tue tues wed thu thurs fri sat sun m.v`);
const DAYS = W(`monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thurs fri sat sun january february march april may june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec christmas halloween thanksgiving easter hanukkah diwali ramadan`);

// places, agencies, events and other proper names that look like personal names (lowercase, ' for ’), comma-separated
const PROPER = `
langford, colwood, view royal, metchosin, highlands, sooke, saanich, north saanich, central saanich, oak bay, esquimalt, victoria, sidney, juan de fuca, goldstream, malahat,
shawnigan, shawnigan lake, duncan, cowichan, cowichan valley, nanaimo, ladysmith, chemainus, mill bay, cobble hill, parksville, courtenay, comox, campbell river, port alberni, tofino,
ucluelet, vancouver, vancouver island, salt spring, salt spring island, gulf islands, pender island, mayne island, galiano, saturna, gabriola, westshore, west shore, royal bay,
royal roads, bear mountain, millstream, happy valley, mill hill, mount work, mount douglas, mount doug, mount tolmie, mount wells, mount finlayson, beacon hill, beacon hill park,
cordova bay, gordon head, james bay, fairfield, fernwood, rockland, oaklands, gonzales, hillside, quadra, tillicum, uptown, burnside, gorge, vic west, songhees, lekwungen, tsawout,
tsartlip, pauquachin, tseycum, t'sou-ke, scia'new, sc'ianew, pacheedaht, beecher bay, port renfrew, jordan river, east sooke, otter point, willis point, brentwood bay, saanichton,
swartz bay, deep cove, dean park, ardmore, cadboro bay, ten mile point, lochside, galloping goose, pat bay, elk lake, beaver lake, thetis lake, prospect lake, durrance, island view,
matticks farm, hatley park, glen lake, florence lake, langford lake, westhills, latoria, esquimalt lagoon, hartland, western communities, greater victoria, capital regional district,
british columbia, canada, washington, seattle, port angeles, alberta, ontario, quebec, salish sea, haro strait, strait of georgia, fisgard, fort rodd hill, sooke hills, sooke potholes,
mystic beach, french beach, china beach, botanical beach, whiffin spit, witty's lagoon, francis king, spectacle lake, niagara falls, niagara canyon, skirt mountain, bamberton,
ogden point, clover point, macaulay point, saxe point, willows beach, gonzales beach, island view beach, topaz park, royal athletic park, matheson lake,
roche cove, lone tree hill, mount macdonald, gorge park, cecelia ravine, centennial park, veterans memorial park, city centre park, starlight stadium, ed nixon,
douglas, yates, pandora, johnson, blanshard, mckenzie, helmcken, shelbourne, craigflower, admirals, jacklin, peatt, wishart, interurban, blenkinsop, finlayson, menzies, belleville,
wharf, government, fort street, cook street, queens avenue,
rcmp, vicpd, west shore rcmp, sooke rcmp, sidney north saanich rcmp, bc rcmp, saanich police, oak bay police, victoria police, central saanich police, esquimalt division,
integrated major crime unit, ihit, icars, cfseu, crime stoppers, greater victoria crime stoppers, bc coroners service, coroners service, bc highway patrol,
independent investigations office, iio, bc ambulance, bcehs, coast guard, canadian coast guard, search and rescue, juan de fuca search and rescue, bc transit, bc ferries, icbc,
transport canada, dnd, cfb esquimalt, royal canadian navy, canadian armed forces, island health, worksafebc, bc hydro, bc wildfire service, bc parks, parks canada,
environment canada, crd parks, crd,
tour de rock, cops for cancer, royal victoria marathon, remembrance day, canada day, boxing day, new year's, family day, labour day, victoria day, mother's day, father's day,
pink shirt day, truth and reconciliation, national day for truth and reconciliation, wicked victoria, christmas eve, new year's eve, tri-city,
first nation, first nations, esquimalt nation, songhees nation, malahat nation,
victoria grizzlies, victoria royals, victoria harbourcats, victoria shamrocks, pacific fc, bchl, whl,
harris green, north park, burnside gorge, jubilee, south jubilee, quadra village, cook street village, chinatown, old town, dockside, humboldt valley, royal oak, broadmead, cedar hill,
marigold, glanford, strawberry vale, uplands, south oak bay, henderson, estevan, willows, colquitz, luxton, triangle mountain, olympic view, thetis heights, walfred, kettle creek,
eagle ridge, langford proper, south langford, city centre, westshore town centre, uptown centre, mayfair, hillside centre, tillicum centre, millstream village, eagle creek
`.split(",").map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);
const PHRASE_SET = new Map();   // first word → phrases (as word arrays), longest first
for (const p of PROPER) {
  const ws = p.split(" ");
  if (!PHRASE_SET.has(ws[0])) PHRASE_SET.set(ws[0], []);
  PHRASE_SET.get(ws[0]).push(ws);
}
for (const a of PHRASE_SET.values()) a.sort((x, y) => y.length - x.length);
const ONE_WORD = new Set(PROPER.filter((p) => !p.includes(" ")));

// a capitalised word followed by one of these names a place or organisation ("Sooke Road", "Lawn Bowling Club")
const SUFFIX = W(`road rd street st avenue ave drive boulevard blvd highway hwy parkway pkwy crescent cres way place court terrace trail close row square path river creek lake bay beach mountain mtn
hills island islands inlet harbour harbor cove point falls canyon valley ridge peninsula marina wharf pier mall centre center plaza school elementary secondary middle academy college university
hospital arena library station terminal club church stadium market village society association foundation department unit team services service ministry office council committee
corporation inc ltd group network program initiative agency detachment branch section squad commission board authority coalition league institute nation nations regional district reserve
trailhead campground estates heights gardens commons crossing junction interchange overpass exchange spit lagoon strait passage channel sound reach memorial park hill lane hall field wood
marsh brook ford bridge`);
// suffixes that are also common surnames: a place only when what comes before isn't name-like ("Beacon Hill" yes, "Jane Hill" no)
const AMBIG_SUFFIX = W(`park hill lane hall field wood marsh brook ford bridge way close cross`);
// a word before capitalised words that makes them a place or a vessel ("Mount Work", "HMCS Winnipeg")
const PREFIX = W(`mount mt. port fort ft. saint st. cape lake point hmcs hms mv m.v. ccgs uss fv`);
const PARTICLE = W(`de da del della di du la le van von der den bin ibn al el st.`);

const norm = (s) => s.toLowerCase().replace(/[’‘]/g, "'");
const base = (s) => norm(s).replace(/'s$/, "");
const isCap = (s) => /^\p{Lu}/u.test(s);
const isAcronym = (s) => /^\p{Lu}{2,}(?:'s|’s)?$/u.test(s) || /^(?:\p{Lu}\.){2,}$/u.test(s);
const isInitial = (s) => /^\p{Lu}\.$/u.test(s);
const known = (w) => VOCAB.has(w) || DAYS.has(w) || w.split("-").every((p) => VOCAB.has(p) || /^\d+$/.test(p));

/** split into word, nickname ("Johnny" / (Bobby)) and punctuation tokens with their positions */
function tokenize(s) {
  const out = [], re = /(["“‘(]\p{Lu}[^"”’)]{0,24}["”’)])|([\p{L}\p{N}][\p{L}\p{M}\p{N}'’\-]*)|(\S)/gu;
  let m;
  while ((m = re.exec(s))) {
    let t = m[0], end = m.index + t.length;
    if (m[2] && s[end] === "." && (ABBR.has(norm(t)) || /^\p{Lu}$/u.test(t))) { t += "."; end++; re.lastIndex = end; }
    out.push({ t, a: m.index, b: end, k: m[1] ? "nick" : m[2] ? "w" : "p" });
  }
  return out;
}

/** the redacted headline (see the file header). Never throws: if something unexpected happens it fails closed. */
export function redactHeadline(title) {
  try { return redact(String(title || "")); } catch { return "Police news release (open it for details)"; }
}
function redact(s) {
  if (!s) return s;
  const T = tokenize(s);
  if (!T.length) return s;
  const joined = (i) => i > 0 && i < T.length && /^\s+$/.test(s.slice(T[i - 1].b, T[i].a));   // token i follows i-1 with only spaces between
  const words = T.filter((x) => x.k === "w");
  // Title Case: most longer words after the first start with a capital
  const long = words.slice(1).filter((x) => x.t.length >= 4 && /^\p{L}/u.test(x.t));
  const tc = long.length >= 3 && long.filter((x) => isCap(x.t)).length / long.length >= 0.7;

  // 1. mark allowed tokens: phrases, acronyms, days/months, ranks, prefix/suffix places
  const A = new Array(T.length).fill(false);
  for (let i = 0; i < T.length; i++) {
    if (T[i].k !== "w") continue;
    const cands = PHRASE_SET.get(base(T[i].t));
    if (cands) for (const ws of cands) {
      let j = i, k = 0;
      while (k < ws.length && j < T.length && T[j].k === "w" && (k === ws.length - 1 ? base(T[j].t) : norm(T[j].t)) === ws[k] && (k === 0 || joined(j))) { j++; k++; }
      if (k === ws.length) {
        // a one-word place next to an unknown capitalised word is probably a surname or given name ("Ann Johnson", "Douglas Smith")
        const loose = (x) => T[x]?.k === "w" && isCap(T[x].t) && !isAcronym(T[x].t) && !known(base(T[x].t)) && !PHRASE_SET.has(base(T[x].t));
        if (ws.length === 1 && ((i > 0 && joined(i) && loose(i - 1)) || (joined(i + 1) && loose(i + 1)))) break;
        for (let x = i; x < j; x++) A[x] = true; break;
      }
    }
    const w = base(T[i].t);
    if (isAcronym(T[i].t) || /^[\p{Lu}][\p{Ll}]*\p{Lu}{2,}/u.test(T[i].t) && !/^(Mc|Mac|O'|D')/.test(T[i].t)) A[i] = true;   // RCMP, VicPD, BCHL
    if (DAYS.has(w) && !(GIVENISH.has(w) && T[i + 1]?.k === "w" && isCap(T[i + 1].t) && !known(base(T[i + 1].t)) && joined(i + 1))) A[i] = true;
    if (/^\d/.test(T[i].t)) A[i] = true;
  }
  const rank = (i) => T[i]?.k === "w" && RANKS.has(norm(T[i].t));
  for (let i = 0; i < T.length; i++) {
    if (T[i].k !== "w") continue;
    const w = norm(T[i].t);
    // "Mount Work", "HMCS Winnipeg", "St. Ann's"
    if (PREFIX.has(w) && isCap(T[i].t) && T[i + 1]?.k === "w" && isCap(T[i + 1].t) && joined(i + 1) && !(w === "st." && i > 0 && isCap(T[i - 1].t) && joined(i))) {
      A[i] = true; let j = i + 1; while (j < T.length && j <= i + 3 && T[j].k === "w" && isCap(T[j].t) && joined(j)) A[j++] = true;
    }
    // "Sooke Road", "West Saanich Road", "Lawn Bowling Club" (up to 3 capitalised words before the suffix)
    if (SUFFIX.has(base(T[i].t)) && isCap(T[i].t)) {
      let j = i; const before = [];
      while (j > 0 && i - j < 3 && T[j - 1].k === "w" && (isCap(T[j - 1].t) || PARTICLE.has(norm(T[j - 1].t))) && joined(j) && !rank(j - 1)) { j--; before.push(j); }
      if (!before.length) { A[i] = true; continue; }
      const nameLike = before.some((x) => !A[x] && !known(base(T[x].t)));
      if (AMBIG_SUFFIX.has(base(T[i].t)) && nameLike) continue;   // "Jane Hill": leave to the name check
      for (let x = j; x <= i; x++) A[x] = true;
    }
  }

  // 2. runs of capitalised words that aren't allowed; each name-like stretch becomes a span to replace
  const spans = [];
  const capW = (i) => T[i]?.k === "w" && isCap(T[i].t) && !A[i] && !rank(i);
  const nameTok = (i) => capW(i) && !known(base(T[i].t));                 // unknown capitalised word
  for (let i = 0; i < T.length; i++) {
    if (!capW(i)) continue;
    // the run: capitalised words, plus particles / initials / nicknames between them, joined by spaces only
    let j = i;
    const ok = (x) => joined(x) && (capW(x) || isInitial(T[x].t) && !A[x] || ((T[x].k === "nick" || PARTICLE.has(norm(T[x].t))) && capW(x + 1) && joined(x + 1)));
    while (j + 1 < T.length && ok(j + 1)) j++;
    const run = []; for (let x = i; x <= j; x++) run.push(x);
    i = j;
    const head = run[0] === T.findIndex((x) => x.k === "w") || (run[0] > 0 && /^[:–—-]$/.test(T[run[0] - 1].t));   // starts the headline
    const glue = (x) => T[x].k === "nick" || isInitial(T[x].t) || PARTICLE.has(norm(T[x].t)) && !isCap(T[x].t);
    if (!tc) {
      // sentence case: capitals are meaningful except on the first word
      let r = run.slice();
      if (head) while (r.length && known(base(T[r[0]].t)) && !(GIVENISH.has(base(T[r[0]].t)) && r[1] != null && nameTok(r[1]))) r.shift();
      const core = r.filter((x) => !glue(x));
      const allKnownPair = core.length >= 2 && GIVENISH.has(base(T[core[0]].t)) && core.slice(1).every((x) => SURNAMEISH.has(base(T[x].t)));
      if (core.length >= 2 && (core.some(nameTok) || allKnownPair)) spans.push(r);
      else if (core.length === 1 && nameTok(core[0]) && cueBefore(T, core[0], A)) spans.push(r);
    } else {
      // Title Case: split at everyday words, except a surname-like word after a name, or a given-name word before one
      let cur = [];
      const flush = () => {
        const core = cur.filter((x) => !glue(x));
        if (core.length >= 2 && core.some(nameTok)) spans.push(cur);
        else if (core.length === 1 && nameTok(core[0]) && cueBefore(T, core[0], A, true)) spans.push(cur);
        cur = [];
      };
      for (let k = 0; k < run.length; k++) {
        const x = run[k], w = base(T[x].t), prev = cur.filter((y) => !glue(y)).at(-1);
        if (glue(x)) { if (cur.length) cur.push(x); continue; }
        if (nameTok(x)) { cur.push(x); continue; }
        if (prev != null && nameTok(prev) && SURNAMEISH.has(w)) { cur.push(x); continue; }
        if (GIVENISH.has(w) && run[k + 1] != null && nameTok(run[k + 1])) { flush(); cur.push(x); continue; }
        flush();
      }
      flush();
    }
  }
  // a single unknown word right after a rank ("Cst. Smith")
  for (let i = 1; i < T.length; i++) if (rank(i - 1) && nameTok(i) && joined(i) && !spans.some((sp) => sp.includes(i))) spans.push([i]);
  if (!spans.length) return s;

  // 3. replace, right to left
  let out = s;
  const hasSuspect = /\b(suspect|wanted|arrest|charged|accused)/i.test(s);
  for (const sp of spans.sort((p, q) => q[0] - p[0])) {
    const i0 = sp[0], i1 = sp.at(-1);
    let a = T[i0].a, b = T[i1].b, rep;
    const poss = /['’]s$/.test(T[i1].t);
    let p = i0 - 1; if (T[p]?.t === ",") p--;
    const prevW = T[p]?.k === "w" ? norm(T[p].t) : null;
    const atHead = i0 === T.findIndex((x) => x.k === "w") || (i0 > 0 && /^[:–—-]$/.test(T[i0 - 1].t));
    if (rank(i0 - 1)) rep = "[name withheld]" + (poss ? "’s" : "");
    else if (prevW && PERSON.has(prevW) && !poss) { rep = ""; a = T[i0 - 1].t === "," ? T[i0 - 1].a : a; }
    else if (atHead) rep = poss ? "A person’s" : "Person";
    else if (prevW && ARTICLE.has(prevW)) rep = poss ? "person’s" : "person";
    else if (prevW && LOCATE.has(prevW) && !hasSuspect && !poss) rep = "a missing person";
    else rep = poss ? "a person’s" : "a person";
    // a Title Case headline keeps its style: "Police Arrest a Person Following Pursuit"
    if (tc && rep && rep !== "[name withheld]") rep = rep.replace(/\b(person|missing)\b/g, (w) => w[0].toUpperCase() + w.slice(1));
    out = out.slice(0, a) + rep + out.slice(b);
  }
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.:;!?)])/g, "$1").replace(/,\s*,/g, ",").replace(/^[\s,]+|[\s,]+$/g, "").replace(/\(\s*\)/g, "").trim();
}

/** is there a cue word just before token i (skipping a comma and age/number words)? */
function cueBefore(T, i, A, strict = false) {
  let comma = false;
  for (let p = i - 1, n = 0; p >= 0 && n < 3; p--) {
    const t = T[p];
    if (t.k === "p") { if (t.t === ",") { comma = true; continue; } return false; }
    if (t.k !== "w") return false;
    const w = norm(t.t);
    // in Title Case "Driver Sought" is just two headline words: a person noun counts only with a comma ("Man, Nathan")
    // and a cue verb is ignored ("Arrests Prolific Offender"): only a rank or "Man, Nathan" counts there
    if ((CUE.has(w) && !strict) || RANKS.has(w) || (PERSON.has(w) && (!strict || comma))) return true;
    if (/^\d/.test(w) || /year-old|years?|old/.test(w)) { n++; continue; }
    return false;
  }
  return false;
}

/** redact the title of every item in place-safe copies: [{ title, … }] → [{ title: redacted, … }] */
export const redactItems = (items) => (items || []).map((x) => ({ ...x, title: redactHeadline(x.title) }));
export const NAMES_NOTE = "Names are omitted; open the release for details.";
