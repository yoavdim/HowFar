// Utility functions for geo calculations
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in metres
    const phi1 = lat1 * Math.PI/180;
    const phi2 = lat2 * Math.PI/180;
    const delta_phi = (lat2-lat1) * Math.PI/180;
    const delta_lambda = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(delta_phi/2) * Math.sin(delta_phi/2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(delta_lambda/2) * Math.sin(delta_lambda/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c; // returns distance in metres
}

function getBearing(lat1, lon1, lat2, lon2) {
    const phi1 = lat1 * Math.PI/180;
    const phi2 = lat2 * Math.PI/180;
    const lambda1 = lon1 * Math.PI/180;
    const lambda2 = lon2 * Math.PI/180;
    
    const y = Math.sin(lambda2-lambda1) * Math.cos(phi2);
    const x = Math.cos(phi1)*Math.sin(phi2) - Math.sin(phi1)*Math.cos(phi2)*Math.cos(lambda2-lambda1);
    const theta = Math.atan2(y, x);
    return (theta*180/Math.PI + 360) % 360; // in degrees from north
}

function formatDistance(meters) {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
}

// Data structures for the UI
const facilitiesConfigs = [
    { id: 'bike-avail', name: 'Bike Share (Available Bike)', icon: 'fa-bicycle', color: '#38BDF8' },
    { id: 'bike-dock', name: 'Bike Share (Available Dock)', icon: 'fa-square-parking', color: '#38BDF8' },
    { id: 'ttc-metro', name: 'TTC Metro Station', icon: 'fa-train-subway', color: '#EF4444' },
    { id: 'ttc-streetcar-ns', name: 'Streetcar (North/South)', icon: 'fa-train-tram', color: '#EF4444' },
    { id: 'ttc-streetcar-ew', name: 'Streetcar (East/West)', icon: 'fa-train-tram', color: '#EF4444' },
    { id: 'library', name: 'Public Library', icon: 'fa-book', color: '#10B981' },
    { id: 'park', name: 'Park', icon: 'fa-tree', color: '#10B981' },
    { id: 'tim-hortons', name: 'Tim Hortons', icon: 'fa-mug-hot', color: '#F59E0B' }
];

let userLat = null;
let userLon = null;
let miniMap = null;

function initMiniMap() {
    const mapEl = document.getElementById('mini-map');
    if (!mapEl || miniMap || !userLat || !userLon || typeof L === 'undefined') return;

    miniMap = L.map(mapEl, { zoomControl: false, scrollWheelZoom: false }).setView([userLat, userLon], 15);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(miniMap);

    const icon = L.divIcon({
        className: 'user-pin',
        html: '<i class="fa-solid fa-location-dot"></i>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });

    L.marker([userLat, userLon], { icon }).addTo(miniMap);
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initWeather();
    renderSkeletonCards();
    
    if ("geolocation" in navigator) {
        const timeoutId = setTimeout(() => {
            updateLocationStatus("Location request timed out. Please try again.", "error");
        }, 15000);

        navigator.geolocation.getCurrentPosition(
            (position) => {
                clearTimeout(timeoutId);
                userLat = position.coords.latitude;
                userLon = position.coords.longitude;
                updateLocationStatus(
                    `Location found (${userLat.toFixed(4)}, ${userLon.toFixed(4)}). Fetching facilities...`,
                    "success"
                );
                initMiniMap();
                fetchAllData();
            },
            (error) => {
                clearTimeout(timeoutId);
                console.error(error);
                updateLocationStatus("Could not get your location. Please enable GPS.", "error");
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
        );
    } else {
        updateLocationStatus("Geolocation is not supported by your browser.", "error");
    }
});

function updateLocationStatus(msg, statusClass = "") {
    const el = document.getElementById('location-status');
    el.innerHTML = `<i class="fa-solid fa-location-dot"></i> ${msg}`;
    el.className = `location-status ${statusClass}`;
}

async function initWeather() {
    try {
        // Fetch weather for Downtown Toronto
        const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=43.6532&longitude=-79.3832&current_weather=true');
        const data = await res.json();
        
        document.getElementById('temp-value').textContent = Math.round(data.current_weather.temperature);
        
        // Simple weather description based on weathercode
        const code = data.current_weather.weathercode;
        const iconEl = document.getElementById('weather-icon');
        const descEl = document.getElementById('weather-desc');
        
        if (code === 0) {
            iconEl.className = 'fa-solid fa-sun';
            descEl.textContent = 'Clear sky';
        } else if (code >= 1 && code <= 3) {
            iconEl.className = 'fa-solid fa-cloud-sun';
            descEl.textContent = 'Partly cloudy';
        } else if (code >= 51 && code <= 67) {
            iconEl.className = 'fa-solid fa-cloud-rain';
            descEl.textContent = 'Rain';
        } else if (code >= 71 && code <= 82) {
            iconEl.className = 'fa-solid fa-snowflake';
            descEl.textContent = 'Snow';
        } else {
            iconEl.className = 'fa-solid fa-cloud';
            descEl.textContent = 'Cloudy';
        }
    } catch (e) {
        console.error("Weather fetch failed", e);
        document.getElementById('weather-desc').textContent = "Weather unavailable";
    }
}

function skeletonCard(config) {
    return `
        <div class="facility-card glass-card skeleton">
            <div class="facility-icon"><i class="fa-solid ${config.icon}"></i></div>
            <div class="facility-details">
                <div class="skeleton-text"></div>
                <div class="skeleton-text short"></div>
            </div>
        </div>
    `;
}

function renderSkeletonCards() {
    const list = document.getElementById('facilities-list');
    list.innerHTML = facilitiesConfigs.map(skeletonCard).join('');
}

async function fetchAllData() {
    try {
        const statusEl = document.getElementById('location-status');
        const cache = loadOverpassCache();
        const queries = buildOverpassQueries();
        const elementsByQuery = {};
        const results = {};
        const getLat = e => e.lat || e.center?.lat;
        const getLon = e => e.lon || e.center?.lon;
        const findNearestOf = (list, filter) => findNearest(list, filter, getLat, getLon);

        // Seed with any cached results so cards appear instantly on repeat visits.
        Object.keys(queries).forEach(key => {
            const cached = cache[queries[key].id];
            if (cached && cached.length) elementsByQuery[key] = cached;
        });
        const cachedMetro = getCachedMetro();
        if (cachedMetro && cachedMetro.length) elementsByQuery.metro = cachedMetro;

        // Only set a result once its query has actually resolved (elementsByQuery key present).
        // Cards whose query found nothing stay undefined (skeleton) until the final pass, so
        // "None found nearby" is never shown while data might still be arriving.
        const computeOverpassCards = () => {
            if (elementsByQuery.metro) {
                const found = findNearestOf(elementsByQuery.metro, e => e.tags?.railway === 'station' && (e.tags?.network || '').includes('TTC'));
                if (found) results['ttc-metro'] = found;
            }
            if (elementsByQuery.tram) {
                const sorted = elementsByQuery.tram
                    .map(t => ({ ...t, dist: getDistance(userLat, userLon, getLat(t), getLon(t)) }))
                    .sort((a, b) => a.dist - b.dist);
                // Approximate directions by the two closest stops.
                if (sorted[0]) {
                    results['ttc-streetcar-ns'] = { ...sorted[0], distance: sorted[0].dist, origLat: getLat(sorted[0]), origLon: getLon(sorted[0]), title: sorted[0].tags?.name || 'Streetcar Stop' };
                }
                if (sorted[1]) {
                    results['ttc-streetcar-ew'] = { ...sorted[1], distance: sorted[1].dist, origLat: getLat(sorted[1]), origLon: getLon(sorted[1]), title: sorted[1].tags?.name || 'Streetcar Stop' };
                }
            }
            if (elementsByQuery.library) {
                const found = findNearestOf(elementsByQuery.library, e => e.tags?.amenity === 'library');
                if (found) results['library'] = found;
            }
            if (elementsByQuery['park-node'] !== undefined || elementsByQuery['park-way'] !== undefined) {
                const found = findNearestOf([...(elementsByQuery['park-node'] || []), ...(elementsByQuery['park-way'] || [])], e => e.tags?.leisure === 'park');
                if (found) results['park'] = found;
            }
            if (elementsByQuery['tim-hortons']) {
                const found = findNearestOf(elementsByQuery['tim-hortons'], e => (e.tags?.brand || e.tags?.name || '').toLowerCase().includes('tim hortons'));
                if (found) results['tim-hortons'] = found;
            }
        };

        const render = () => renderResults(results);

        // Show whatever the cache has immediately; live queries update each card as it lands.
        computeOverpassCards();
        render();

        // Fetch one query, fall back to its cached copy, then re-render.
        const fetchQuery = async (key) => {
            const q = queries[key];
            try {
                const data = await fetchOverpassQuery(q.body);
                const list = data.elements || [];
                elementsByQuery[key] = list;
                saveOverpassCache({ [q.id]: list });
            } catch (e) {
                const cached = cache[q.id];
                if (cached && cached.length) elementsByQuery[key] = cached;
            }
            computeOverpassCards();
            render();
        };

        // Bike cards render the moment the fast feed arrives.
        const bikePromise = fetchBikeShareData().then(bikes => {
            results['bike-avail'] = findNearestOf(bikes, s => s.status.num_bikes_available > 0);
            results['bike-dock'] = findNearestOf(bikes, s => s.status.num_docks_available > 0);
            render();
        });

        // Metro: whole network, cached separately; show the cache now, refresh in the background.
        const metroPromise = (async () => {
            const cached = getCachedMetro();
            if (cached && cached.length) {
                elementsByQuery.metro = cached;
                computeOverpassCards();
                render();
            }
            try {
                const fresh = await fetchMetroStations();
                if (fresh && fresh.length) {
                    elementsByQuery.metro = fresh;
                    computeOverpassCards();
                    render();
                }
            } catch (e) {}
        })();

        // Everything else fires in parallel; each card renders as its query lands.
        await Promise.all([
            bikePromise,
            metroPromise,
            fetchQuery('park-node'),
            fetchQuery('park-way'),
            fetchQuery('tram'),
            fetchQuery('library'),
            fetchQuery('tim-hortons')
        ]);

        // Any card still undefined after every query settled has no data at all → none found.
        computeOverpassCards();
        facilitiesConfigs.forEach(c => { if (results[c.id] === undefined) results[c.id] = null; });
        render();

        statusEl.style.display = 'none';
    } catch (error) {
        console.error("Data fetch error", error);
        updateLocationStatus("Error fetching data. Please try again later.", "error");
    }
}

const BIKE_INFO_URL = 'https://tor.publicbikesystem.net/ube/gbfs/v1/en/station_information';
const BIKE_STATUS_URL = 'https://tor.publicbikesystem.net/ube/gbfs/v1/en/station_status';
const BIKE_INFO_CACHE_KEY = 'howfar-bike-info-v1';
const BIKE_INFO_MAX_AGE = 24 * 60 * 60 * 1000; // refetch station list at most once a day

// Station locations are static, so cache them (compact form) and only refetch
// the real-time status feed on every load.
function getCachedBikeInfo() {
    try {
        const cached = JSON.parse(localStorage.getItem(BIKE_INFO_CACHE_KEY));
        if (cached && Array.isArray(cached.stations) && Date.now() - cached.fetched < BIKE_INFO_MAX_AGE) {
            return cached.stations;
        }
    } catch (e) {}
    return null;
}

function saveBikeInfo(stations) {
    try {
        localStorage.setItem(BIKE_INFO_CACHE_KEY, JSON.stringify({ fetched: Date.now(), stations }));
    } catch (e) {}
}

async function fetchBikeInfo() {
    const res = await fetch(BIKE_INFO_URL);
    if (!res.ok) throw new Error(`Bike share info request failed (${res.status})`);
    const info = await res.json();
    const compact = info.data.stations.map(s => ({
        station_id: s.station_id,
        name: s.name,
        lat: s.lat,
        lon: s.lon
    }));
    saveBikeInfo(compact);
    return compact;
}

async function fetchBikeShareData() {
    const cachedStations = getCachedBikeInfo();

    // Status is always needed (real-time); info only on a cache miss. Both run in parallel.
    const statusPromise = fetch(BIKE_STATUS_URL);
    const infoPromise = cachedStations ? null : fetchBikeInfo();

    const statusRes = await statusPromise;
    if (!statusRes.ok) throw new Error(`Bike share status request failed (${statusRes.status})`);
    const status = await statusRes.json();
    const stations = cachedStations || await infoPromise;

    // Map status by station_id for quick lookup
    const statusMap = {};
    status.data.stations.forEach(s => {
        statusMap[s.station_id] = s;
    });
    
    // Combine
    return stations.map(station => ({
        ...station,
        status: statusMap[station.station_id] || { num_bikes_available: 0, num_docks_available: 0 }
    }));
}

const OVERPASS_ENDPOINTS = [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter'
];

// Bounds covering every TTC subway/RT station in the GTA (Lines 1, 2, 4 + Vaughan ext.)
const TORONTO_BBOX = '43.50,-79.75,43.90,-78.90';
const STREETCAR_RADIUS = 2000;
const LOCAL_RADIUS = 4000;

// Small sub-queries run in parallel so one slow query never blocks the rest.
// The park query is split so a heavy way-query failure can't wipe out the node results.
// Metro is fetched once for the whole network (location-independent); streetcars use a
// tighter radius since they are dense downtown.
function buildOverpassQueries() {
    return {
        metro: { id: 'metro', body: `node["railway"="station"]["network"~"TTC"](${TORONTO_BBOX});` },
        tram: { id: 'tram', body: `node["railway"="tram_stop"](around:${STREETCAR_RADIUS}, ${userLat}, ${userLon});` },
        library: { id: 'library', body: `node["amenity"="library"](around:${LOCAL_RADIUS}, ${userLat}, ${userLon});` },
        'park-node': { id: 'park-node', body: `node["leisure"="park"](around:${LOCAL_RADIUS}, ${userLat}, ${userLon});` },
        'park-way': { id: 'park-way', body: `way["leisure"="park"](around:${LOCAL_RADIUS}, ${userLat}, ${userLon});` },
        'tim-hortons': { id: 'tim-hortons', body: `node["brand"="Tim Hortons"](around:${LOCAL_RADIUS}, ${userLat}, ${userLon});` }
    };
}

// Cache successful overpass results per ~1km area so a flaky mirror never
// leaves cards permanently empty on a refresh.
function overpassCacheKey() {
    return 'howfar-overpass-v1:' + Math.round(userLat * 100) + ',' + Math.round(userLon * 100);
}

function loadOverpassCache() {
    try {
        return JSON.parse(localStorage.getItem(overpassCacheKey())) || {};
    } catch (e) {
        return {};
    }
}

function saveOverpassCache(byId) {
    try {
        const key = overpassCacheKey();
        const merged = { ...loadOverpassCache(), ...byId };
        localStorage.setItem(key, JSON.stringify(merged));
    } catch (e) {
        // localStorage full or unavailable; ignore
    }
}

// Metro stations are static and location-independent, so keep a separate
// long-lived cache for the whole network instead of the per-location cache above.
const METRO_CACHE_KEY = 'howfar-metro-v1';
const METRO_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function getCachedMetro() {
    try {
        const cached = JSON.parse(localStorage.getItem(METRO_CACHE_KEY));
        if (cached && Array.isArray(cached.stations) && Date.now() - cached.fetched < METRO_MAX_AGE) {
            return cached.stations;
        }
    } catch (e) {}
    return null;
}

function saveMetroCache(stations) {
    try {
        localStorage.setItem(METRO_CACHE_KEY, JSON.stringify({ fetched: Date.now(), stations }));
    } catch (e) {}
}

async function fetchMetroStations() {
    const cached = getCachedMetro();
    if (cached) return cached;
    const data = await fetchOverpassQuery(`node["railway"="station"]["network"~"TTC"](${TORONTO_BBOX});`);
    const list = data.elements || [];
    if (list.length) saveMetroCache(list);
    return list;
}

async function fetchOverpassQuery(queryBody) {
    const MAX_ATTEMPTS = 3;
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
        try {
            return await raceOverpassMirrors(queryBody);
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error('All Overpass endpoints failed');
}

// Fire all mirrors at once (with a small stagger to dodge rate limits);
// resolve as soon as the fastest one succeeds.
async function raceOverpassMirrors(queryBody) {
    const body = `[out:json][timeout:25];(${queryBody});out center;`;
    const controllers = OVERPASS_ENDPOINTS.map(() => new AbortController());
    const attempts = OVERPASS_ENDPOINTS.map((endpoint, i) =>
        new Promise(resolve => setTimeout(resolve, Math.random() * 500))
            .then(() => fetchOverpassWithTimeout(endpoint, body, controllers[i]))
    );

    return await new Promise((resolve, reject) => {
        let pending = attempts.length;
        let done = false;
        attempts.forEach((promise) => {
            promise.then(
                (value) => {
                    if (!done) {
                        done = true;
                        controllers.forEach(c => c.abort());
                        resolve(value);
                    }
                },
                () => {
                    if (!done && --pending === 0) reject(new Error('All Overpass endpoints failed'));
                }
            );
        });
    });
}

async function fetchOverpassWithTimeout(endpoint, body, controller) {
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'HowFarApp/1.0'
            },
            body: 'data=' + encodeURIComponent(body)
        });
        if (!res.ok) throw new Error(`Overpass request failed (${res.status})`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function findNearest(items, filterFn, latFn, lonFn) {
    let nearest = null;
    let minD = Infinity;
    
    items.filter(filterFn).forEach(item => {
        const d = getDistance(userLat, userLon, latFn(item), lonFn(item));
        if (d < minD) {
            minD = d;
            nearest = { ...item, distance: d, origLat: latFn(item), origLon: lonFn(item), title: item.name || item.tags?.name || 'Location' };
        }
    });
    
    return nearest;
}

function bikeStatusText(item) {
    if (!item.status) return '';
    const s = item.status;
    const bikes = s.num_bikes_available ?? 0;
    const docks = s.num_docks_available ?? 0;
    const nonElectric = s.num_bikes_available_types?.mechanical ?? 0;
    return `${bikes} bikes · ${docks} docks (${nonElectric} non-electric)`;
}

function renderResults(results) {
    const list = document.getElementById('facilities-list');
    list.innerHTML = '';
    
    facilitiesConfigs.forEach(config => {
        const item = results[config.id];
        if (item === undefined) {
            // Still loading — keep a skeleton so cards never flicker to "none found".
            list.innerHTML += skeletonCard(config);
            return;
        }
        if (!item) {
            // Render not found state
            list.innerHTML += `
                <div class="facility-card glass-card" style="opacity: 0.6">
                    <div class="facility-icon" style="color: ${config.color}"><i class="fa-solid ${config.icon}"></i></div>
                    <div class="facility-details">
                        <div class="facility-name">${config.name}</div>
                        <div class="facility-meta">None found nearby</div>
                    </div>
                </div>
            `;
            return;
        }
        
        const d = item.distance;
        const bearing = getBearing(userLat, userLon, item.origLat, item.origLon);
        const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.origLat},${item.origLon}`;
        
        list.innerHTML += `
            <a href="${mapUrl}" target="_blank" class="facility-card glass-card">
                <div class="facility-icon" style="color: ${config.color}"><i class="fa-solid ${config.icon}"></i></div>
                <div class="facility-details">
                    <div class="facility-name">${config.name}</div>
                    <div class="facility-meta">${item.title}</div>
                    ${item.status ? `<div class="facility-status">${bikeStatusText(item)}</div>` : ''}
                </div>
                <div class="facility-distance">
                    <div class="distance-value">${formatDistance(d)}</div>
                    <div class="direction-compass">
                        <i class="fa-solid fa-location-arrow compass-arrow" style="transform: rotate(${bearing - 45}deg);"></i> 
                        <i class="fa-solid fa-chevron-right" style="font-size: 0.7rem; opacity: 0.5;"></i>
                    </div>
                </div>
            </a>
        `;
    });
}
