const https = require('https');

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function getBearing(lat1, lon1, lat2, lon2) {
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) -
              Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
    const theta = Math.atan2(y, x);
    return (theta * 180 / Math.PI + 360) % 360;
}

function fetchOverpassQuery(queryBody, isRaw) {
    return new Promise((resolve, reject) => {
        const body = isRaw ? `[out:json][timeout:15];${queryBody}` : `[out:json][timeout:15];(${queryBody});out center;`;
        
        const req = https.request('https://overpass.private.coffee/api/interpreter', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'HowFar-TestScript/1.0 (test@example.com)'
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch(e) {
                    console.error("Parse error, response was:", data.substring(0, 500));
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write('data=' + encodeURIComponent(body));
        req.end();
    });
}

async function test() {
    // Spadina & Queen intersection
    const userLat = 43.6489;
    const userLon = -79.3965;
    
    console.log("Fetching stops near Spadina & Queen...");
    const stopsData = await fetchOverpassQuery(`node["railway"="tram_stop"](around:2000, ${userLat}, ${userLon});`, false);
    let stops = stopsData.elements || [];
    console.log(`Got ${stops.length} stops.`);
    
    stops.forEach(t => t.dist = getDistance(userLat, userLon, t.lat, t.lon));
    stops.sort((a, b) => a.dist - b.dist);
    
    const topStops = stops.slice(0, 8);
    const ids = topStops.map(s => s.id).join(',');
    const query = `node(id:${ids})->.s;way(around.s:25)["railway"="tram"];out geom;`;

    console.log("Fetching tracks for top stops...");
    try {
        const data = await fetchOverpassQuery(query, true);
        const ways = data.elements.filter(e => e.type === 'way' && e.geometry && e.geometry.length >= 2);
        console.log(`Got ${ways.length} nearby tram ways.`);

        topStops.forEach(stop => {
            let closestWay = null;
            let minDistance = Infinity;

            ways.forEach(w => {
                w.geometry.forEach(g => {
                    const d = getDistance(stop.lat, stop.lon, g.lat, g.lon);
                    if (d < minDistance) {
                        minDistance = d;
                        closestWay = w;
                    }
                });
            });

            if (!closestWay || minDistance > 25) {
                console.log(`[!] Stop ${stop.tags.name} (${stop.id}) -> NO TRACK FOUND (Min distance: ${minDistance})`);
                return;
            }

            const first = closestWay.geometry[0];
            const last = closestWay.geometry[closestWay.geometry.length - 1];
            if (first.lat === last.lat && first.lon === last.lon) return;

            const bearing = getBearing(first.lat, first.lon, last.lat, last.lon);
            const normalized = ((bearing % 180) + 180) % 180;
            
            let dir = "NS";
            if (normalized >= 45 && normalized <= 135) dir = "EW";

            console.log(`[OK] Stop ${stop.tags.name} (${stop.id}) -> ${dir} (Min distance to track: ${minDistance.toFixed(1)}m, Bearing: ${Math.round(normalized)}°)`);
        });
    } catch (e) {
        console.error("Failed to resolve tram directions", e);
    }
}
test();
