# CanWeDrive

A map and routing tool for finding streets and routes that are legal and practical for LSVs, golf carts, and other low-speed vehicles.

## Current build

CanWeDrive currently covers three North County starting points:

- Carlsbad Village
- Encinitas
- Oceanside Harbor

The route checker uses OSRM for the driving path and OpenStreetMap/Overpass for posted-speed tags. A route is treated conservatively:

- **Eligible**: every matched road segment has mapped speed data at 35 MPH or less.
- **Unknown**: any part of the route lacks usable posted-speed data.
- **Blocked**: any matched road segment is mapped above 35 MPH.

This is a data-based research tool, not a substitute for checking posted signs, local restrictions, or California law.

## Architecture

- Next.js App Router
- MapLibre GL
- OpenFreeMap basemap
- OSRM routing
- OpenStreetMap + Overpass speed data
- Supabase/PostGIS road-data store for the next network-data phase
- Vercel-compatible Node runtime

## Road-data model

Supabase contains the source-of-truth tables for road segments, independent speed verifications, and vehicle profiles. The production routing network will use those records rather than treating missing OSM tags as permission.

## Development

```bash
npm install
npm run dev
```

Build verification runs through GitHub Actions on pushes and pull requests to `main`.
