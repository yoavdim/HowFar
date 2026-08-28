// Utility functions for geo calculations
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in metres
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const delta_phi = (lat2 - lat1) * Math.PI / 180;
    const delta_lambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(delta_phi / 2) * Math.sin(delta_phi / 2) +
        Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(delta_lambda / 2) * Math.sin(delta_lambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // returns distance in metres
}

function getBearing(lat1, lon1, lat2, lon2) {
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const lambda1 = lon1 * Math.PI / 180;
    const lambda2 = lon2 * Math.PI / 180;

    const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);
    const theta = Math.atan2(y, x);
    return (theta * 180 / Math.PI + 360) % 360; // in degrees from north
}

function formatDistance(meters) {
    if (meters == null) return '--';
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
}

// Data structures for the UI
const facilitiesConfigs = [
    { id: 'bike-avail', name: 'Bikes', icon: 'fa-bicycle', color: '#38BDF8', group: 'bikes' },
    { id: 'bike-dock', name: 'Docks', icon: 'fa-square-parking', color: '#38BDF8', group: 'bikes' },
    { id: 'ttc-metro', name: 'TTC Metro Station', icon: 'fa-train-subway', color: '#EF4444', group: 'ttc' },
    { id: 'ttc-streetcar-ns', name: 'Streetcar (North/South)', icon: 'fa-train-tram', color: '#EF4444', group: 'ttc' },
    { id: 'ttc-streetcar-ew', name: 'Streetcar (East/West)', icon: 'fa-train-tram', color: '#EF4444', group: 'ttc' },
    { id: 'library', name: 'Public Library', icon: 'fa-book', color: '#10B981', group: 'facilities' },
    { id: 'park', name: 'Park', icon: 'fa-tree', color: '#10B981', group: 'facilities' },
    { id: 'skating', name: 'Drop-in Skate', icon: 'fa-person-skating', color: '#10B981', group: 'facilities' },
    { id: 'np-square', name: 'NP Square', icon: 'fa-landmark', color: '#8B5CF6', group: 'other' },
    { id: 'festival', name: 'Festival', icon: 'fa-masks-theater', color: '#8B5CF6', group: 'other' },
    { id: 'tim-hortons', name: 'Tim Hortons', icon: 'fa-mug-hot', color: '#F59E0B', group: 'other' }
];

const facilityGroups = ['bikes', 'ttc', 'facilities', 'other'];

let userLat = null;
let userLon = null;
let miniMap = null;


function initMiniMap() {
    const mapEl = document.getElementById('mini-map');
    if (!mapEl || miniMap || !userLat || !userLon || typeof L === 'undefined') return;

    miniMap = L.map(mapEl, { zoomControl: false, scrollWheelZoom: false }).setView([userLat, userLon], 15);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_2hd6_1_8868477b9bb66d052fc89b3d', {
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
    renderSkeletonCards();
    initMenu();

    const fallbackLocation = async () => {
        updateLocationStatus("GPS blocked. Fetching approximate location via IP...", "error");
        try {
            let data = JSON.parse(localStorage.getItem('hf_ip')) || {};
            if (Date.now() - (data.t || 0) > 120000) {
                data = await (await fetch('https://ipapi.co/json/')).json();
                localStorage.setItem('hf_ip', JSON.stringify({ ...data, t: Date.now() }));
            }
            if (data.latitude && data.longitude) {
                userLat = data.latitude;
                userLon = data.longitude;
                updateLocationStatus(`Approximate location found (${userLat.toFixed(4)}, ${userLon.toFixed(4)}). Fetching facilities...`, "success");
                initMiniMap();
                fetchAllData();
                return;
            }
        } catch (e) {
            console.error("IP Geolocation failed", e);
        }

        updateLocationStatus("Could not determine location, defaulting to CN Tower", "error");
        userLat = 43.6426;
        userLon = -79.3871;
        initMiniMap();
        fetchAllData();
    };

    if ("geolocation" in navigator) {
        const timeoutId = setTimeout(() => {
            fallbackLocation();
        }, 3000);

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
                console.warn("GPS Error:", error);
                fallbackLocation();
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 3000 }
        );
    } else {
        fallbackLocation();
    }

    // Sticky collapsing header (mobile only)
    const header = document.querySelector('.weather-header');
    window.addEventListener('scroll', () => {
        if (window.innerWidth <= 600) header.classList.toggle('scrolled', window.scrollY > 60);
    }, { passive: true });
});

