#!/usr/bin/env node
// fetch_events.js — Runs server-side in GitHub Actions (no CORS issues).
// Fetches Toronto events from city APIs and writes toronto_events.json.

const fs = require('fs');
const fetch = require('node-fetch');

const OUT_FILE = 'toronto_events.json';

const NPS_URL = "https://www.toronto.ca/services-payments/venues-facilities-bookings/booking-city-facilities/city-squares/nathan-phillips-square/events-happening-on-nathan-phillips-square/";
const CKAN_URL = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=festivals-events";

// The festivals-events dataset's underlying feed (secure.toronto.ca) has been
// Akamai-blocked (403) since ~2026-06-14, and the CKAN-hosted "backup" resource
// just serves a stale cached copy of that same error page. Every URL the
// dataset publishes leads to the same dead host — confirmed 2026-09-01.
// Disabled here rather than removed so it's a one-line flip if Toronto ever
// fixes it; no need to re-derive any of the parsing logic below.
const FESTIVALS_ENABLED = false;

const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };

// --- Ticketmaster (concerts + sports schedules) ---------------------------
// Only schedule/venue data is fetched here, once a day. Live ticket prices are
// deliberately NOT stored: they go stale in minutes, so the client fetches them
// per-view through the Cloudflare Worker in worker/.
const TM_KEY = process.env.TICKETMASTER_API_KEY || null;
const TM_ROOT = "https://app.ticketmaster.com/discovery/v2";

// Music *segment* id. Deliberately not classificationName=Music: that matches
// the name of any segment/genre/subgenre, and the Film segment contains a genre
// also called "Music", which would drag film screenings into the concerts card.
const MUSIC_SEGMENT_ID = "KZFzniwnSyZfZ7v7nJ";

// Geohash of downtown Toronto (43.6532,-79.3832 to within ~56m) plus a radius,
// used instead of dmaId=527. The DMA is wrong in both directions: it returned
// events in Thunder Bay, Windsor and London, while *missing* 63 Toronto events
// that this radius query finds (84 vs 147 in the same window). Filtering at the
// source also means no post-hoc geographic filter is needed anywhere else.
// 60km reaches the wider Golden Horseshoe: the GTA plus Hamilton (59km),
// Oshawa and St Catharines. Drop to 40 to keep it to the GTA proper.
const TORONTO_GEOPOINT = "dpz83df";
const TORONTO_RADIUS_KM = "60";

// Arena/stadium tier — these get priority in the concerts card. Ids are pinned
// rather than resolved by keyword, because keyword lookup is ambiguous in three
// different ways that no single matching rule handles:
//   - Rogers Stadium has two legitimate ids (Toronto + a North York alias), so
//     matching one would miss events filed under the other.
//   - "Rogers Centre" also matches two "Parliament Foyer, Rogers Centre"
//     venues in Ottawa.
//   - Budweiser Stage matches nothing by name any more; it is now RBC
//     Amphitheatre, and "Lake House at Budweiser Stage" is a separate venue.
// Comments note approximate concert capacity, descending.
const MAJOR_VENUE_IDS = {
    "KovZ917ARzt":  "Rogers Stadium",      // ~50k
    "Z7r9jZaAV6":   "Rogers Stadium",      // ~50k, alias listing
    "KovZpa3Bbe":   "Rogers Centre",       // ~40-50k
    "KovZpZAE77aA": "BMO Field",           // ~28k
    "KovZpZAFFE1A": "Scotiabank Arena",    // ~19.8k
    "KovZpZAEkkIA": "RBC Amphitheatre",    // ~16k, formerly Budweiser Stage
    "KovZpZAJt7FA": "Coca-Cola Coliseum",  // ~8k
};

// Pinned for the same reason: keyword search also returns "Toronto Blue Jays
// (SS)" (spring training), "Toronto Maple Leafs Alumni", fan fests and
// "OLG Play Stage Presents ..." entries.
const TEAMS = [
    { key: "jays",    attractionId: "K8vZ91718W0", name: "Toronto Blue Jays" },
    { key: "leafs",   attractionId: "K8vZ9171o80", name: "Toronto Maple Leafs" },
    { key: "raptors", attractionId: "K8vZ9171KC0", name: "Toronto Raptors" },
];

