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
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
}

// Data structures for the UI
const facilitiesConfigs = [
    { id: 'bike-avail', name: 'Bikes', icon: 'fa-bicycle', color: '#38BDF8' },
    { id: 'bike-dock', name: 'Docks', icon: 'fa-square-parking', color: '#38BDF8' },
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
    renderSkeletonCards();
    initMenu();

    const fallbackLocation = async () => {
        updateLocationStatus("GPS blocked. Fetching approximate location via IP...", "error");
        try {
            const res = await fetch('https://ipapi.co/json/');
            const data = await res.json();
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

        updateLocationStatus("Could not determine location. Please enable GPS or use HTTPS.", "error");
    };

    if ("geolocation" in navigator) {
        const timeoutId = setTimeout(() => {
            fallbackLocation();
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
                console.warn("GPS Error:", error);
                fallbackLocation();
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
        );
    } else {
        fallbackLocation();
    }
});

function updateLocationStatus(msg, statusClass = "") {
    const el = document.getElementById('location-status');
    el.style.display = '';
    el.innerHTML = `<i class="fa-solid fa-location-dot"></i> ${msg}`;
    el.className = `location-status ${statusClass}`;
}

async function initWeather(lat, lon) {
    try {
        // Fetch weather for live location
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
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
                    updatedEl.textContent = `Last updated: ${date.toLocaleString()}`;
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

    await Promise.allSettled([overpassPromise, bikePromise]);

    appDone = true;
    computeCards();
    render();
    statusEl.style.display = 'none';
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
    const dropdown = document.getElementById('menu-dropdown');
    const overlay = document.getElementById('menu-overlay');
    if (!btn || !dropdown) return;

    const close = () => {
        dropdown.hidden = true;
        if (overlay) overlay.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    };

    btn.addEventListener('click', e => {
        e.stopPropagation();
        const willBeHidden = !dropdown.hidden;
        dropdown.hidden = willBeHidden;
        if (overlay) overlay.hidden = willBeHidden;
        btn.setAttribute('aria-expanded', String(!willBeHidden));
    });

    if (overlay) {
        overlay.addEventListener('click', close);
    }

    document.addEventListener('click', e => {
        if (dropdown.hidden) return;
        if (e.target === btn || e.target.closest('#menu-dropdown')) return;
        close();
    });

    const options = dropdown.querySelectorAll('.bike-type-option');
    const setActive = type => options.forEach(o => o.classList.toggle('active', o.dataset.bikeType === type));
    setActive(getBikeTypePref());

    options.forEach(opt => opt.addEventListener('click', () => {
        const type = opt.dataset.bikeType;
        setBikeTypePref(type);
        setActive(type);
        if (currentBikes) {
            computeBikeResults(appResults);
            renderResults(appResults, appDone);
        }
    }));

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

function renderResults(results, isDone = false) {
    const list = document.getElementById('facilities-list');
    list.innerHTML = '';

    facilitiesConfigs.forEach(config => {
        const item = results[config.id];

        if (item === undefined) {
            if (isDone) {
                // The global fetch has finished, so if this is still undefined, the API failed
                list.innerHTML += `
                    <div class="facility-card glass-card" style="border-color: rgba(239, 68, 68, 0.3);">
                        <div class="facility-icon" style="color: #EF4444;"><i class="fa-solid fa-triangle-exclamation"></i></div>
                        <div class="facility-details">
                            <div class="facility-name">${config.name}</div>
                            <div class="facility-meta" style="color: #EF4444;">Error loading data</div>
                        </div>
                    </div>
                `;
            } else {
                // Still loading — keep a skeleton so cards never flicker to "none found".
                list.innerHTML += skeletonCard(config);
            }
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
        const isAndroid = /Android/i.test(navigator.userAgent);
        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        const mapUrl = isAndroid
            ? `google.navigation:q=${item.origLat},${item.origLon}&mode=w`
            : isIOS
                ? `comgooglemaps://?daddr=${item.origLat},${item.origLon}&directionsmode=walking`
                : `https://www.google.com/maps/dir/?api=1&destination=${item.origLat},${item.origLon}&travelmode=walking`;

        list.innerHTML += `
            <a href="${mapUrl}" class="facility-card glass-card" data-nav-type="${isAndroid ? 'android' : isIOS ? 'ios' : 'web'}" data-name="${config.name}">
                <div class="facility-icon" style="color: ${config.color}"><i class="fa-solid ${config.icon}"></i></div>
                <div class="facility-details">
                    <div class="facility-name">${config.name}</div>
                    <div class="facility-meta">${item.title}</div>
                    ${item.fallback ? `<div class="facility-status">Nearest stop · direction unknown</div>` : ''}
                    ${item.status ? `<div class="facility-status">${bikeStatusText(item, config.id)}</div>` : ''}
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
