const OVERPASS_ENDPOINTS = [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter'
];

async function test() {
    const combinedQuery = `
        (
            node["railway"="tram_stop"](around:300, 43.64, -79.39);
            node["amenity"="library"](around:600, 43.64, -79.39);
            node["leisure"="park"](around:600, 43.64, -79.39);
            way["leisure"="park"](around:600, 43.64, -79.39);
            node["brand"="Tim Hortons"](around:600, 43.64, -79.39);
        );
    `;
    const body = `[out:json][timeout:15];${combinedQuery}out center;`;
    
    console.log("Testing:", OVERPASS_ENDPOINTS[0]);
    try {
        const res = await fetch(OVERPASS_ENDPOINTS[0], {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'HowFarApp/1.0'
            },
            body: 'data=' + encodeURIComponent(body)
        });
        console.log("Status:", res.status);
        const text = await res.text();
        console.log("Response length:", text.length, "StartsWith:", text.substring(0, 100).replace(/\n/g, ' '));
    } catch (e) {
        console.error("Error:", e.message);
    }
}
test();
