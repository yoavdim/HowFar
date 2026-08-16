const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
];

function makeEl() {
    const el = {
        _html: '', textContent: '', className: '', style: {}, dataset: {}, _hidden: false,
        set innerHTML(v) { this._html = v; },
        get innerHTML() { return this._html; },
        set hidden(v) { this._hidden = v; },
        get hidden() { return this._hidden; },
        addEventListener() {},
        setAttribute() {},
        closest() { return null; },
        classList: { toggle() {}, add() {}, remove() {} },
        querySelector() { return makeEl(); },
        querySelectorAll() { return []; }
    };
    return el;
}

// Shared mutable state visible both to the fetch mock (outer scope) and the
// test code running inside the vm context.
const state = { overpassMode: 'ok', bodies: [], bikeFetches: 0 };
const store = {};
const elements = {};

const localStorageMock = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
};
function el(id) { return elements[id] || (elements[id] = makeEl()); }

const sandbox = {
    console, localStorage: localStorageMock, elements, state,
    setTimeout, clearTimeout, process, AbortController,
    navigator: {
        userAgent: 'Mozilla/5.0 (Linux; Android 10)',
        geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 43.64, longitude: -79.39 } }) }
    }
};
const documentMock = {
    addEventListener: (ev, cb) => { if (ev === 'DOMContentLoaded') sandbox.domCb = cb; },
    getElementById: el
};
sandbox.document = documentMock;
sandbox.fetch = async (url, opts = {}) => {
    if (url.includes('open-meteo')) return jsonResp({ current_weather: { temperature: 21, weathercode: 0 } });
    if (url.includes('station_information')) {
        state.bikeFetches++;
        return jsonResp({ data: { stations: [{ station_id: '7000', name: 'Station A', lat: 43.64, lon: -79.38 }] } });
    }
    if (url.includes('station_status')) {
        return jsonResp({ data: { stations: [{ station_id: '7000', num_bikes_available: 3, num_docks_available: 2, num_bikes_available_types: { mechanical: 3, ebike: 0 } }] } });
    }
    if (OVERPASS.includes(url)) {
        const body = decodeURIComponent((opts.body || '').replace(/^data=/, ''));
        state.bodies.push(body);
        if (state.overpassMode === 'fail') throw new Error('overpass down');
        if (state.overpassMode === 'ok-fail-first' && url === 'https://overpass-api.de/api/interpreter') throw new Error('first mirror down');
        if (state.overpassMode === 'ok-delayed') await new Promise(r => setTimeout(r, 400));
        if (body.includes('around.s')) {
            if (state.overpassMode === 'ok-no-dir') throw new Error('direction query unreachable');
            return jsonResp({ elements: clone([tramWay]) });
        }
        if (state.overpassMode === 'ok-no-dir') return jsonResp({ elements: clone([metro, tramEB, tramNB, lib, parkNode, parkWay, tims]) });
        return jsonResp({ elements: clone([metro, tramStop, lib, parkNode, parkWay, tims]) });
    }
    throw new Error('unexpected url: ' + url);
};
function jsonResp(data) {
    return {
        ok: true, status: 200,
        json: async () => data,
        text: async () => JSON.stringify(data)
    };
}
const clone = o => JSON.parse(JSON.stringify(o));

const metro = { type: 'node', id: 100, lat: 43.65, lon: -79.40, tags: { railway: 'station', network: 'TTC', name: 'Union' } };
const tramStop = { type: 'node', id: 200, lat: 43.64, lon: -79.39, tags: { railway: 'tram_stop', name: 'Queen St W' } };
const lib = { type: 'node', id: 300, lat: 43.65, lon: -79.40, tags: { amenity: 'library', name: 'TPL Reference Library' } };
const parkNode = { type: 'node', id: 400, lat: 43.65, lon: -79.41, tags: { leisure: 'park', name: 'Trinity Bellwoods' } };
const parkWay = { type: 'way', id: 401, center: { lat: 43.65, lon: -79.41 }, tags: { leisure: 'park', name: 'Trinity Bellwoods' } };
const tims = { type: 'node', id: 500, lat: 43.65, lon: -79.39, tags: { brand: 'Tim Hortons', name: 'Tim Hortons' } };
// Track running due east, a few metres from the stop => isEW should be set.
const tramWay = { type: 'way', id: 600, geometry: [{ lat: 43.64, lon: -79.3902 }, { lat: 43.64, lon: -79.3898 }], tags: { railway: 'tram' } };
const tramEB = { type: 'node', id: 210, lat: 43.641, lon: -79.389, tags: { railway: 'tram_stop', name: 'Queen St W at Spadina Ave Eastbound' } };
const tramNB = { type: 'node', id: 220, lat: 43.642, lon: -79.388, tags: { railway: 'tram_stop', name: 'Spadina Ave at Queen St W Northbound' } };

