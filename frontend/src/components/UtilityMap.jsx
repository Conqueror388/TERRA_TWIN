/**
 * UtilityMap — Leaflet map with two layers:
 *  1. TerraTwin-verified utilities  (solid coloured circles)
 *  2. OSM underground pipes         (dashed coloured polylines, togglable)
 */
import { useRef, useEffect, useState } from "react";
import {
  MapContainer, TileLayer, CircleMarker, Marker,
  Popup, Polyline, Rectangle, useMapEvents, useMap,
} from "react-leaflet";
import L from "leaflet";
import markerIcon   from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Fix default icon path broken by Vite bundling
const defaultIcon = L.icon({ iconUrl: markerIcon, shadowUrl: markerShadow, iconSize: [25, 41], iconAnchor: [12, 41] });

const getOsmPipeStyle = (type, isLight) => {
  const colors = {
    water: isLight ? '#0284C7' : '#29B6D8',
    gas: isLight ? '#C2410C' : '#E5A85C',
    sewer: isLight ? '#5C3A21' : '#8D6E3B',
    electric: isLight ? '#B45309' : '#FFE066',
    fiber: isLight ? '#6D28D9' : '#B58CFF',
    corridor: isLight ? '#2D3748' : '#4A6080',
    unknown: isLight ? '#4A5568' : '#9E9E9E',
  };
  const dashArrays = {
    water: "8 4",
    gas: "8 4",
    sewer: "6 5",
    electric: "8 4",
    fiber: "8 4",
    corridor: "4 4",
    unknown: "4 6",
  };
  const weights = {
    water: 2.5,
    gas: 2.5,
    sewer: 2,
    electric: 2.5,
    fiber: 2,
    corridor: 2.5,
    unknown: 1.5,
  };
  const t = colors[type] ? type : 'unknown';
  return {
    color: colors[t],
    dashArray: dashArrays[t],
    weight: weights[t],
  };
};

// Recenter map when base changes
function RecenterOnBase({ base }) {
  const map = useMap();
  useEffect(() => { map.setView([base.lat, base.lng]); }, [map, base.lat, base.lng]);
  return null;
}

function ClickHandler({ onPick, drawMode }) {
  useMapEvents({ click(e) { if (!drawMode) onPick({ lat: e.latlng.lat, lng: e.latlng.lng }); } });
  return null;
}

// Two-click rectangle drawing for the dig zone.
// First click pins one corner, second click completes the rectangle.
function DrawHandler({ drawMode, onDrawRect }) {
  const startRef = useRef(null);
  useMapEvents({
    click(e) {
      if (!drawMode) return;
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (!startRef.current) { startRef.current = p; return; }
      const a = startRef.current;
      startRef.current = null;
      if (onDrawRect) onDrawRect([a, p]);
    },
  });
  return null;
}