// How far ahead to look. Combined with sort=date,asc&size=200 this is just a
// safety bound — the soonest 200 events always cover "today" and "next up",
// which is all the client ever displays, so no pagination is needed.
const TM_WINDOW_DAYS = 14;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Public tier allows 5 requests/sec. The concerts and sports fetchers run
// concurrently, so per-fetcher spacing isn't enough — they would collectively
// burst past the limit and earn a 429. Every Ticketmaster call is therefore
// serialized through this one chain, which guarantees the spacing globally no
// matter how many callers there are.
const TM_SPACING_MS = 250;
let tmChain = Promise.resolve();

function tmGate() {
    const turn = tmChain.then(() => sleep(TM_SPACING_MS));
    // Swallow errors so one failed call can't poison the queue for the rest.
    tmChain = turn.catch(() => {});
    return turn;
}

async function tmGet(path, params, { retryOn429 = true } = {}) {
    await tmGate();

    const qs = new URLSearchParams({ ...params, apikey: TM_KEY });
    const res = await fetch(`${TM_ROOT}${path}?${qs}`, {
        headers: { 'User-Agent': 'HowFar-DataFetcher/1.0 (GitHub Actions)' },
        timeout: 20000,
    });

    if (res.status === 429 && retryOn429) {
        console.warn(`  rate limited on ${path}, backing off 2s`);
        await sleep(2000);
        return tmGet(path, params, { retryOn429: false });
    }
    if (!res.ok) {
        throw new Error(`Ticketmaster ${path} returned ${res.status}`);
    }
    return res.json();
}

function tmWindow() {
    const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    const now = new Date();
    // End of the final day, not the same clock time N days out: an evening show
    // on the last day would otherwise fall just outside the window and vanish.
    const end = new Date(now.getTime() + TM_WINDOW_DAYS * 86400000);
    end.setUTCHours(23, 59, 59, 0);
    return { startDateTime: fmt(now), endDateTime: fmt(end) };
}

// Flattens a Discovery API event into just what the cards need.
function mapEvent(ev, extra = {}) {
    const venue = ev._embedded?.venues?.[0];
    const lat = parseFloat(venue?.location?.latitude);
    const lon = parseFloat(venue?.location?.longitude);
    if (!isFinite(lat) || !isFinite(lon)) return null;

    const start = ev.dates?.start || {};
    // dateTime is absolute UTC and is absent when the time is TBA.
    const startUtc = start.dateTime || null;
    const timeTBA = Boolean(start.timeTBA || start.noSpecificTime || !startUtc);
    if (!start.localDate) return null;

    return {
        id: ev.id,
        name: ev.name,
        venueName: venue?.name || "Venue TBA",
        lat, lon,
        localDate: start.localDate,
        startUtc,
        timeTBA,
        url: ev.url || null,
        ...extra,
    };
}

function dedupeById(events) {
    const seen = new Map();
    for (const e of events) if (e && !seen.has(e.id)) seen.set(e.id, e);
    return [...seen.values()];
}

async function fetchConcerts() {
    if (!TM_KEY) {
        console.log("Concerts skipped: TICKETMASTER_API_KEY not set.");
        return null;
    }

    try {
        const window = tmWindow();
        const base = {
            ...window,
            segmentId: MUSIC_SEGMENT_ID,
            sort: "date,asc",
            size: "200",
        };

        const collected = [];

        // Tier A: query each arena directly. Done separately rather than
        // filtering the city-wide result so a busy week of small-venue shows
        // can never push an arena date off the single page we fetch.
        for (const [venueId, venueLabel] of Object.entries(MAJOR_VENUE_IDS)) {
            const body = await tmGet("/events.json", { ...base, venueId });
            const events = body?._embedded?.events ?? [];
            console.log(`  ${venueLabel} (${venueId}): ${events.length} events`);
            for (const ev of events) {
                const mapped = mapEvent(ev, { isMajorVenue: true });
                if (mapped) collected.push(mapped);
            }
        }

        // Tier B: everything else within range of the city.
        const cityBody = await tmGet("/events.json", {
            ...base,
            geoPoint: TORONTO_GEOPOINT,
            radius: TORONTO_RADIUS_KM,
            unit: "km",
        });
        const cityEvents = cityBody?._embedded?.events ?? [];
        console.log(`  Toronto-wide: ${cityEvents.length} events`);
        // Tagged by venue id, not name: venues get renamed (Budweiser Stage is
        // "RBC Amphitheatre" as of 2026) and a name comparison would silently
        // stop recognising them as major.
        const majorIds = new Set(Object.keys(MAJOR_VENUE_IDS));
        for (const ev of cityEvents) {
            const mapped = mapEvent(ev, {
                isMajorVenue: majorIds.has(ev._embedded?.venues?.[0]?.id),
            });
            if (mapped) collected.push(mapped);
        }

        const concerts = dedupeById(collected).sort((a, b) =>
            (a.startUtc || a.localDate).localeCompare(b.startUtc || b.localDate));

        console.log(`Concerts: ${concerts.length} unique events`);
        return concerts;
    } catch (e) {
        console.warn("Concerts fetch failed:", e.message);
        return null;
    }
}

