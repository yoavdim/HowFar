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

    const [npsData, ckanFestivals, skatingData] = await Promise.all([
        fetchNpsEvents(),
        fetchCkanFestivals(),
        fetchSkating()
    ]);

    const now = new Date().toISOString();
    const degraded = [];
    const nps = pick('npSquare', 'NP Square events', npsData, previous, now, degraded);
    const fest = pick('festivals', 'Festivals', ckanFestivals, previous, now, degraded, { disabled: !FESTIVALS_ENABLED });
    const skate = pick('skating', 'Drop-in skating', skatingData, previous, now, degraded);

    const output = {
        lastUpdated: now,
        // Per-source retrieval times, so stale sections are identifiable from the
        // deployed file rather than only from the workflow log.
        sources: {
            npSquare: nps.meta,
            festivals: fest.meta,
            skating: skate.meta
        },
        npSquare: nps.value,
        festivals: fest.value,
        skating: skate.value
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 0));
    console.log(`Wrote ${OUT_FILE} (NPS: ${nps.value.length}, festivals: ${fest.value.length}, skating: ${skate.value.length})`);

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
        sources: { npSquare: empty, festivals: empty, skating: empty },
        npSquare: [],
        festivals: [],
        skating: []
    }, null, 0));
    process.exit(0); // don't block the deploy — fallback data is still useful
});
