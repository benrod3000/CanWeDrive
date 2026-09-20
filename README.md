# Can We Cart

Can We Cart answers a pretty simple question:

**Can we take the cart there?**

It is a free map and routing tool for street-legal LSVs and golf carts in North County San Diego.

The idea is not to make another generic map app. It is to show what the route is actually like before you get in the cart.

## What it does

Enter a starting point and destination and Can We Cart checks the available road network against California's 35 MPH LSV rule.

The result shows:

- whether a route was found
- estimated trip time
- total distance
- elevation gain and loss
- steepest uphill and downhill grades
- an elevation profile
- how much of the route has mapped speed data
- how much of the route falls into each speed range
- streets where the available data is unknown
- other things worth knowing about the route

The map also shows the route itself, including eligible, unknown, and blocked sections.

## The important part

This is a data tool, not a legal oracle.

A road with no usable speed data is marked **UNKNOWN**. That does not mean the road is illegal. It means we do not have enough data to verify it.

Likewise, mapped speed data is not a replacement for looking at the actual signs or checking local restrictions.

The goal is to make the uncertainty visible instead of pretending the map knows more than it does.

## Where it works

The current focus is North County San Diego:

- Carlsbad
- Encinitas
- Oceanside

The road network is stored in Supabase/PostGIS and routed with pgRouting. Road speed and access information comes from OpenStreetMap data that has been imported into the routing graph.

Terrain information comes from Open-Meteo elevation data.

The app runs on Next.js and MapLibre and is deployed through Vercel.

## Project status

This is still being built.

The routing engine, road graph, map, address search, route analysis, elevation profile, speed exposure, and trip-time estimate are all working. The next round of work is about making the route information more useful, not turning this into a giant dashboard.

## Running it locally

```bash
npm install
npm run dev
```

Then open the local Next.js address shown in the terminal.

Build and production checks run through GitHub Actions.

## Cost

The project is intentionally built around a $0/month stack.

There are no paid routing APIs or paid map subscriptions in the current architecture.

## One more thing

The name may change again. The product is still taking shape.

For now, it is **Can We Cart**.