async function fetchSports() {
    if (!TM_KEY) {
        console.log("Sports skipped: TICKETMASTER_API_KEY not set.");
        return null;
    }

    try {
        const window = tmWindow();
        const collected = [];

        for (const team of TEAMS) {
            // The radius pins this to Toronto-area fixtures, i.e. home games.
            // Without a location constraint the API returns away games too and
            // the card would point at an arena in another country.
            const body = await tmGet("/events.json", {
                ...window,
                attractionId: team.attractionId,
                geoPoint: TORONTO_GEOPOINT,
                radius: TORONTO_RADIUS_KM,
                unit: "km",
                sort: "date,asc",
                size: "200",
            });
            const events = body?._embedded?.events ?? [];
            console.log(`  ${team.name}: ${events.length} home events`);
            for (const ev of events) {
                const mapped = mapEvent(ev, { team: team.key });
                if (mapped) collected.push(mapped);
            }
        }

        const sports = dedupeById(collected).sort((a, b) =>
            (a.startUtc || a.localDate).localeCompare(b.startUtc || b.localDate));

        console.log(`Sports: ${sports.length} unique home games`);
        return sports;
    } catch (e) {
        console.warn("Sports fetch failed:", e.message);
        return null;
    }
}

async function fetchNpsEvents() {
    const events = [];

    try {
        console.log("Fetching NPS events page...");
        const res = await fetch(NPS_URL, {
            headers: { 'User-Agent': 'HowFar-DataFetcher/1.0 (GitHub Actions)' },
            redirect: 'follow',
            timeout: 15000
        });
        if (!res.ok) {
            console.warn(`NPS page returned ${res.status}`);
            return null;
        }
        const html = await res.text();

        const thisYear = new Date().getFullYear();

        // Matches every date-prefix format actually seen on the page:
        //   "Month Day: "                       -> Jan 4: New Year's Skate Party
        //   "Month Day to Day: "                 -> Jan 1 to 7: Cavalcade of Lights
        //   "Month Day-Day: "                    -> November 6-7: All Charity Fest
        //   "Month Day to Month Day: "           -> Sept 26 to October 1: Indigenous Legacy Gathering
        //   "Month Day (Note): "                 -> Sept 7 (Labour Day): Labour Day Event
        // Groups: 1=month, 2=day, 3=hyphen end day (same month),
        //         4=second month (cross-month "to"), 5=end day (either "to" form)
        const pattern = /([A-Z][a-z]+)\s+(\d+)(?:\s*[-\u2013]\s*(\d+)|\s+to\s+(?:([A-Z][a-z]+)\s+)?(\d+))?\s*(?:\([^)]*\))?\s*:\s*<a[^>]*>([^<]+)<\/a>/gi;
        let match;
        while ((match = pattern.exec(html)) !== null) {
            const startMonthNum = MONTHS[match[1].toLowerCase()];
            if (!startMonthNum) continue;
            const startDay = parseInt(match[2]);

            let endMonthNum = startMonthNum;
            let endDay = startDay;
            if (match[3]) {
                endDay = parseInt(match[3]); // "Day-Day", same month
            } else if (match[5]) {
                endDay = parseInt(match[5]); // "to Day" or "to Month Day"
                if (match[4]) {
                    const m = MONTHS[match[4].toLowerCase()];
                    if (m) endMonthNum = m;
                }
            }

            const name = match[6].trim();
            // Handle a range spanning a year boundary (e.g. Dec -> Jan).
            const endYear = endMonthNum < startMonthNum ? thisYear + 1 : thisYear;
            const mmStart = String(startMonthNum).padStart(2, '0');
            const mmEnd = String(endMonthNum).padStart(2, '0');
            events.push({
                name,
                start: `${thisYear}-${mmStart}-${String(startDay).padStart(2, '0')}`,
                end: `${endYear}-${mmEnd}-${String(endDay).padStart(2, '0')}`
            });
        }

        // Zero matches off a 200 response almost always means the page markup
        // changed, not that the square is empty. Treat it as a failure so the
        // previous run's data is carried forward instead of being wiped.
        if (events.length === 0) {
            console.warn("NPS page fetched but no events matched — markup may have changed");
            return null;
        }

        console.log(`NPS: found ${events.length} events`);
    } catch (e) {
        console.warn("NPS fetch failed:", e.message);
        return null;
    }

    return events;
}

