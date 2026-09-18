"use client";

import { useState } from "react";
import MapView from "../components/MapView";

const places = [
  "Carlsbad Village",
  "Encinitas",
  "Oceanside Harbor"
];

export default function Home() {
  const [from, setFrom] = useState(places[0]);
  const [to, setTo] = useState(places[1]);
  const [searched, setSearched] = useState(false);

  return (
    <main className="shell">
      <aside className="panel">
        <div className="brand">
          <div className="eyebrow">NORTH COUNTY · CALIFORNIA</div>
          <h1>CanWeDrive?</h1>
          <p>LSV routing without the guessing.</p>
        </div>

        <div className="route-box">
          <label>
            <span>FROM</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {places.map((place) => <option key={place}>{place}</option>)}
            </select>
          </label>

          <label>
            <span>TO</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {places.map((place) => <option key={place}>{place}</option>)}
            </select>
          </label>

          <button className="drive-button" onClick={() => setSearched(true)}>
            CAN WE DRIVE THERE?
          </button>
        </div>

        <div className="vehicle">
          <div>
            <span className="label">VEHICLE</span>
            <strong>Street-legal LSV</strong>
          </div>
          <div className="speed">≤ 35 MPH</div>
        </div>

        {searched && (
          <section className="result">
            <div className="status">BASELINE ROUTE</div>
            <h2>{from} → {to}</h2>
            <p>
              This first build maps the trip and applies the California 35 mph
              baseline. Road-by-road verification is being added next.
            </p>
            <div className="notice">
              <strong>CHECK BEFORE YOU GO</strong>
              <span>Posted signs and local restrictions can override map data.</span>
            </div>
          </section>
        )}

        <footer>
          <span>CanWeDrive v0.1</span>
          <span>OpenStreetMap + OpenFreeMap</span>
        </footer>
      </aside>

      <section className="map-wrap">
        <MapView />
        <div className="legend">
          <span><i className="ok" /> 35 mph or less</span>
          <span><i className="unknown" /> Unknown</span>
          <span><i className="blocked" /> Over 35 mph</span>
        </div>
      </section>
    </main>
  );
}
