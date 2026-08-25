# Copyright (C) 2026 Yoav
# SPDX-License-Identifier: GPL-3.0-or-later

import requests
import json
import zipfile
import csv
import io
import os
import sys
import time

def process_gtfs():
    print("Downloading GTFS data...")
    url = "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/b811ead4-6eaf-4adb-8408-d389fb5a069c/resource/c920e221-7a1c-488b-8c5b-6d8cd4e85eaf/download/Complete%20GTFS.zip"
    r = requests.get(url)
    print("Extracting GTFS data...")
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        z.extractall("gtfs_data")

    # 1. Find Streetcar routes (route_type = '0')
    streetcar_routes = set()
    with open('gtfs_data/routes.txt', 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['route_type'] == '0':
                streetcar_routes.add(row['route_id'])

    # 2. Parse trips
    trip_directions = {} # trip_id -> direction ('NS' or 'EW')
    valid_shape_ids = set()
    with open('gtfs_data/trips.txt', 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['route_id'] in streetcar_routes:
                headsign = row['trip_headsign'].lower()
                direction = 'EW' if 'east' in headsign or 'west' in headsign else 'NS'
                trip_directions[row['trip_id']] = direction
                valid_shape_ids.add(row['shape_id'])

    # 3. Parse shapes
    shapes = {} # shape_id -> list of {lat, lon}
    with open('gtfs_data/shapes.txt', 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            shape_id = row['shape_id']
            if shape_id in valid_shape_ids:
                if shape_id not in shapes:
                    shapes[shape_id] = []
                shapes[shape_id].append({
                    'seq': int(row['shape_pt_sequence']),
                    'lat': float(row['shape_pt_lat']),
                    'lon': float(row['shape_pt_lon'])
                })

    # Removed tram tracks as they are not used on the frontend

    # 4. Parse stop times
    stop_dirs = {}
    with open('gtfs_data/stop_times.txt', 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            trip_id = row['trip_id']
            if trip_id in trip_directions:
                stop_id = row['stop_id']
                if stop_id not in stop_dirs:
                    stop_dirs[stop_id] = {'isNS': False, 'isEW': False}
                if trip_directions[trip_id] == 'NS':
                    stop_dirs[stop_id]['isNS'] = True
                else:
                    stop_dirs[stop_id]['isEW'] = True

    # 5. Parse stops
    tram_stops = []
    with open('gtfs_data/stops.txt', 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            stop_id = row['stop_id']
            if stop_id in stop_dirs:
                tram_stops.append({
                    'id': stop_id,
                    'lat': float(row['stop_lat']),
                    'lon': float(row['stop_lon']),
                    'tags': {'name': row['stop_name']},
                    'isNS': stop_dirs[stop_id]['isNS'],
                    'isEW': stop_dirs[stop_id]['isEW']
                })
                
    # Cleanup temp gtfs folder
    import shutil
    shutil.rmtree('gtfs_data')

    return tram_stops

def process_parks():
    print("Downloading Toronto Parks GeoJSON...")
    url = "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/9a284a84-b9ff-484b-9e30-82f22c1780b9/resource/7a26629c-b642-4093-b33c-a5a21e4f3d22/download/green-spaces-4326.geojson"
    r = requests.get(url)
    geojson = r.json()
    
    park_ways = []
    
    import statistics
    for f in geojson.get("features", []):
        props = f.get("properties", {})
        cls = props.get("AREA_CLASS", "")
        if cls not in ["Park", "Open Green Space"]:
            continue
            
        geom = f.get("geometry", {})
        if not geom: continue
        coords = geom.get("coordinates", [])
        if not coords: continue
            
        if geom["type"] == "MultiPolygon":
            points = coords[0][0]
        elif geom["type"] == "Polygon":
            points = coords[0]
        else:
            continue
            
        lats = [p[1] for p in points]
        lons = [p[0] for p in points]
        center_lat = statistics.mean(lats)
        center_lon = statistics.mean(lons)
        
        park_ways.append({
            "id": str(props.get("AREA_ID") or props.get("_id") or props.get("OBJECTID")),
            "lat": center_lat,
            "lon": center_lon,
            "tags": {"name": props.get("AREA_NAME", "").title()}
        })
        
    return park_ways

def fetch_overpass_grid():
    headers = {'User-Agent': 'HowFar-Toronto-Generator (Author: Yoav Dim)'}
    lat_min, lat_max = 43.50, 43.90
    lon_min, lon_max = -79.75, -78.90
    d_lat = (lat_max - lat_min) / 5
    d_lon = (lon_max - lon_min) / 5
    
    all_elements = []
    failed = []

    def make_query(bbox):
        return f"""[out:json];
        (
            nwr["railway"="station"]["network"~"TTC"]({bbox});
            nwr["railway"="station"]["operator"~"TTC"]({bbox});
            nwr["amenity"="library"]({bbox});
            nwr["brand"~"Tim Hortons",i]({bbox});
            nwr["name"~"Tim Hortons",i]({bbox});
        );
        out center;"""

    def try_fetch(bbox, label=""):
        q = make_query(bbox)
        print(f"{label}Fetching POIs in {bbox}...")
        try:
            r = requests.post("https://overpass.private.coffee/api/interpreter", data={'data': q}, headers=headers, timeout=65)
            if r.status_code == 200:
                elements = r.json().get("elements", [])
                all_elements.extend(elements)
                print(f"  -> {len(elements)} results")
                return True
            else:
                print(f"  -> HTTP {r.status_code}")
        except Exception as e:
            print(f"  -> Error: {e}")
        return False

    for i in range(5):
        for j in range(5):
            b_lat_min = lat_min + i * d_lat
            b_lon_min = lon_min + j * d_lon
            bbox = f"{b_lat_min:.3f},{b_lon_min:.3f},{b_lat_min + d_lat:.3f},{b_lon_min + d_lon:.3f}"
            if not try_fetch(bbox):
                failed.append(bbox)
            time.sleep(5)

    # Retry failed cells after a pause
    still_failed = []
    if failed:
        print(f"\nRetrying {len(failed)} failed cells after 180s...")
        time.sleep(180)
        for bbox in failed:
            if not try_fetch(bbox, label="[retry] "):
                still_failed.append(bbox)
            time.sleep(5)
        if still_failed:
            print(f"Warning: {len(still_failed)} cells still failed after retry")

    # Deduplicate elements by ID
    dedup = {e['id']: e for e in all_elements}.values()
    return list(dedup), still_failed

def clean_element(e):
    lat = e.get("lat")
    if lat is None and "center" in e:
        lat = e["center"].get("lat")
    if lat is None and "bounds" in e:
        lat = (e["bounds"].get("minlat") + e["bounds"].get("maxlat")) / 2

    lon = e.get("lon")
    if lon is None and "center" in e:
        lon = e["center"].get("lon")
    if lon is None and "bounds" in e:
        lon = (e["bounds"].get("minlon") + e["bounds"].get("maxlon")) / 2
    
    obj = {
        "id": e.get("id"),
        "lat": lat,
        "lon": lon,
        "tags": e.get("tags", {})
    }
    
    # Fallback to first geometry node if available (e.g. from out geom)
    if obj["lat"] is None and "geometry" in e and len(e["geometry"]) > 0:
        obj["lat"] = e["geometry"][0]["lat"]
        obj["lon"] = e["geometry"][0]["lon"]
        
    return obj

def main():
    print("--- Starting HowFar Toronto Data Generator ---")
    
    # 1. Fetch GTFS Streetcars
    tram_stops = process_gtfs()
    print(f"GTFS Processing Complete: {len(tram_stops)} tram stops.")
    
    # 2. Fetch Parks from GeoJSON
    park_ways = process_parks()
    print(f"Parks Processing Complete: {len(park_ways)} parks retrieved.")
    
    # 3. Fetch other POIs via Overpass
    elements, overpass_failures = fetch_overpass_grid()
    print(f"Overpass Processing Complete: {len(elements)} total POIs retrieved.")
    
    if overpass_failures:
        print(f"ERROR: {len(overpass_failures)} grid cells failed after retry. Aborting — not overwriting toronto_data.json")
        sys.exit(1)
    
    
    # Organize data
    libraries = [n for n in elements if n.get("tags", {}).get("amenity") == "library" and ("toronto public library" in n.get("tags", {}).get("operator", "").lower() or "toronto public library" in n.get("tags", {}).get("name", "").lower())]
    tims = [n for n in elements if "tim hortons" in n.get("tags", {}).get("brand", "").lower() or "tim hortons" in n.get("tags", {}).get("name", "").lower()]
    metro = [n for n in elements if n.get("tags", {}).get("railway") == "station" and ("ttc" in n.get("tags", {}).get("network", "").lower() or "ttc" in n.get("tags", {}).get("operator", "").lower())]

    import datetime
    
    final_data = {
        "lastUpdated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "metro": [clean_element(n) for n in metro],
        "tramStops": tram_stops,
        "libraries": [clean_element(n) for n in libraries],
        "parkNodes": [],
        "parkWays": park_ways,
        "timHortons": [clean_element(n) for n in tims]
    }
    
    with open('toronto_data.json', 'w') as f:
        json.dump(final_data, f, separators=(',', ':'))
        
    print(f"Successfully saved toronto_data.json!")
    
if __name__ == "__main__":
    main()