async function fetchCkanFestivals() {
    if (!FESTIVALS_ENABLED) {
        console.log("Festivals source disabled (see FESTIVALS_ENABLED) — skipping fetch.");
        return null;
    }

    try {
        console.log("Fetching CKAN festivals-events metadata...");
        const res = await fetch(CKAN_URL, {
            headers: { 'User-Agent': 'HowFar-DataFetcher/1.0 (GitHub Actions)' },
            timeout: 15000
        });
        if (!res.ok) {
            console.warn(`CKAN returned ${res.status}`);
            return null;
        }
        const body = await res.json();
        if (!body.success) return null;

        const jsonResource = body.result.resources.find(
            (r) => (r.format || '').toLowerCase() === 'json' || r.datastore_active
        );
        if (!jsonResource) return null;

        let eventsUrl = jsonResource.url;
        if (eventsUrl.includes('$top=')) {
            eventsUrl += "&$orderby=event_startdate%20desc";
        }

        console.log("Fetching actual event records...");
        const evRes = await fetch(eventsUrl, {
            headers: { 'User-Agent': 'HowFar-DataFetcher/1.0 (GitHub Actions)' },
            timeout: 15000
        });
        if (!evRes.ok) {
            console.warn(`Events API returned ${evRes.status}`);
            return null;
        }

        const rawEvents = await evRes.json();
        const events = Array.isArray(rawEvents) ? rawEvents : (rawEvents.value || []);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const festivals = [];

        for (const item of events) {
            try {
                const startStr = item.event_startdate || item.calEvent?.startDate || item.startDate;
                const endStr = item.event_enddate || item.calEvent?.endDate || item.endDate;
                if (!startStr) continue;

                const start = new Date(startStr);
                let end = start;
                if (endStr && endStr.trim() !== "" && endStr !== "null") {
                    const parsedEnd = new Date(endStr);
                    if (!isNaN(parsedEnd)) end = parsedEnd;
                }
                if (isNaN(start)) continue;

                const endDay = new Date(end); endDay.setHours(0, 0, 0, 0);
                if (endDay < today) continue; // skip past events

                const name = item.event_name || item.calEvent?.eventName || item.eventName || "Live Event";
                let locations = item.event_locations || item.calEvent?.locations || item.locations || [];
                if (typeof locations === 'string') {
                    try { locations = JSON.parse(locations); } catch (e) { locations = []; }
                }
                if (!Array.isArray(locations)) locations = [locations];

                for (const loc of locations) {
                    if (!loc) continue;
                    let lat, lon;
                    if (loc.location_gps) {
                        try {
                            const gpsArr = typeof loc.location_gps === 'string' ? JSON.parse(loc.location_gps) : loc.location_gps;
                            if (gpsArr && gpsArr.length > 0) {
                                lat = gpsArr[0].gps_lat;
                                lon = gpsArr[0].gps_lng;
                            }
                        } catch (e) {}
                    }
                    if (!lat) lat = loc.coords?.lat ?? loc.geo?.latitude ?? loc.latitude;
                    if (!lon) lon = loc.coords?.lng ?? loc.coords?.lon ?? loc.geo?.longitude ?? loc.longitude;
                    if (lat && lon) {
                        festivals.push({
                            name,
                            lat: parseFloat(lat),
                            lon: parseFloat(lon),
                            start: start.toISOString().split('T')[0],
                            end: new Date(end.getTime() + 12 * 3600000).toISOString().split('T')[0]
                        });
                        break; // one location per event is enough
                    }
                }
            } catch (e) {
                // skip bad record
            }
        }

        console.log(`CKAN: found ${festivals.length} festivals`);
        return festivals.length > 0 ? festivals : null;
    } catch (e) {
        console.warn("CKAN festivals fetch failed:", e.message);
        return null;
    }
}