vm.createContext(sandbox);

const testCode = `
(async () => {
    const results = {};
    const paint = () => elements['facilities-list'].innerHTML;
    // Overpass requests are serialized with a 2s gap, so a scenario's work can
    // finish after its fixed wait. Instead, wait until the expected number of
    // requests has fired (counts are per-scenario since bodies are cleared).
    const waitFor = async (targetBodies) => {
        const deadline = Date.now() + 30000;
        while (state.bodies.length < targetBodies && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 200));
        }
        await new Promise(r => setTimeout(r, 400));
    };

    // ===== Scenario 1: cold start (no caches) =====
    domCb();
    await waitFor(2); // merged (mirror 1) + direction (mirror 1)
    const s1html = paint();
    results['s1: metro title shown'] = s1html.includes('Union');
    results['s1: streetcar EW shown'] = s1html.includes('Queen St W');
    results['s1: streetcar NS falls back to nearest stop'] = (s1html.match(/None found nearby/g) || []).length === 0 && (s1html.match(/Queen St W/g) || []).length === 2;
    results['s1: fallback card is labelled'] = (s1html.match(/Nearest stop/g) || []).length === 1;
    results['s1: library shown'] = s1html.includes('TPL Reference Library');
    results['s1: park shown'] = s1html.includes('Trinity Bellwoods');
    results['s1: tim hortons shown'] = s1html.includes('Tim Hortons');
    results['s1: bike status shown'] = s1html.includes('3 regular') && s1html.includes('0 electric') && s1html.includes('2 docks');
    results['s1: no error cards'] = !s1html.includes('Error loading data');
    results['s1: no skeletons left'] = !s1html.includes('skeleton');
    results['s1: metro cache written'] = !!JSON.parse(localStorage.getItem('howfar-metro-stations')).stations;
    results['s1: bike cache written'] = !!JSON.parse(localStorage.getItem('bike_combined_cache')).data;
    const mergedBodyS1 = state.bodies[0] || '';
    const poiBodiesS1 = state.bodies.filter(b => !b.includes('around.s')).length;
    const dirBodiesS1 = state.bodies.filter(b => b.includes('around.s')).length;
    results['s1: merged query is a single program with all POIs'] =
        mergedBodyS1.includes('"network"~"TTC"') && mergedBodyS1.includes('railway"="tram_stop')
        && mergedBodyS1.includes('amenity"="library') && mergedBodyS1.includes('leisure"="park')
        && mergedBodyS1.includes('"brand"="Tim Hortons"')
        && (mergedBodyS1.match(/out center/g) || []).length === 1;
    results['s1: single mirror per query (no fan-out)'] = poiBodiesS1 === 1 && dirBodiesS1 === 1;

    // ===== Scenario 2: caches exist (bike stale), overpass delayed =====
    const oldTs = Date.now() - 10 * 60 * 1000;
    localStorage.setItem('bike_combined_cache', JSON.stringify({ timestamp: oldTs, data: [{ station_id: '7000', name: 'Station A', lat: 43.64, lon: -79.38, status: { num_bikes_available: 9, num_docks_available: 1 } }] }));
    state.bodies.length = 0;
    state.overpassMode = 'ok-delayed';
    const bikeFetchesBefore = state.bikeFetches;
    domCb();
    const s2early = paint();
    const earlySkeletons = (s2early.match(/facility-card glass-card skeleton/g) || []).length;
    results['s2 first paint: metro from cache'] = s2early.includes('Union');
    results['s2 first paint: bike from cache'] = s2early.includes('1 docks');
    results['s2 first paint: locals from POI cache'] = earlySkeletons === 0 && s2early.includes('Queen St W');
    await waitFor(2); // merged (mirror 1) + direction (mirror 1)
    const s2html = paint();
    results['s2 settled: locals populated'] = s2html.includes('Queen St W') && s2html.includes('Trinity Bellwoods');
    results['s2 settled: bg refresh replaced stale bikes'] = s2html.includes('3 regular') && s2html.includes('2 docks');
    results['s2: metro excluded from query while cache fresh'] = !(state.bodies[0] || '').includes('"network"~"TTC"');
    results['s2: poi cache written'] = !!JSON.parse(localStorage.getItem('howfar-poi-cache') || 'null');
    const bikeCache = JSON.parse(localStorage.getItem('bike_combined_cache'));
    results['s2: bg refresh updated cache timestamp'] = bikeCache.timestamp > oldTs;
    results['s2: bg refresh actually fetched'] = state.bikeFetches > bikeFetchesBefore;

    // ===== Scenario 3: overpass fully down, locals from POI cache =====
    state.bodies.length = 0;
    state.overpassMode = 'fail';
    domCb();
    await waitFor(3); // all 3 mirrors fail sequentially
    const s3html = paint();
    results['s3: metro still shown from cache'] = s3html.includes('Union');
    results['s3: locals from POI cache while overpass down'] =
        (s3html.match(/Error loading data/g) || []).length === 0 &&
        s3html.includes('Queen St W') && s3html.includes('Trinity Bellwoods');
    results['s3: bike still shown from cache'] = s3html.includes('3 regular') && s3html.includes('2 docks');

    // ===== Scenario 4: merged Overpass OK, direction follow-up unreachable =====
    // Directions must come from the stop names alone; no geometry query is sent.
    state.overpassMode = 'ok-no-dir';
    localStorage.removeItem('howfar-metro-stations');
    localStorage.removeItem('bike_combined_cache');
    state.bodies.length = 0;
    domCb();
    await waitFor(1); // merged only; no direction query sent
    const s4html = paint();
    const dirQueriesS4 = state.bodies.filter(b => b.includes('around.s')).length;
    results['s4: NS card from stop name'] = s4html.includes('Spadina Ave at Queen St W Northbound');
    results['s4: EW card from stop name'] = s4html.includes('Queen St W at Spadina Ave Eastbound');
    results['s4: no none-found on streetcar'] = !s4html.includes('None found nearby');
    results['s4: no direction query sent'] = dirQueriesS4 === 0;

    // ===== Scenario 5: primary mirror down, sequential fallback answers =====
    state.overpassMode = 'ok-fail-first';
    localStorage.removeItem('howfar-metro-stations');
    localStorage.removeItem('bike_combined_cache');
    state.bodies.length = 0;
    domCb();
    await waitFor(4); // merged (2 mirrors) + direction (2 mirrors)
    const s5html = paint();
    const mergedBodiesS5 = state.bodies.filter(b => !b.includes('around.s')).length;
    const dirBodiesS5 = state.bodies.filter(b => b.includes('around.s')).length;
    results['s5: data loaded despite primary mirror down'] = s5html.includes('Union') && s5html.includes('TPL Reference Library');
    results['s5: merged query hit exactly 2 mirrors'] = mergedBodiesS5 === 2;
    results['s5: direction query hit exactly 2 mirrors'] = dirBodiesS5 === 2;

    // ===== Scenario 6: expired / too-far POI cache is ignored =====
    const poiBase = JSON.parse(localStorage.getItem('howfar-poi-cache'));
    state.overpassMode = 'fail';
    state.bodies.length = 0;
    localStorage.setItem('howfar-poi-cache', JSON.stringify({ ...poiBase, fetched: Date.now() - 11 * 60 * 1000 }));
    domCb();
    await waitFor(3);
    const s6stale = paint();
    results['s6: >10min old POI cache ignored'] = (s6stale.match(/Error loading data/g) || []).length === 5;
    state.bodies.length = 0;
    localStorage.setItem('howfar-poi-cache', JSON.stringify({ ...poiBase, fetched: Date.now(), lat: 43.64, lon: -79.1 }));
    domCb();
    await waitFor(3);
    const s6far = paint();
    results['s6: >300m POI cache ignored'] = (s6far.match(/Error loading data/g) || []).length === 5;

    console.log(JSON.stringify(results, null, 2));
    const fails = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    console.log(fails.length ? 'FAILED: ' + fails.join(', ') : 'ALL PASS');
    process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
`;

vm.runInContext(APP + '\n' + testCode, sandbox);