function updateLocationStatus(msg, statusClass = "") {
    const el = document.getElementById('location-status');
    el.style.display = '';
    el.innerHTML = `<i class="fa-solid fa-location-dot"></i> ${msg}`;
    el.className = `location-status ${statusClass}`;
}

async function initWeather(lat, lon) {
    try {
        const [weatherRes, aqiRes] = await Promise.all([
            fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=precipitation,weathercode&forecast_hours=12&current=uv_index`),
            fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi`).catch(() => null)
        ]);
        const data = await weatherRes.json();
        
        let aqiData = null;
        if (aqiRes && aqiRes.ok) {
            aqiData = await aqiRes.json();
        }

        const temp = Math.round(data.current_weather.temperature);
        document.getElementById('temp-value').textContent = temp;
        document.getElementById('temp-value-bar').textContent = temp;

        const code = data.current_weather.weathercode;
        const iconEl = document.getElementById('weather-icon');
        const iconBarEl = document.getElementById('weather-icon-bar');
        const descEl = document.getElementById('weather-desc');

        let iconClass, desc;
        if (code === 0)                                                      { iconClass = 'fa-solid fa-sun';        desc = 'Clear sky'; }
        else if (code >= 1 && code <= 3)                                     { iconClass = 'fa-solid fa-cloud-sun';  desc = 'Partly cloudy'; }
        else if (code === 45 || code === 48)                                 { iconClass = 'fa-solid fa-smog';       desc = 'Fog'; }
        else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82))   { iconClass = 'fa-solid fa-cloud-rain'; desc = 'Rain'; }
        else if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86))   { iconClass = 'fa-solid fa-snowflake';  desc = 'Snow'; }
        else if (code >= 95)                                                 { iconClass = 'fa-solid fa-cloud-bolt'; desc = 'Thunderstorm'; }
        else                                                                 { iconClass = 'fa-solid fa-cloud';      desc = 'Cloudy'; }

        const uvIndex = data.current?.uv_index || 0;
        const aqi = aqiData?.current?.us_aqi || 0;
        
        let alerts = [];
        if (uvIndex >= 8) alerts.push("High UV");
        if (aqi >= 150) alerts.push("Poor Air");

        // Check for upcoming precipitation changes
        if (data.hourly && data.hourly.precipitation) {
            if (code < 51) {
                // Currently clear/cloudy, check when it starts (using 0.2mm tolerance)
                for (let i = 1; i <= 6 && i < data.hourly.precipitation.length; i++) {
                    if (data.hourly.precipitation[i] >= 0.2) {
                        const hCode = data.hourly.weathercode[i];
                        const isSnow = ((hCode >= 71 && hCode <= 77) || (hCode >= 85 && hCode <= 86));
                        const isStorm = (hCode >= 95);
                        const precipType = isStorm ? 'Storm' : isSnow ? 'Snow' : 'Rain';
                        alerts.push(`${precipType} in ${i}h`);
                        break;
                    }
                }
            } else {
                // Currently raining/snowing, check when it stops (drops below 0.2mm)
                for (let i = 1; i <= 6 && i < data.hourly.precipitation.length; i++) {
                    if (data.hourly.precipitation[i] < 0.2) {
                        alerts.push(`Stopping in ${i}h`);
                        break;
                    }
                }
            }
        }
        
        if (alerts.length > 0) {
            desc += ` — ${alerts.join(', ')}`;
        }

        iconEl.className = iconClass;
        iconBarEl.className = iconClass;
        descEl.textContent = desc;
    } catch (e) {
        console.error("Weather fetch failed", e);
        document.getElementById('weather-desc').textContent = "Weather unavailable";
    }
}

