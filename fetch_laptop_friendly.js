#!/usr/bin/env node
// Scrapes Laptop Friendly's Toronto directory every four weeks for the app's venue data.
// Venue pages server-render coordinates in JSON-LD and a seven-day hours table,
// so this does not need browser automation or a geocoding service.

const fs = require('fs');
const fetch = require('node-fetch');

const DIRECTORY_URL = 'https://laptopfriendly.co/toronto';
const BASE_URL = 'https://laptopfriendly.co';
const OUT_FILE = 'toronto_laptop_friendly.json';
const FOUR_WEEKS_MS = 4 * 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;
const MIN_VENUES = 25;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const USER_AGENT = 'HowFar-Toronto/1.0 (+https://github.com/yoavdim/HowFar)';

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#(?:39|x27);/gi, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&ndash;/g, '–')
        .replace(/&mdash;/g, '—');
}

function textFromHtml(value) {
    return decodeHtml(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchHtml(url) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response.text();
}

function extractVenuePaths(directoryHtml) {
    const paths = new Set();
    for (const match of directoryHtml.matchAll(/href=["'](\/toronto\/[^"'#?]+)["']/g)) {
        paths.add(match[1]);
    }
    return [...paths];
}

function extractJsonLd(html) {
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const parsed = JSON.parse(match[1]);
            const entries = Array.isArray(parsed) ? parsed : [parsed];
            const venue = entries.find(entry => entry && entry.name && entry.geo);
            if (venue) return venue;
        } catch (_) {
            // Ignore unrelated or malformed structured-data blocks.
        }
    }
    return null;
}

function extractHours(html) {
    const section = html.match(/<div[^>]+id=["']hours-display["'][^>]*>([\s\S]*?)<div[^>]+class=["'][^"']*hours-note/i)?.[1];
    if (!section) return {};

    const hours = {};
    const rowPattern = /<div[^>]+class=["'][^"']*row[^"']*["'][^>]*>\s*<div[^>]*>(Mon|Tue|Wed|Thu|Fri|Sat|Sun)<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    for (const match of section.matchAll(rowPattern)) {
        hours[match[1].toLowerCase()] = textFromHtml(match[2]);
    }

    if (!Object.keys(hours).length) {
        const value = textFromHtml(section).replace(/Edit hours$/i, '').trim();
        if (value === 'Open 24 hours' || value === 'Unknown') {
            for (const day of DAYS) hours[day] = value;
        }
    }
    return hours;
}

function isVenueWellFormatted(venue) {
    const hourValue = /^(?:Unknown|Closed|Open 24 hours|(?:[01]\d|2[0-3]):[0-5]\d – (?:[01]\d|2[0-3]):[0-5]\d)$/;
    return typeof venue?.name === 'string'
        && venue.name.length > 0
        && venue.name.length < 200
        && Number.isFinite(venue.lat)
        && venue.lat >= 42.5 && venue.lat <= 44.5
        && Number.isFinite(venue.lon)
        && venue.lon >= -80.5 && venue.lon <= -78.5
        && typeof venue.address === 'string'
        && venue.address.length > 0
        && typeof venue.url === 'string'
        && venue.url.startsWith(`${BASE_URL}/toronto/`)
        && DAYS.every(day => hourValue.test(venue.hours?.[day] || ''));
}

function parseVenue(html, path) {
    const structured = extractJsonLd(html);
    if (!structured) throw new Error(`${path}: venue JSON-LD not found`);

    const lat = Number(structured.geo?.latitude);
    const lon = Number(structured.geo?.longitude);
    const addressParts = [
        structured.address?.streetAddress,
        structured.address?.addressLocality,
        structured.address?.postalCode,
    ].filter(Boolean);

    const venue = {
        name: textFromHtml(structured.name),
        lat,
        lon,
        address: addressParts.join(', '),
        url: new URL(path, BASE_URL).href,
        hours: extractHours(html),
    };
    if (!isVenueWellFormatted(venue)) {
        throw new Error(`${path}: venue fields failed the format sanity check`);
    }
    return venue;
}

async function mapConcurrent(items, limit, mapper) {
    const results = new Array(items.length);
    let next = 0;

    async function worker() {
        while (next < items.length) {
            const index = next++;
            results[index] = await mapper(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function readOutput() {
    try {
        return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    } catch (_) {
        return null;
    }
}

function hasUsableOutput() {
    const data = readOutput();
    return Array.isArray(data?.venues)
        && data.venues.length >= MIN_VENUES
        && data.venues.every(isVenueWellFormatted);
}

function recentOutput() {
    if (process.argv.includes('--force')) return false;
    const data = readOutput();
    const fetchedAt = new Date(data?.lastUpdated).getTime();
    return Array.isArray(data?.venues)
        && data.venues.length >= MIN_VENUES
        && data.venues.every(isVenueWellFormatted)
        && Number.isFinite(fetchedAt)
        && Date.now() - fetchedAt < FOUR_WEEKS_MS;
}

async function main() {
    console.log('--- HowFar Laptop Friendly Fetcher ---');
    if (recentOutput()) {
        console.log(`${OUT_FILE} is less than four weeks old; skipping scrape.`);
        return;
    }

    const directoryHtml = await fetchHtml(DIRECTORY_URL);
    const paths = extractVenuePaths(directoryHtml);
    const previousCount = readOutput()?.venues?.length || 0;
    const minimumExpected = Math.max(MIN_VENUES, Math.floor(previousCount * 0.6));
    if (paths.length < minimumExpected) {
        throw new Error(`Found only ${paths.length} venue links (expected at least ${minimumExpected}); preserving previous output`);
    }
    console.log(`Found ${paths.length} Toronto venue pages.`);

    const venues = await mapConcurrent(paths, CONCURRENCY, async (path, index) => {
        const venue = parseVenue(await fetchHtml(new URL(path, BASE_URL).href), path);
        console.log(`[${index + 1}/${paths.length}] ${venue.name}`);
        return venue;
    });

    const valid = venues.filter(isVenueWellFormatted);
    if (valid.length !== paths.length) {
        throw new Error(`Parsed only ${valid.length} of ${paths.length} venues; preserving previous output`);
    }

    const output = {
        lastUpdated: new Date().toISOString(),
        source: DIRECTORY_URL,
        venues: valid,
    };
    const temporary = `${OUT_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(output));
    fs.renameSync(temporary, OUT_FILE);
    console.log(`Wrote ${OUT_FILE} with ${valid.length} venues.`);
}

main().catch(error => {
    if (hasUsableOutput()) {
        console.log(`::warning title=Laptop Friendly scraper failed::${error.message}. Deploying the previous venue data.`);
        return;
    }
    console.error(`::error title=Laptop Friendly scraper failed::${error.message}`);
    process.exitCode = 1;
});