export default function UtilityMap({ base, utilities, point, onPick, osmPipes = [], osmLoading = false, showOsm = true, onDeleteUtility, drawMode = false, onDrawRect, digRect = null }) {
  const markerRef = useRef(null);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');

  useEffect(() => {
    const obs = new MutationObserver(() => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      setTheme(current);
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const isLight = theme === 'light';

  const rectBounds = digRect
    ? [[Math.min(digRect[0].lat, digRect[1].lat), Math.min(digRect[0].lng, digRect[1].lng)],
       [Math.max(digRect[0].lat, digRect[1].lat), Math.max(digRect[0].lng, digRect[1].lng)]]
    : null;

  return (
    <div className="relative rounded-lg overflow-hidden border border-[var(--border)]">
      {/* OSM status badge */}
      <div className="absolute top-2 right-2 z-[1000] flex items-center gap-1.5">
        {osmLoading && (
          <span className="bg-[var(--bg-panel)]/90 text-[var(--text-dim)] text-[11px] px-2.5 py-1 rounded-md animate-pulse">
            Loading OSM…
          </span>
        )}
        {!osmLoading && osmPipes.length > 0 && showOsm && (
          <span className="bg-[var(--bg-panel)]/90 text-[var(--text-dim)] text-[11px] px-2.5 py-1 rounded-md">
            {osmPipes.length} OSM pipe{osmPipes.length !== 1 ? "s" : ""} found
          </span>
        )}
        {!osmLoading && osmPipes.length === 0 && showOsm && (
          <span className="bg-[var(--bg-panel)]/90 text-[var(--text-faint)] text-[11px] px-2.5 py-1 rounded-md">
            No OSM pipes nearby
          </span>
        )}
      </div>

      <MapContainer center={[base.lat, base.lng]} zoom={17} scrollWheelZoom style={{ height: 460 }} className="z-0">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={20}
        />

        <RecenterOnBase base={base} />
        <ClickHandler onPick={onPick} drawMode={drawMode} />
        <DrawHandler drawMode={drawMode} onDrawRect={onDrawRect} />

        {/* ── Dig zone outline ───────────────────────────────────── */}
        {drawMode && (
          <div className="absolute left-1/2 -translate-x-1/2 top-2 z-[1000] bg-[#0B0E11]/90 text-amber text-[11px] px-3 py-1 rounded-md border border-[var(--border)]">
            Click 2 opposite corners to draw the dig zone
          </div>
        )}
        {rectBounds && (
          <Rectangle bounds={rectBounds} pathOptions={{ color: isLight ? "#C2410C" : "#E5A85C", weight: 2.5, dashArray: "6 4", fillColor: isLight ? "#C2410C" : "#E5A85C", fillOpacity: 0.12 }}>
            <Popup>Dig zone</Popup>
          </Rectangle>
        )}

        {/* ── OSM underground pipes layer ──────────────────────────── */}
        {showOsm && osmPipes.map((pipe) => {
          const style = getOsmPipeStyle(pipe.type, isLight);
          const isCorridor = pipe.source === "road_corridor";
          const label = pipe.name
            ? pipe.name
            : isCorridor
              ? `Estimated utility corridor`
              : `${pipe.type[0].toUpperCase() + pipe.type.slice(1)} (OSM)`;
          return (
            <Polyline
              key={pipe.id}
              positions={pipe.coordinates}
              pathOptions={style}
            >
              <Popup>
                <strong>{label}</strong><br />
                {isCorridor ? (
                  <>
                    <span style={{ color: isLight ? "#C2410C" : "#E5A85C", fontSize: "11px", fontWeight: "bold" }}>Estimated corridor</span><br />
                    No direct utility mapping exists here.<br />
                    Showing road alignment as a proxy.<br />
                    <em>Road: {pipe.name || "Unnamed street"}</em>
                  </>
                ) : (
                  <>
                    Source: OpenStreetMap (unverified)<br />
                    {pipe.depth ? `Recorded depth: ${pipe.depth} m` : "Depth: not recorded"}<br />
                    {pipe.tags?.operator && `Operator: ${pipe.tags.operator}`}
                  </>
                )}
                <br /><em style={{ fontSize: 10, opacity: 0.6 }}>OSM ID: {pipe.osmId}</em>
              </Popup>
            </Polyline>
          );
        })}

        {/* ── TerraTwin verified utilities ─────────────────────────── */}
        {utilities.map((u) => {
          const isDeletable = u.id.includes('-D');
          const uColor = getOsmPipeStyle(u.type, isLight).color;
          return (
            <CircleMarker
              key={u.id}
              center={[u.lat, u.lng]}
              radius={8}
              pathOptions={{ color: uColor, weight: 2, fillColor: uColor, fillOpacity: 0.65 }}
            >
              <Popup>
                <strong>{u.type.toUpperCase()}</strong> · {u.id}<br />
                Depth: {u.depth} m<br />
                Owner: {u.owner}<br />
                Confidence: {u.confidence}%<br />
                <em style={{ fontSize: 10, color: isLight ? "#0891B2" : "#5BC8DC" }}>TerraTwin verified</em>
                {isDeletable && onDeleteUtility && (
                  <button
                    onClick={() => onDeleteUtility(u.id)}
                    style={{
                      marginTop: "10px",
                      display: "block",
                      width: "100%",
                      background: "#D9655B",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      padding: "5px 8px",
                      fontSize: "11px",
                      fontWeight: "bold",
                      cursor: "pointer",
                      textAlign: "center"
                    }}
                  >
                    Delete pipe
                  </button>
                )}
              </Popup>
            </CircleMarker>
          );
        })}

        {/* ── Excavation point marker ───────────────────────────────── */}
        <Marker
          position={[point.lat, point.lng]}
          icon={defaultIcon}
          draggable
          ref={markerRef}
          eventHandlers={{
            dragend() {
              const m = markerRef.current;
              if (m) onPick(m.getLatLng());
            },
          }}
        >
          <Popup>Excavation point<br />{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}