function skeletonItem(config) {
    return `
        <div class="facility-item skeleton">
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
    list.innerHTML = facilityGroups.map(group => {
        const configs = facilitiesConfigs.filter(c => c.group === group);
        return `<div class="facility-group glass-card">${configs.map(skeletonItem).join('<div class="group-divider"></div>')}</div>`;
    }).join('');
}

// Pre-generated events data — produced daily by fetch_events.js via GitHub Actions.
// Falls back to live CORS-proxied fetches if the file is unavailable (local dev).
async function fetchLiveEvents() {
    let npEvent = null;
    let nearestFestival = null;
    let nearestSkating = null;

    // Step 1: Try the pre-generated JSON (fast, same-origin, no CORS).
    try {
        const res = await fetch('toronto_events.json');
        if (res.ok) {
            const data = await res.json();

            // NPS events — filter on-device so "today" is always current
            const events = data.npSquare || [];
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayNames = [];
            let nextTitle = null;
            let nextSubtitle = null;
            let nextWeight = Infinity;

            for (const ev of events) {
                const s = new Date(ev.start + 'T12:00'); s.setHours(0, 0, 0, 0);
                const e = new Date(ev.end + 'T12:00'); e.setHours(0, 0, 0, 0);
                if (today >= s && today <= e) {
                    if (!todayNames.includes(ev.name)) todayNames.push(ev.name);
                } else if (s > today) {
                    const w = (s.getMonth() + 1) * 100 + s.getDate();
                    if (w < nextWeight) {
                        nextWeight = w;
                        nextSubtitle = s.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
                        nextTitle = ev.name;
                    }
                }
            }
            npEvent = {
                title: todayNames.length > 0 ? todayNames.join(', ') : (nextTitle || null),
                subtitle: todayNames.length > 0 ? "Today" : (nextSubtitle || null),
                isActive: todayNames.length > 0
            };

            if (data.lastUpdated) {
                const date = new Date(data.lastUpdated);
                const el = document.getElementById('events-updated-text');
                if (el) el.textContent = `Events updated: ${date.toLocaleString()}`;
            }

            // Find nearest festival to user
            if (data.festivals?.length && userLat && userLon) {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                let minDist = Infinity;
                let bestActive = null;

                for (const fb of data.festivals) {
                    const start = new Date(fb.start + 'T12:00'); start.setHours(0, 0, 0, 0);
                    const end = new Date(fb.end + 'T12:00'); end.setHours(0, 0, 0, 0);
                    if (end < today) continue;
                    const active = today >= start && today <= end;
                    const dist = getDistance(userLat, userLon, fb.lat, fb.lon);
                    if (active && dist < minDist) {
                        minDist = dist;
                        bestActive = fb;
                    }
                }

                if (bestActive) {
                    const d = getDistance(userLat, userLon, bestActive.lat, bestActive.lon);
                    const dateStr = new Date(bestActive.start + 'T12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + '–' + new Date(bestActive.end + 'T12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
                    nearestFestival = { distance: d, origLat: bestActive.lat, origLon: bestActive.lon, title: bestActive.name, subtitle: dateStr, isActive: true };
                } else {
                    minDist = Infinity;
                    for (const fb of data.festivals) {
                        const start = new Date(fb.start + 'T12:00'); start.setHours(0, 0, 0, 0);
                        if (start < today) continue;
                        const dist = getDistance(userLat, userLon, fb.lat, fb.lon);
                        if (dist < minDist) {
                            minDist = dist;
                            const dateStr = new Date(fb.start + 'T12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + '–' + new Date(fb.end + 'T12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
                            nearestFestival = { distance: dist, origLat: fb.lat, origLon: fb.lon, title: fb.name, subtitle: dateStr };
                        }
                    }
                }
            }

            // Find nearest active skating
            if (data.skating?.length && userLat && userLon) {
                const todayStr = today.toISOString().split('T')[0];
                const validSessions = data.skating.filter(sk => 
                    sk.date >= todayStr && (!sk.isAdult || getAdultSkatePref())
                );
                
                if (validSessions.length > 0) {
                    // Sort by date ascending, then by distance
                    validSessions.sort((a, b) => {
                        if (a.date < b.date) return -1;
                        if (a.date > b.date) return 1;
                        const distA = getDistance(userLat, userLon, a.lat, a.lon);
                        const distB = getDistance(userLat, userLon, b.lat, b.lon);
                        return distA - distB;
                    });
                    
                    const best = validSessions[0];
                    const isToday = best.date === todayStr;
                    const dateDisplay = isToday ? '' : `(${new Date(best.date + 'T12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}) `;

                    nearestSkating = {
                        distance: getDistance(userLat, userLon, best.lat, best.lon),
                        origLat: best.lat,
                        origLon: best.lon,
                        title: `${dateDisplay}${best.start} – ${best.end}`,
                        overrideName: best.name,
                        isActive: isToday
                    };
                }
            }

            console.log("Loaded pre-generated toronto_events.json");
            return { npEvent, nearestFestival, nearestSkating };
        }
    } catch (e) {
        console.warn("toronto_events.json unavailable:", e.message);
    }

    return { npEvent: null, nearestFestival: null, nearestSkating: null };
}

