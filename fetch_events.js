#!/usr/bin/env node
// fetch_events.js — Runs server-side in GitHub Actions (no CORS issues).
// Fetches Toronto events from city APIs and writes toronto_events.json.

const fs = require('fs');
const fetch = require('node-fetch');

const NPS_URL = "https://www.toronto.ca/services-payments/venues-facilities-bookings/booking-city-facilities/city-squares/nathan-phillips-square/events-happening-on-nathan-phillips-square/";
const CKAN_URL = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=festivals-events";

// Hardcoded festival list — developer updates this occasionally.
// The GitHub Action runs daily and writes these into toronto_events.json.
const HARDCODED_FESTIVALS = [
    { name: "CNE (The Ex)", lat: 43.6306, lon: -79.4184, start: "2026-08-21", end: "2026-09-07" },
    { name: "Toronto TAIWANfest", lat: 43.6396, lon: -79.3821, start: "2026-08-28", end: "2026-08-30" },
    { name: "Thai Fest Toronto", lat: 43.6563, lon: -79.3805, start: "2026-08-29", end: "2026-08-30" },
    { name: "FAN EXPO Canada", lat: 43.6426, lon: -79.3871, start: "2026-08-27", end: "2026-08-30" },
    { name: "PHANTOMFEST", lat: 43.6407, lon: -79.3314, start: "2026-08-29", end: "2026-08-30" },
    { name: "Pedestrian Sunday Kensington", lat: 43.6545, lon: -79.4002, start: "2026-08-30", end: "2026-08-30" }
];

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
            return events;
        }
        const html = await res.text();

        const thisYear = new Date().getFullYear();

        // Match "Month Day to Day: <a>name</a>" or "Month Day: <a>name</a>"
        const pattern = /([A-Z][a-z]+)\s+(\d+)(?:\s+to\s+(\d+))?\s*:\s*<a[^>]*>([^<]+)<\/a>/gi;
        let match;
        while ((match = pattern.exec(html)) !== null) {
            const monthNum = MONTHS[match[1].toLowerCase()];
            if (!monthNum) continue;
            const startDay = parseInt(match[2]);
            const endDay = match[3] ? parseInt(match[3]) : startDay;
            const name = match[4].trim();
            const mm = String(monthNum).padStart(2, '0');
            events.push({
                name,
                start: `${thisYear}-${mm}-${String(startDay).padStart(2, '0')}`,
                end: `${thisYear}-${mm}-${String(endDay).padStart(2, '0')}`
            });
        }

        console.log(`NPS: found ${events.length} events`);
    } catch (e) {
        console.warn("NPS fetch failed:", e.message);
    }

    return events;
}

async function fetchCkanFestivals() {
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
        const metaBody = await metaRes.json();
        const dropInRes = metaBody.result.resources.find(r => r.name === 'Drop-in.json');

        console.log("Fetching actual Drop-in schedules...");
        const dropRes = await fetch(dropInRes.url);
        const dropIns = await dropRes.json();
        
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
        
        console.log(`Skating: found ${activeSkating.length} drop-in sessions upcoming`);
        return activeSkating;
    } catch (e) {
        console.warn("Skating fetch failed:", e.message);
        return [];
    }
}

async function main() {
    console.log("--- HowFar Events Fetcher ---");

    const [npsData, ckanFestivals, skatingData] = await Promise.all([
        fetchNpsEvents(),
        fetchCkanFestivals(),
        fetchSkating()
    ]);

    const festivals = ckanFestivals || HARDCODED_FESTIVALS;

    const output = {
        lastUpdated: new Date().toISOString(),
        npSquare: npsData,
        festivals,
        skating: skatingData
    };

    fs.writeFileSync('toronto_events.json', JSON.stringify(output, null, 0));
    console.log(`Wrote toronto_events.json (${festivals.length} festivals, NPS: ${npsData.length} events)`);
}

main().catch(e => {
    console.error("Fatal error:", e);
    if (fs.existsSync('toronto_events.json')) {
        console.log("Preserving cached toronto_events.json from a previous successful run.");
        process.exit(0);
    }
    // Write a minimal fallback so the app still has something
    const fallback = {
        lastUpdated: new Date().toISOString(),
        npSquare: [],
        festivals: HARDCODED_FESTIVALS,
        skating: []
    };
    fs.writeFileSync('toronto_events.json', JSON.stringify(fallback, null, 0));
    process.exit(0); // don't fail the workflow — fallback data is still useful
});