async function fetchSkating() {
    try {
        console.log("Fetching ArcGIS Skate Locations...");
        const locRes = await fetch("https://services3.arcgis.com/b9WvedVPoizGfvfD/arcgis/rest/services/Skate_Locations_v2/FeatureServer/0/query?f=json&where=1=1&returnGeometry=true&outFields=locationid,location&outSR=4326&resultRecordCount=2000");
        if (!locRes.ok) {
            console.warn(`Skate Locations returned ${locRes.status}`);
            return null;
        }
        const locBody = await locRes.json();
        
        const locMap = {};
        for (const feature of locBody.features || []) {
            const locId = feature.attributes.locationid;
            const name = feature.attributes.location;
            const lon = feature.geometry?.x;
            const lat = feature.geometry?.y;
            if (locId && lat && lon) {
                locMap[locId] = { name, lat, lon };
            }
        }

        console.log("Fetching CKAN drop-in dataset metadata...");
        const metaRes = await fetch("https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=registered-programs-and-drop-in-courses-offering");
        if (!metaRes.ok) {
            console.warn(`Drop-in metadata returned ${metaRes.status}`);
            return null;
        }
        const metaBody = await metaRes.json();
        const dropInRes = metaBody.result?.resources?.find(r => r.name === 'Drop-in.json');
        if (!dropInRes) {
            console.warn("Drop-in.json resource not found in CKAN dataset");
            return null;
        }

        console.log("Fetching actual Drop-in schedules...");
        const dropRes = await fetch(dropInRes.url);
        if (!dropRes.ok) {
            console.warn(`Drop-in schedules returned ${dropRes.status}`);
            return null;
        }
        const dropIns = await dropRes.json();
        if (!Array.isArray(dropIns)) {
            console.warn("Drop-in schedules were not an array");
            return null;
        }
        
        const todayStr = new Date().toISOString().split('T')[0];
        const todayDay = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const activeSkating = [];

        for (const course of dropIns) {
            if (course["Course Title"] && course["Course Title"].includes("Leisure Skate")) {
                if ((course["Age Min"] == 0 || course["Age Min"] == 19) && (course["Age Max"] == "None" || course["Age Max"] >= 99)) {
                    if (course["Last Date"] && course["Last Date"] >= todayStr) {
                        const loc = locMap[course["Location ID"]];
                        if (loc) {
                            activeSkating.push({
                                name: loc.name,
                                lat: loc.lat,
                                lon: loc.lon,
                                date: course["First Date"],
                                start: `${course["Start Hour"]}:${String(course["Start Minute"]).padStart(2, '0')}`,
                                end: `${course["End Hour"]}:${String(course["End Min"]).padStart(2, '0')}`,
                                isAdult: course["Age Min"] == 19
                            });
                        }
                    }
                }
            }
        }
        
        // Genuinely empty is plausible here (summer, no ice), so an empty list
        // is a valid result rather than a failure.
        console.log(`Skating: found ${activeSkating.length} drop-in sessions upcoming`);
        return activeSkating;
    } catch (e) {
        console.warn("Skating fetch failed:", e.message);
        return null;
    }
}

// Reads the file left behind by the previous run (restored from the Actions
// cache) so a failing source can fall back to its last known-good data.
function readPrevious() {
    try {
        if (!fs.existsSync(OUT_FILE)) return {};
        const parsed = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        console.warn(`Could not read existing ${OUT_FILE}: ${e.message}`);
        return {};
    }
}