async function resolveLocationName(lat, lon) {
    const el = document.getElementById('weather-loc-text');
    if (!el) return;
    
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1&zoom=18`, {
            headers: {
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        
        if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
        }
        
        const data = await res.json();
        console.log("Geocoding result:", data);
        const address = data.address;
        
        if (!address) {
            console.warn("No address found in geocoding data, defaulting to Toronto");
            el.textContent = 'Toronto';
            return;
        }

        let locName = 'Unknown Location';
        const isToronto = address.city === 'Toronto' || address.municipality === 'Toronto';
        
        if (!isToronto) {
            locName = address.city || address.town || address.village || address.county || 'Unknown Area';
        } else {
            const specificKeys = ['neighbourhood', 'city_block', 'quarter', 'suburb', 'city_district'];
            for (const key of specificKeys) {
                if (address[key]) {
                    locName = address[key];
                    break;
                }
            }
            if (locName === 'Unknown Location') {
                locName = 'Toronto'; 
            }
        }
        
        if (locName === 'Church-Wellesley') {
            locName += ' 🏳️‍🌈';
        }
        
        el.textContent = locName;
    } catch (e) {
        console.warn("Reverse geocoding failed", e);
        el.textContent = 'Toronto'; // Graceful fallback
    }
}

async function fetchAllData() {
    resolveLocationName(userLat, userLon);
    initWeather(userLat, userLon);
    const statusEl = document.getElementById('location-status');
    const results = appResults = {};
    appDone = false;

    const getLat = e => e.lat || e.center?.lat;
    const getLon = e => e.lon || e.center?.lon;
    const findNearestOf = (list, filter) => findNearest(list, filter, getLat, getLon);

    // Data buckets, keyed by facility id. A key is only set once its source has
    // resolved, so cards never show "None found" while data might still be arriving.
    const data = {};

    const computeCards = () => {
        if (data.metro) {
            results['ttc-metro'] = findNearestOf(data.metro, () => true);
        }

        if (data.tram) {
            const nearestTram = findNearestOf(data.tram, () => true);
            let nsFound = findNearestOf(data.tram, e => e.isNS);
            if (!nsFound && nearestTram) {
                nsFound = { ...nearestTram, fallback: true };
            }
            results['ttc-streetcar-ns'] = nsFound ? { ...nsFound, title: nsFound.tags?.name || 'Streetcar Stop' } : null;
            let ewFound = findNearestOf(data.tram, e => e.isEW);
            if (!ewFound && nearestTram) {
                ewFound = { ...nearestTram, fallback: true };
            }
            results['ttc-streetcar-ew'] = ewFound ? { ...ewFound, title: ewFound.tags?.name || 'Streetcar Stop' } : null;
        }

        if (data.library) {
            results['library'] = findNearestOf(data.library, () => true);
        }

        if (data.park) {
            results['park'] = findNearestOf(data.park, () => true);
        }

        if (data['tim-hortons']) {
            results['tim-hortons'] = findNearestOf(data['tim-hortons'], () => true);
        }

        // Hardcoded municipal item — np-square is always available
        if (liveNpEvent !== undefined) {
            results['np-square'] = {
                origLat: 43.6534,
                origLon: -79.3841,
                distance: getDistance(userLat, userLon, 43.6534, -79.3841),
                title: liveNpEvent?.title || "Nothing today",
                subtitle: liveNpEvent?.subtitle || null,
                isActive: liveNpEvent?.isActive || false
            };
        }
        
        // Festival card: only set once events have been fetched, otherwise leave
        // undefined so it renders as a skeleton (not "None found nearby").
        if (liveFestival !== undefined) {
            results['festival'] = liveFestival || null;
        }

        // Skating card: like festival, wait for fetch.
        if (liveSkating !== undefined) {
            if (liveSkating) {
                results['skating'] = {
                    distance: liveSkating.distance,
                    title: liveSkating.overrideName,
                    subtitle: liveSkating.title,
                    isActive: liveSkating.isActive
                };
            } else {
                results['skating'] = {
                    distance: null,
                    title: "No drop-in today",
                    isActive: false
                };
            }
        }
    };

    const render = () => renderResults(appResults, appDone);

    const setBikeResults = bikes => {
        currentBikes = bikes;
        computeBikeResults(appResults);
        render();
    };

    // First paint comes instantly from local static data
    const overpassPromise = (async () => {
        try {
            const res = await fetch('toronto_data.json');
            if (!res.ok) throw new Error("Failed to load static POI data");
            const parsed = await res.json();
            
            if (parsed.lastUpdated) {
                const date = new Date(parsed.lastUpdated);
                const updatedEl = document.getElementById('data-updated-text');
                if (updatedEl) {
                    updatedEl.textContent = `Stations updated: ${date.toLocaleString()}`;
                }
            }

            data.metro = parsed.metro;
            data.tram = parsed.tramStops;
            parsed.tramStops.forEach(tagStopDirectionByName);
            data.library = parsed.libraries;
            data.park = [...parsed.parkNodes, ...parsed.parkWays];
            data['tim-hortons'] = parsed.timHortons;

            computeCards();
            render();
        } catch (e) {
            console.error("Static data load failed", e);
        }
    })();

    const bikePromise = fetchBikeShareData(setBikeResults);

    let liveNpEvent = null;
    let liveFestival = null;
    let liveSkating = null;

    const eventsPromise = (async () => {
        const { npEvent, nearestFestival, nearestSkating } = await fetchLiveEvents();
        liveNpEvent = npEvent;
        liveFestival = nearestFestival;
        liveSkating = nearestSkating;
        
        if (appDone) {
            computeCards();
            render();
        }
    })();

    await Promise.allSettled([overpassPromise, bikePromise, eventsPromise]);

    appDone = true;
    computeCards();
    render();
    if (statusEl && !statusEl.classList.contains('error')) {
        statusEl.style.display = 'none';
    }
}

// --- Local cache helpers ---
function readCache(key) {
    try {
        return JSON.parse(localStorage.getItem(key));
    } catch (e) {
        return null;
    }
}

function writeCache(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        // Storage full or unavailable — the cache is best-effort, never fatal.
    }
}

// --- Bike Share (stale-while-revalidate) ---
const BIKE_INFO_URL = 'https://tor.publicbikesystem.net/ube/gbfs/v1/en/station_information';
const BIKE_STATUS_URL = 'https://tor.publicbikesystem.net/ube/gbfs/v1/en/station_status';
const BIKE_CACHE_KEY = 'bike_combined_cache';
const BIKE_MAX_AGE = 5 * 60 * 1000;

// Shared app state so the menu can re-render bike cards without re-fetching.
let appResults = {};
let appDone = false;
let currentBikes = null;

// Bike preference: 'regular' | 'electric' | 'both'
const BIKE_TYPE_KEY = 'howfar-bike-type';
const HIDE_TTC_KEY = 'howfar-hide-ttc';

function getHideTtcPref() {
    try {
        return localStorage.getItem(HIDE_TTC_KEY) === 'true';
    } catch (e) {
        return false;
    }
}

function setHideTtcPref(val) {
    try {
        localStorage.setItem(HIDE_TTC_KEY, val);
    } catch (e) { }
}

const ADULT_SKATE_KEY = 'howfar-adult-skate';

function getAdultSkatePref() {
    try {
        return localStorage.getItem(ADULT_SKATE_KEY) === 'true';
    } catch (e) {
        return false;
    }
}

function setAdultSkatePref(val) {
    try {
        localStorage.setItem(ADULT_SKATE_KEY, val);
    } catch (e) { }
}

function getBikeTypePref() {
    try {
        return localStorage.getItem(BIKE_TYPE_KEY) || 'both';
    } catch (e) {
        return 'both';
    }
}

function setBikeTypePref(type) {
    try {
        localStorage.setItem(BIKE_TYPE_KEY, type);
    } catch (e) {
        // Storage unavailable — preference simply won't persist.
    }
}

function computeBikeResults(results) {
    if (!currentBikes) return;
    const bikeType = getBikeTypePref();
    const getLat = e => e.lat || e.center?.lat;
    const getLon = e => e.lon || e.center?.lon;
    const hasBike = s => {
        const st = s.status || {};
        if (bikeType === 'regular') return (st.num_bikes_available_types?.mechanical ?? 0) > 0;
        if (bikeType === 'electric') return (st.num_bikes_available_types?.ebike ?? 0) > 0;
        return (st.num_bikes_available ?? 0) > 0;
    };
    results['bike-avail'] = findNearest(currentBikes, hasBike, getLat, getLon);
    results['bike-dock'] = findNearest(currentBikes, s => (s.status?.num_docks_available ?? 0) > 0, getLat, getLon);
}

function clearCaches() {
    try {
        localStorage.removeItem(BIKE_CACHE_KEY);
    } catch (e) {
        // Storage unavailable — nothing to clear.
    }
    
    // Clear Service Worker Caches
    if ('caches' in window) {
        caches.keys().then(names => {
            for (let name of names) {
                caches.delete(name);
            }
        });
    }
}

function initMenu() {
    const btn = document.getElementById('menu-btn');
    const btnBar = document.getElementById('menu-btn-bar');
    const dropdown = document.getElementById('menu-dropdown');
    const overlay = document.getElementById('menu-overlay');
    if (!btn || !dropdown) return;

    const close = () => {
        dropdown.hidden = true;
        if (overlay) overlay.hidden = true;
        [btn, btnBar].forEach(b => b && b.setAttribute('aria-expanded', 'false'));
    };

    const toggle = (e) => {
        e.stopPropagation();
        const willBeHidden = !dropdown.hidden;
        dropdown.hidden = willBeHidden;
        if (overlay) overlay.hidden = willBeHidden;
        [btn, btnBar].forEach(b => b && b.setAttribute('aria-expanded', String(!willBeHidden)));
    };

    btn.addEventListener('click', toggle);
    if (btnBar) btnBar.addEventListener('click', toggle);

    if (overlay) {
        overlay.addEventListener('click', close);
    }

    document.addEventListener('click', e => {
        if (dropdown.hidden) return;
        if (e.target === btn || e.target === btnBar || e.target.closest('#menu-dropdown')) return;
        close();
    });

    const options = dropdown.querySelectorAll('.bike-type-option');
    const setActive = type => options.forEach(o => o.classList.toggle('active', o.dataset.bikeType === type));
    setActive(getBikeTypePref());

    options.forEach(opt => opt.addEventListener('click', () => {
        const type = opt.dataset.bikeType;
        setBikeTypePref(type);
        setActive(type);
        if (appResults && Object.keys(appResults).length > 0) {
            computeBikeResults(appResults);
            renderResults(appResults, true);
        }
    }));

    const ttcToggle = document.getElementById('hide-ttc-toggle');
    if (ttcToggle) {
        ttcToggle.checked = getHideTtcPref();
        ttcToggle.addEventListener('change', () => {
            setHideTtcPref(ttcToggle.checked);
            if (appResults && Object.keys(appResults).length > 0) {
                renderResults(appResults, true);
            }
        });
    }

    const adultToggle = document.getElementById('adult-skate-toggle');
    adultToggle.checked = getAdultSkatePref();
    adultToggle.addEventListener('change', async () => {
        setAdultSkatePref(adultToggle.checked);
        if (appResults && Object.keys(appResults).length > 0) {
            const { nearestSkating: sk } = await fetchLiveEvents();
            appResults['skating'] = sk 
                ? { distance: sk.distance, title: sk.overrideName, subtitle: sk.title, isActive: sk.isActive }
                : { distance: null, title: "No drop-in today", isActive: false };
            renderResults(appResults, true);
        }
    });

    const clearBtn = dropdown.querySelector('#clear-cache-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearCaches();
            currentBikes = null;
            close();
            updateLocationStatus('Caches cleared. Refreshing...', 'success');
            fetchAllData();
        });
    }
}

function getCachedBikes() {
    const entry = readCache(BIKE_CACHE_KEY);
    if (!entry || !Array.isArray(entry.data) || !entry.data.length) return null;
    return { data: entry.data, fresh: Date.now() - entry.timestamp < BIKE_MAX_AGE };
}

async function fetchBikeShareLive() {
    const [info, statusData] = await Promise.all([
        fetch(BIKE_INFO_URL).then(r => {
            if (!r.ok) throw new Error(`Bike info request failed (${r.status})`);
            return r.json();
        }).then(d => d.data.stations),
        fetch(BIKE_STATUS_URL).then(r => {
            if (!r.ok) throw new Error(`Bike status request failed (${r.status})`);
            return r.json();
        })
    ]);

    const statusMap = {};
    statusData.data.stations.forEach(s => {
        statusMap[s.station_id] = s;
    });

    return info.map(station => ({
        ...station,
        status: statusMap[station.station_id] || { num_bikes_available: 0, num_docks_available: 0 }
    }));
}

// Always fetch fresh data first. Fallback to cache only if network fails.
async function fetchBikeShareData(onUpdate) {
    try {
        const fresh = await fetchBikeShareLive();
        writeCache(BIKE_CACHE_KEY, { timestamp: Date.now(), data: fresh });
        onUpdate(fresh);
    } catch (err) {
        console.warn("Live bike fetch failed, falling back to cache", err);
        const cached = getCachedBikes();
        if (cached && cached.data) {
            onUpdate(cached.data);
        } else {
            console.error("No cached bike data available.");
        }
    }
}

// --- TTC tram stop names carry the direction ---
function tagStopDirectionByName(stop) {
    const name = (stop.tags?.name || '').toLowerCase();
    if (name.includes('eastbound') || name.includes('westbound')) {
        stop.isEW = true;
    } else if (name.includes('northbound') || name.includes('southbound')) {
        stop.isNS = true;
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

function bikeStatusText(item, cardId) {
    if (!item.status) return '';
    const s = item.status;
    if (cardId === 'bike-avail') {
        const mech = s.num_bikes_available_types?.mechanical ?? 0;
        const ebike = s.num_bikes_available_types?.ebike ?? 0;
        return `${mech} regular · ${ebike} electric`;
    }
    if (cardId === 'bike-dock') {
        const docks = s.num_docks_available ?? 0;
        return `${docks} docks`;
    }
    return '';
}

function renderFacilityItem(config, results, isDone) {
    const item = results[config.id];
    const isAndroid = /Android/i.test(navigator.userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

    if (item === undefined) {
        if (isDone) {
            return `
                <div class="facility-item" style="border-color: rgba(239, 68, 68, 0.3);">
                    <div class="facility-icon" style="color: #EF4444;"><i class="fa-solid fa-triangle-exclamation"></i></div>
                    <div class="facility-details">
                        <div class="facility-name">${config.name}</div>
                        <div class="facility-meta" style="color: #EF4444;">Error loading data</div>
                    </div>
                </div>`;
        }
        return skeletonItem(config);
    }

    if (!item) {
        return `
            <div class="facility-item" style="opacity: 0.6">
                <div class="facility-icon" style="color: ${config.color}"><i class="fa-solid ${config.icon}"></i></div>
                <div class="facility-details">
                    <div class="facility-name">${config.name}</div>
                    <div class="facility-meta">None found nearby</div>
                </div>
            </div>`;
    }

    const d = item.distance;
    const bearing = getBearing(userLat, userLon, item.origLat, item.origLon);
    const mapUrl = isAndroid
        ? `google.navigation:q=${item.origLat},${item.origLon}&mode=w`
        : isIOS
            ? `comgooglemaps://?daddr=${item.origLat},${item.origLon}&directionsmode=walking`
            : `https://www.google.com/maps/dir/?api=1&destination=${item.origLat},${item.origLon}&travelmode=walking`;

    const isBike = config.id === 'bike-avail' || config.id === 'bike-dock';
    const isTransit = config.id.startsWith('ttc-');
    const bikeAppUrl = isAndroid
        ? 'intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.lyft.android.torontoapp;end'
        : 'https://bikesharetoronto.com/';
    const walletAppUrl = isAndroid
        ? 'intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.google.android.apps.walletnfcrel;end'
        : null;

    let iconHref = null;
    if (config.id === 'np-square') {
        iconHref = "https://www.toronto.ca/services-payments/venues-facilities-bookings/booking-city-facilities/city-squares/nathan-phillips-square/events-happening-on-nathan-phillips-square/";
    } else if (config.id === 'skating') {
        iconHref = "https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/ice-snow-activities/public-leisure-skating/";
    } else if (isAndroid || isIOS) {
        if (isBike) iconHref = bikeAppUrl;
        else if (isTransit) iconHref = walletAppUrl;
    }

    const iconStyles = `color: ${config.color}; padding: 1.1rem 1rem 1.1rem 1.25rem; margin-right: 1rem; text-decoration: none; display: flex; align-items: center; justify-content: center;`;
    const iconHtml = `<i class="fa-solid ${config.icon}"></i>`;
    const targetAttr = (!isAndroid && !isIOS) ? 'target="_blank"' : '';

    return `
        <div class="facility-item" style="padding: 0; display: flex;">
            ${iconHref 
                ? `<a href="${iconHref}" ${targetAttr} class="facility-icon" style="${iconStyles}">${iconHtml}</a>` 
                : `<div class="facility-icon" style="${iconStyles}" onclick="event.preventDefault(); event.stopPropagation();">${iconHtml}</div>`
            }
            
            <a href="${mapUrl}" ${targetAttr} data-nav-type="${isAndroid ? 'android' : isIOS ? 'ios' : 'web'}" data-name="${config.name}" style="flex: 1; display: flex; align-items: center; padding: 1.1rem 1.25rem 1.1rem 0; color: inherit; text-decoration: none; min-width: 0;">
                <div class="facility-details" style="flex: 1; min-width: 0;">
                    <div class="facility-name">${item.overrideName || config.name}</div>
                    <div class="facility-meta" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; ${item.isActive && config.id !== 'skating' ? 'color: var(--success-color); font-weight: 500;' : ''}">${item.title}</div>
                    ${item.subtitle ? `<div class="facility-status" style="${item.isActive && config.id === 'skating' ? 'color: var(--success-color); font-weight: 500;' : 'color: var(--text-secondary); font-weight: 400;'}">${item.subtitle}</div>` : ''}
                    ${item.fallback ? `<div class="facility-status">Nearest stop · direction unknown</div>` : ''}
                    ${item.status ? `<div class="facility-status">${bikeStatusText(item, config.id)}</div>` : ''}
                </div>
                <div class="facility-distance" style="margin-left: 0.5rem; text-align: right; ${d == null ? 'opacity: 0;' : ''}">
                    <div class="distance-value">${formatDistance(d)}</div>
                    <div class="direction-compass">
                        <i class="fa-solid fa-location-arrow compass-arrow" style="transform: rotate(${bearing - 45}deg);"></i>
                        <i class="fa-solid fa-chevron-right" style="font-size: 0.7rem; opacity: 0.5;"></i>
                    </div>
                </div>
            </a>
        </div>`;
}

function renderResults(results, isDone = false) {
    const list = document.getElementById('facilities-list');
    const hideTtc = getHideTtcPref();

    list.innerHTML = facilityGroups.map(group => {
        if (group === 'ttc' && hideTtc) return '';
        const configs = facilitiesConfigs.filter(c => c.group === group);
        const items = configs.map(config => renderFacilityItem(config, results, isDone));
        return `<div class="facility-group glass-card">${items.join('<div class="group-divider"></div>')}</div>`;
    }).join('');
}

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then(reg => {
            console.log('Service Worker registered!', reg);
        }).catch(err => {
            console.warn('Service Worker registration failed:', err);
        });
    });
}