// A fetcher returning null means "failed", which is different from returning []
// ("succeeded, nothing to report"). Only the former falls back to the previous
// run's data. There is no invented data: if a source has never succeeded, its
// list is empty and the app simply shows no card.
//
// Carrying entries forward is safe because app.js filters every list by date
// on-device, so expired items stop rendering on their own. `fetched` records
// when the data was actually retrieved, so stale data is never passed off as
// current.
function pick(key, label, fresh, previous, now, degraded, { disabled = false } = {}) {
    const previousFetch = previous.sources?.[key]?.fetched || previous.lastUpdated || null;

    if (fresh !== null) {
        return { value: fresh, meta: { fetched: now } };
    }

    const cached = previous[key];

    // Disabled sources aren't failures — don't log a warning or count them
    // against the run, just carry forward whatever was last cached (or empty).
    if (disabled) {
        return { value: Array.isArray(cached) ? cached : [], meta: { fetched: previousFetch, stale: true, disabled: true } };
    }

    degraded.push(label);
    if (Array.isArray(cached) && cached.length > 0) {
        console.log(`::warning title=${label} unavailable::Carrying forward ${cached.length} entries last fetched ${previousFetch || 'unknown'}`);
        return { value: cached, meta: { fetched: previousFetch, stale: true } };
    }

    console.log(`::warning title=${label} unavailable::No previous data — this section will be empty`);
    return { value: [], meta: { fetched: previousFetch, stale: true } };
}

async function main() {
    console.log("--- HowFar Events Fetcher ---");

    const previous = readPrevious();

    const [npsData, ckanFestivals, skatingData, concertsData, sportsData] = await Promise.all([
        fetchNpsEvents(),
        fetchCkanFestivals(),
        fetchSkating(),
        fetchConcerts(),
        fetchSports()
    ]);

    const now = new Date().toISOString();
    const degraded = [];
    const nps = pick('npSquare', 'NP Square events', npsData, previous, now, degraded);
    const fest = pick('festivals', 'Festivals', ckanFestivals, previous, now, degraded, { disabled: !FESTIVALS_ENABLED });
    const skate = pick('skating', 'Drop-in skating', skatingData, previous, now, degraded);
    const concerts = pick('concerts', 'Concerts', concertsData, previous, now, degraded, { disabled: !TM_KEY });
    const sports = pick('sports', 'Sports', sportsData, previous, now, degraded, { disabled: !TM_KEY });

    const output = {
        lastUpdated: now,
        // Per-source retrieval times, so stale sections are identifiable from the
        // deployed file rather than only from the workflow log.
        sources: {
            npSquare: nps.meta,
            festivals: fest.meta,
            skating: skate.meta,
            concerts: concerts.meta,
            sports: sports.meta
        },
        npSquare: nps.value,
        festivals: fest.value,
        skating: skate.value,
        concerts: concerts.value,
        sports: sports.value
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 0));
    console.log(`Wrote ${OUT_FILE} (NPS: ${nps.value.length}, festivals: ${fest.value.length}, ` +
        `skating: ${skate.value.length}, concerts: ${concerts.value.length}, sports: ${sports.value.length})`);

    if (degraded.length > 0) {
        console.log(`::warning title=Degraded event data::${degraded.length} source(s) failed: ${degraded.join(', ')}`);
    } else {
        console.log("All enabled sources fetched successfully.");
    }
}

main().catch(e => {
    console.log(`::error title=Events fetcher crashed::${e.message}`);
    console.error(e);

    if (fs.existsSync(OUT_FILE)) {
        console.log(`Preserving existing ${OUT_FILE} from a previous run.`);
        process.exit(0);
    }
    // Nothing to fall back on — write an empty but well-formed file so the app
    // reads valid JSON and just renders no event cards.
    const empty = { fetched: null, stale: true };
    fs.writeFileSync(OUT_FILE, JSON.stringify({
        lastUpdated: new Date().toISOString(),
        sources: {
            npSquare: empty, festivals: empty, skating: empty,
            concerts: empty, sports: empty
        },
        npSquare: [],
        festivals: [],
        skating: [],
        concerts: [],
        sports: []
    }, null, 0));
    process.exit(0); // don't block the deploy — fallback data is still useful
});
