import { Suspense, useMemo, useEffect, useState, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Float, Grid, Sky, ContactShadows, Sparkles } from "@react-three/drei";
import * as THREE from "three";
import { BASE } from "../lib/utilities";
import { api } from "../lib/api";
import { LoadingState } from "../components/Feedback";
import { metersBetween, scoreUtility, scoreExcavation, DANGER_RADIUS_M, bandFor } from "../lib/riskEngine";

// ─── Scene constants ───────────────────────────────────────────────────────────
// 1 Three.js unit = 1 real metre (horizontal).
// Depth is also 1:1 — no vertical exaggeration — so labels are truthful.
const DEPTH_SCALE  = 1;          // 1 m real depth = 1 unit down in scene
const GROUND_SIZE  = 20;         // metres of ground surface shown
const NEARBY_M     = 15;         // only show utilities within 15 m of the shaft
const PIPE_LEN     = 40;         // pipe runs 40 m across the scene (±20 m)
const PAD_RADIUS   = 4.6;        // excavated worksite pad radius (kept flat + compacted)

// Pipe type → real-world direction (radians, measured from Z/North axis)
const PIPE_BEARING = {
  water:    0,           // North–South
  electric: Math.PI / 2, // East–West
  gas:      Math.PI / 4, // NE–SW
  fiber:    -Math.PI / 4,// NW–SE
  sewer:    0,           // North–South (deeper)
};

const PIPE_MATS = {
  water:    { color: "#29B6D8", metalness: 0.15, roughness: 0.72, emissive: "#29B6D8", emissiveIntensity: 0.45, paint: "#42A5F5", joint: "#205468" },
  electric: { color: "#F5A623", metalness: 0.60, roughness: 0.32, emissive: "#F5A623", emissiveIntensity: 0.50, paint: "#F44336", joint: "#6B4608" },
  fiber:    { color: "#B58CFF", metalness: 0.10, roughness: 0.72, emissive: "#B58CFF", emissiveIntensity: 0.45, paint: "#FF9800", joint: "#5B4A86" },
  gas:      { color: "#E5E542", metalness: 0.55, roughness: 0.35, emissive: "#E5E542", emissiveIntensity: 0.40, paint: "#FDD835", joint: "#6B5E08" },
  sewer:    { color: "#8D6E3B", metalness: 0.08, roughness: 0.88, emissive: "#8D6E3B", emissiveIntensity: 0.30, paint: "#4CAF50", joint: "#4A3A22" },
};
// Larger, realistic working diameters — these read clearly at 1:1 depth scale.
const PIPE_RADIUS = { water: 0.28, electric: 0.20, fiber: 0.16, gas: 0.24, sewer: 0.34 };

// ─── Deterministic PRNG so scattered ground detail never jitters between renders ─
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Convert real-world lat/lng offset into scene (x=East, z=North) ───────────
function toSceneXZ(base, lat, lng) {
  const x = (lng - base.lng) * 111320 * Math.cos((base.lat * Math.PI) / 180);
  const z = (lat - base.lat) * 111320; // z = north in scene
  return { x, z };
}

// ─── Procedural dirt texture (no network fetch — everything is generated) ─────
function useDirtTexture() {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 512;
    const ctx = c.getContext("2d");

    // Base soil colour
    ctx.fillStyle = "#6b4c2a";
    ctx.fillRect(0, 0, 512, 512);

    // Layered speckles — dark mineral grains + light sandy flecks
    for (let i = 0; i < 26000; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      const r = 1 + Math.random() * 2.4;
      if (Math.random() < 0.6) {
        ctx.fillStyle = `rgba(${30 + Math.random() * 30}, ${22 + Math.random() * 20}, ${8 + Math.random() * 10}, ${0.10 + Math.random() * 0.22})`;
      } else {
        ctx.fillStyle = `rgba(${140 + Math.random() * 50}, ${108 + Math.random() * 40}, ${70 + Math.random() * 30}, ${0.10 + Math.random() * 0.18})`;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // A few hard "pebble" clumps
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(${85 + Math.random() * 45}, ${72 + Math.random() * 30}, ${60 + Math.random() * 30}, 0.5)`;
      ctx.beginPath();
      ctx.arc(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 4, 0, Math.PI * 2);
      ctx.fill();
    }

    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(9, 9);
    t.anisotropy = 8;
    return t;
  }, []);
}

// ─── Gentle height-mapped terrain with a flat compacted worksite pad ──────────
function Terrain({ size }) {
  const dirt = useDirtTexture();

  const geometry = useMemo(() => {
    const seg = 64;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    const pos = geo.attributes.position;
    const dist = (x, z) => Math.sqrt(x * x + z * z);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getY(i);
      const r = dist(x, z);

      // Gentle large-wavelength ground swell + subtle surface ripples
      let h =
        Math.sin(x * 0.42) * Math.cos(z * 0.38) * 0.13 +
        Math.sin(x * 1.4 + 2.1) * Math.cos(z * 1.1) * 0.035 +
        Math.sin((x + z) * 0.12) * 0.18;

      // Flatten the worksite pad around the excavation and ease back to ground
      const pad = Math.max(0, (r - PAD_RADIUS * 0.55) / (PAD_RADIUS * 0.45));
      h = h * Math.min(1, Math.max(0, pad)) - (r < PAD_RADIUS ? 0.03 : 0);

      pos.setZ(i, h);
    }
    geo.computeVertexNormals();
    return geo;
  }, [size]);

  return (
    <group>
      {/* Dirt surface */}
      <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <meshStandardMaterial map={dirt} color="#A98354" roughness={1} metalness={0} />
      </mesh>

      {/* Bare excavated-earth ring around the trench mouth */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[3.2, PAD_RADIUS, 48]} />
        <meshStandardMaterial color="#6f4f2c" roughness={1} transparent opacity={0.92} />
      </mesh>

      {/* Faint survey grid — clearly just guidance, fades away from the shaft */}
      <Grid
        args={[size, size]}
        position={[0, 0.045, 0]}
        cellSize={1}
        cellThickness={0.25}
        cellColor="#4FD1E8"
        sectionSize={5}
        sectionThickness={0.55}
        sectionColor="#1D6070"
        fadeDistance={26}
        fadeStrength={1.4}
        followCamera={false}
        infiniteGrid={false}
      />
    </group>
  );
}

// ─── Scattered ground detail: rocks, soil mounds, grass tufts ─────────────────
// Generated once at module load with a fixed seed so the layout is stable.
const GROUND_RNG = mulberry32(20260807);
const ROCKS = (() => {
  const out = [];
  for (let i = 0; i < 42; i++) {
    const a = GROUND_RNG() * Math.PI * 2;
    const r = PAD_RADIUS + 2.2 + GROUND_RNG() * (GROUND_SIZE / 2 - PAD_RADIUS - 2.5);
    const scale = 0.06 + GROUND_RNG() * 0.22;
    out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, scale, rot: GROUND_RNG() * Math.PI, squish: 0.6 + GROUND_RNG() * 0.7 });
  }
  return out;
})();
const GRASS = (() => {
  const out = [];
  for (let i = 0; i < 90; i++) {
    const a = GROUND_RNG() * Math.PI * 2;
    const r = PAD_RADIUS + 1.4 + GROUND_RNG() * (GROUND_SIZE / 2 - PAD_RADIUS - 1.5);
    out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, s: 0.05 + GROUND_RNG() * 0.12, h: 0.25 + GROUND_RNG() * 0.55, rot: GROUND_RNG() * Math.PI * 2 });
  }
  return out;
})();

function GroundDetail() {

  return (
    <group>
      {ROCKS.map((p, i) => (
        <mesh key={`r${i}`} position={[p.x, p.scale * p.squish * 0.5, p.z]} rotation={[0, p.rot, 0]} scale={[p.scale * p.squish, p.scale * p.squish, p.scale]} castShadow receiveShadow>
          <icosahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color="#9C8E78" roughness={0.95} flatShading />
        </mesh>
      ))}
      {GRASS.map((p, i) => (
        <group key={`g${i}`} position={[p.x, 0, p.z]} rotation={[0, p.rot, 0]}>
          {[0, 0.5, 1].map((o) => (
            <mesh key={o} position={[0, p.h / 2, o * p.s * 0.4]} castShadow>
              <coneGeometry args={[p.s * 0.32, p.h, 5]} />
              <meshStandardMaterial color="#4E7A2C" roughness={1} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

// ─── Real-depth soil strata (bulk earth beneath the surface) ──────────────────
function SoilLayers({ maxDepth }) {
  const layers = [
    { top: 0, bot: 1,        color: "#7A5C30", label: "Topsoil (0–1 m)"  },
    { top: 1, bot: 2,        color: "#6B4C22", label: "Clay (1–2 m)"     },
    { top: 2, bot: 3,        color: "#5A3D18", label: "Subsoil (2–3 m)"  },
    { top: 3, bot: Math.max(maxDepth + 2, 5), color: "#4A2E10", label: "Bedrock (3 m+)" },
  ];
  return (
    <group>
      {layers.map((l, i) => {
        const h = (l.bot - l.top) * DEPTH_SCALE;
        const mid = -(l.top + (l.bot - l.top) / 2) * DEPTH_SCALE;
        const edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(GROUND_SIZE, h, GROUND_SIZE));
        return (
          <group key={i}>
            <mesh position={[0, mid, 0]}>
              <boxGeometry args={[GROUND_SIZE, h, GROUND_SIZE]} />
              <meshStandardMaterial color={l.color} transparent opacity={0.22 + i * 0.03} side={THREE.DoubleSide} depthWrite={false} roughness={0.9} />
            </mesh>
            <lineSegments position={[0, mid, 0]} geometry={edgeGeo}>
              <lineBasicMaterial color={l.color} transparent opacity={0.4} />
            </lineSegments>
          </group>
        );
      })}
    </group>
  );
}

// ─── Depth ruler — 1:1 scale, marks up to plannedDepth + 1 m ─────────────────
function DepthRuler({ plannedDepth }) {
  const x = -GROUND_SIZE / 2 - 1.2;
  const maxM = Math.ceil(plannedDepth) + 1;
  const ticks = Array.from({ length: maxM + 1 }, (_, i) => i);
  return (
    <group>
      <mesh position={[x, -(maxM / 2) * DEPTH_SCALE, 0]}>
        <boxGeometry args={[0.03, maxM * DEPTH_SCALE, 0.03]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.15} />
      </mesh>
      {ticks.map((m) => {
        const y = -m * DEPTH_SCALE;
        const isPlanned = m === Math.round(plannedDepth);
        return (
          <group key={m}>
            <mesh position={[x, y, 0]}>
              <boxGeometry args={[0.5, 0.04, 0.04]} />
              <meshBasicMaterial color={isPlanned ? "#FF3D2E" : m === 0 ? "#4FD1E8" : "#ffffff"} transparent opacity={0.6} />
            </mesh>
            <Text position={[x - 0.7, y, 0]} fontSize={0.22} color={isPlanned ? "#FF3D2E" : m === 0 ? "#4FD1E8" : "#888888"} anchorX="right" anchorY="middle">
              {m === 0 ? "0 m" : `${m} m`}
            </Text>
            {isPlanned && (
              <Text position={[x - 0.7, y - 0.3, 0]} fontSize={0.17} color="#FF3D2E" anchorX="right" anchorY="middle">
                ▶ dig target
              </Text>
            )}
          </group>
        );
      })}
    </group>
  );
}

// ─── North arrow compass ───────────────────────────────────────────────────────
function NorthArrow() {
  const arrowLen = 1.2;
  return (
    <group position={[GROUND_SIZE / 2 - 1, 0.05, -GROUND_SIZE / 2 + 1]}>
      <mesh rotation={[0, 0, 0]}>
        <coneGeometry args={[0.15, arrowLen, 8]} />
        <meshBasicMaterial color="#4FD1E8" />
      </mesh>
      <mesh position={[0, -arrowLen / 2 - 0.05, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.15, 6]} />
        <meshBasicMaterial color="#4FD1E8" />
      </mesh>
      <Text position={[0, arrowLen + 0.3, 0]} fontSize={0.3} color="#4FD1E8" anchorX="center">
        N
      </Text>
    </group>
  );
}

// ─── Bound a fabricated pipe's rendered length so it can never visually cross
// the danger ring for a utility the risk engine has scored as not-a-conflict.
// Floor of 0.6 m keeps very close utilities visible; ceiling is PIPE_LEN.
function clampPipeLen(dist, dangerRadius) {
  const half = Math.max(0.6, dist - dangerRadius);
  return Math.min(PIPE_LEN, half * 2);
}

// ─── Locate-paint marks painted on the surface above a utility ────────────────
// Real locate crews spray-paint utility paths on the road/ground before a dig.
// We render short fluorescent dashes along the (fabricated) bearing + an X.
function LocatePaint({ bearing, color, x, z }) {
  const step = 1.6;
  const dash = 0.55;
  return (
    <group position={[x, 0.05, z]}>
      {[1, 2, 3].map((i) => {
        const along = i * step;
        return [along, -along].map((a2) => {
          const ox = Math.sin(bearing) * a2;
          const oz = Math.cos(bearing) * a2;
          return (
            <mesh key={`${i}-${a2}`} position={[ox, 0, oz]} rotation={[0, bearing, 0]}>
              <boxGeometry args={[0.09, 0.008, dash]} />
              <meshBasicMaterial color={color} transparent opacity={0.9} toneMapped={false} />
            </mesh>
          );
        });
      })}
      {/* locating X near the marker pin */}
      <mesh rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[0.5, 0.01, 0.09]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} toneMapped={false} />
      </mesh>
      <mesh rotation={[0, -Math.PI / 4, 0]}>
        <boxGeometry args={[0.5, 0.01, 0.09]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} toneMapped={false} />
      </mesh>
    </group>
  );
}

// ─── A single underground utility pipe, 1:1 scale ─────────────────────────────
function UtilityPipe({ utility, base, excavation, selected, onSelect, digProgress = 0 }) {
  const mat = PIPE_MATS[utility.type] || PIPE_MATS.fiber;
  const radius = PIPE_RADIUS[utility.type] || 0.12;
  const { x, z } = toSceneXZ(base, utility.lat, utility.lng);
  const y = -utility.depth * DEPTH_SCALE;
  const bearing = PIPE_BEARING[utility.type] ?? 0;

  const riskResult = useMemo(() => scoreUtility(excavation, utility), [excavation, utility]);
  const isConflict = riskResult.dist <= DANGER_RADIUS_M && riskResult.level !== "LOW";
  const isCritical = riskResult.level === "CRITICAL" || riskResult.level === "HIGH";
  const isSelected = selected === utility.id;

  // Collision triggers if the pipe is inside the danger footprint and the dig progress crosses its depth
  const currentDigDepth = digProgress * excavation.depth;
  const isColliding = isConflict && currentDigDepth >= (utility.depth - 0.25) && currentDigDepth <= (utility.depth + 0.25);

  const renderedLen = isConflict ? PIPE_LEN : clampPipeLen(riskResult.dist, DANGER_RADIUS_M);

  // Axis the pipe runs along in scene space: (sin bearing, cos bearing) in
  // (x = East, z = North). The body/ribs/collar cylinders lie on their local
  // Y axis, so we build the exact rotation that maps Y onto that direction;
  // the bell torus is a ring around the pipe, so its local Z (hole axis) must
  // map onto the same direction instead. This keeps every detail co-axial with
  // the body — the old [0,-bearing,π/2] Euler left the detailing perpendicular.
  const axisQuat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(Math.sin(bearing), 0, Math.cos(bearing))
  ), [bearing]);
  const torusQuat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(Math.sin(bearing), 0, Math.cos(bearing))
  ), [bearing]);

  const meshRef = useRef();
  const flowRef = useRef();
  useFrame((state) => {
    const { clock } = state;
    if (meshRef.current) {
      if (!isConflict && !isSelected) {
        meshRef.current.material.emissiveIntensity = isSelected ? 1.6 : mat.emissiveIntensity;
      } else {
        const pulse = 0.5 + Math.sin(clock.elapsedTime * 4) * 0.5;
        meshRef.current.material.emissiveIntensity = isCritical ? 1.5 * pulse : (isSelected ? 1.9 : 0.8 * pulse);
      }
    }
    if (flowRef.current) {
      const elapsed = clock.getElapsedTime();
      const speeds = { water: 1.2, electric: 3.0, fiber: 4.0, gas: 1.8, sewer: 0.6 };
      const baseSpeed = speeds[utility.type] || 1.5;
      const speed = isConflict ? baseSpeed * 2.2 : baseSpeed;
      const spacing = renderedLen / 12;
      const children = flowRef.current.children;
      for (let i = 0; i < children.length; i++) {
        const p = children[i];
        if (p) {
          let yPos = ((i * spacing + elapsed * speed) % renderedLen) - (renderedLen / 2);
          p.position.y = yPos;
          const pulse = 0.85 + Math.sin(elapsed * (isConflict ? 15 : 6) + i) * 0.15;
          p.scale.set(pulse, pulse, pulse);
        }
      }
    }
  });

  const pointerHandlers = {
    onClick: (e) => { e.stopPropagation(); onSelect?.(utility.id); },
    onPointerOver: (e) => { e.stopPropagation(); document.body.style.cursor = "pointer"; },
    onPointerOut: () => { document.body.style.cursor = ""; },
  };

  const pipeColor = isConflict ? "#FF3D2E" : mat.color;
  const emissive = isConflict ? "#FF2200" : mat.emissive;
  const emissiveI = isConflict ? 1.0 : mat.emissiveIntensity;

  return (
    <group {...pointerHandlers}>
      {/* Underground point light so pipe glows */}
      <pointLight position={[x, y, z]} color={isColliding ? "#FF1100" : pipeColor} intensity={isColliding ? 14 : (isConflict ? 3.5 : 1.1)} distance={5} />

      {/* Collision sparks & strike hazard float tag */}
      {isColliding && (
        <group>
          <Sparkles
            count={60}
            scale={[0.7, 0.7, 0.7]}
            position={[x, y, z]}
            size={0.16}
            speed={4}
            opacity={1.0}
            color="#FF9900"
          />
          <Float speed={4.5} floatIntensity={0.35} rotationIntensity={0}>
            <Text position={[x, y + 0.85, z]} fontSize={0.28} color="#FF3D2E" outlineColor="#000000" outlineWidth={0.05} fontStyle="italic">
              ⚠ PIPE STRIKE!
            </Text>
          </Float>
        </group>
      )}

      {/* Bedding trench — the sand/gravel cradle the pipe sits in */}
      {!isConflict && (
        <mesh position={[x, y + 0.03, z]} rotation={[0, bearing, 0]}>
          <boxGeometry args={[Math.max(0.55, radius * 2.6), 0.08, renderedLen]} />
          <meshStandardMaterial color="#4A3820" roughness={1} transparent opacity={0.55} />
        </mesh>
      )}

      {/* Pipe body — runs through the scene along its bearing (semi-transparent sheathing) */}
      <mesh ref={meshRef} position={[x, y, z]} quaternion={axisQuat} castShadow>
        <cylinderGeometry args={[radius, radius, renderedLen, 32]} />
        <meshStandardMaterial
          color={pipeColor}
          metalness={mat.metalness}
          roughness={mat.roughness}
          emissive={emissive}
          emissiveIntensity={emissiveI}
          transparent
          opacity={0.65}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Flowing internal core/particles */}
      <group position={[x, y, z]} quaternion={axisQuat}>
        <group ref={flowRef}>
          {Array.from({ length: 12 }).map((_, i) => {
            const particleColors = {
              water: "#4FD1E8",
              electric: "#FFD54F",
              fiber: "#F06292",
              gas: "#FFF176",
              sewer: "#81C784"
            };
            const col = isConflict ? "#FF3D2E" : (particleColors[utility.type] || "#FFFFFF");
            return (
              <mesh key={i} position={[0, 0, 0]}>
                <sphereGeometry args={[radius * 0.45, 16, 16]} />
                <meshBasicMaterial color={col} transparent opacity={0.88} />
              </mesh>
            );
          })}
        </group>
      </group>

      {/* Ribbed casting rings + bell-end couplings — the honest "real pipe" look */}
      {(() => {
        const ribs = [];
        const bells = [];
        for (let off = -renderedLen / 2; off <= renderedLen / 2; off += 1.8) ribs.push(off);
        for (let off = 0; off <= renderedLen / 2; off += 6) {
          bells.push(off);
          if (off !== 0) bells.push(-off);
        }
        return (
          <group>
            {ribs.map((off) => {
              const ox = Math.sin(bearing) * off;
              const oz = Math.cos(bearing) * off;
              return (
                <mesh key={`rib${off}`} position={[x + ox, y, z + oz]} quaternion={axisQuat} castShadow>
                  <cylinderGeometry args={[radius + 0.028, radius + 0.028, 0.09, 32]} />
                  <meshStandardMaterial color={isConflict ? "#3A0A05" : mat.joint} metalness={0.5} roughness={0.5} />
                </mesh>
              );
            })}
            {bells.map((off) => {
              const ox = Math.sin(bearing) * off;
              const oz = Math.cos(bearing) * off;
              return (
                <group key={`bell${off}`} position={[x + ox, y, z + oz]}>
                  <mesh quaternion={torusQuat} castShadow>
                    <torusGeometry args={[radius + 0.09, 0.055, 14, 32]} />
                    <meshStandardMaterial color={isConflict ? "#4A0D05" : mat.joint} metalness={0.7} roughness={0.35} />
                  </mesh>
                  <mesh quaternion={axisQuat}>
                    <cylinderGeometry args={[radius + 0.045, radius + 0.045, 0.06, 32]} />
                    <meshStandardMaterial color="#10161C" metalness={0.8} roughness={0.3} />
                  </mesh>
                </group>
              );
            })}
          </group>
        );
      })()}

      {/* Surface marker pin + concrete stub (like a survey witness) */}
      <mesh position={[x, -0.08, z]}>
        <cylinderGeometry args={[0.09, 0.11, 0.18, 8]} />
        <meshStandardMaterial color="#8A8A8A" roughness={0.6} />
      </mesh>
      <mesh position={[x, -0.1, z]}>
        <cylinderGeometry args={[0.05, 0.05, 0.3, 8]} />
        <meshStandardMaterial color={pipeColor} emissive={pipeColor} emissiveIntensity={1.2} />
      </mesh>

      {/* Vertical trace line from surface to pipe */}
      <mesh position={[x, y / 2, z]}>
        <boxGeometry args={[0.02, Math.abs(y), 0.02]} />
        <meshBasicMaterial color={pipeColor} transparent opacity={0.35} />
      </mesh>

      {/* Locate paint on the ground above the utility */}
      <LocatePaint bearing={bearing} color={mat.paint} x={x} z={z} />

      {/* Depth label */}
      <Float speed={1.5} floatIntensity={0.05} rotationIntensity={0}>
        <Text position={[x, y - 0.5, z]} fontSize={0.22} color={pipeColor} anchorX="center" anchorY="middle" outlineColor="#000000" outlineWidth={0.04}>
          {utility.type.toUpperCase()} · {utility.depth}m
          {isConflict ? `  ⚠ ${riskResult.level}` : ""}
        </Text>
      </Float>

      {/* Conflict warning ring + surface flag at grade — every live conflict gets a
        visible red marker above ground, so the on-screen conflict count is
        always matched by what the operator can actually see (the pipe itself
        is buried and easy to miss at the edge of the danger ring). */}
      {isConflict && (
        <group position={[x, 0, z]}>
          <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.95, 1.2, 32]} />
            <meshBasicMaterial color="#FF3D2E" transparent opacity={0.8} side={THREE.DoubleSide} />
          </mesh>
          <Float speed={2.2} floatIntensity={0.28} rotationIntensity={0}>
            <Text position={[0, 0.85, 0]} fontSize={0.28} color="#FF3D2E" anchorX="center" anchorY="middle" outlineColor="#000000" outlineWidth={0.05}>
              ⚠ {utility.type.toUpperCase()} · {riskResult.level}
            </Text>
          </Float>
        </group>
      )}

      {/* Selection highlight ring */}
      {isSelected && (
        <mesh position={[x, 0.03, z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.6, 0.8, 32]} />
          <meshBasicMaterial color="#4FD1E8" transparent opacity={0.85} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

// ─── Pulsing danger-zone radius ring at ground level ─────────────────────────
// Rendered as a translucent filled disc + bright edge ring raised just above
// the terrain swell (which can reach ~0.35 m) so the whole 5 m circle is
// visible from every angle instead of being buried under the ground bumps.
function DangerZoneRing() {
  const ref = useRef();
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.material.opacity = 0.13 + Math.sin(clock.elapsedTime * 2) * 0.06;
  });
  const TOP = 0.5;
  return (
    <group>
      {/* Filled translucent zone disc — the full 5 m circle reads from above */}
      <mesh ref={ref} position={[0, TOP, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[DANGER_RADIUS_M, 64]} />
        <meshBasicMaterial color="#FF3D2E" transparent opacity={0.14} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* Bright boundary ring at the zone edge */}
      <mesh position={[0, TOP + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[DANGER_RADIUS_M - 0.1, DANGER_RADIUS_M + 0.1, 64]} />
        <meshBasicMaterial color="#FF3D2E" transparent opacity={0.65} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* Thin translucent wall from the ground up to the disc — grounds it */}
      <mesh position={[0, TOP / 2, 0]}>
        <cylinderGeometry args={[DANGER_RADIUS_M, DANGER_RADIUS_M, TOP, 64, 1, true]} />
        <meshBasicMaterial color="#FF3D2E" transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ─── Excavation trench — hazard-shield walls, hydraulic shoring, ramp, spoil ──
// digProgress (0..1) animates the cut: the pit fills with soil at 0 and is fully
// excavated (soil recedes through the strata) by 1.
function ExcavationShaft({ depth, width, length, selected, onSelect, digProgress = 1 }) {
  const h = depth * DEPTH_SCALE;
  const midY = -h / 2;
  const t = 0.06;

  // Striped hazard texture for trench shield walls
  const wallTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 128; c.height = 128;
    const ctx = c.getContext("2d");
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#E4483C" : "#1A0500";
      ctx.fillRect(0, i * 12.8, 128, 12.8);
    }
    return new THREE.CanvasTexture(c);
  }, []);

  const outlineRef = useRef();
  useFrame(({ clock }) => {
    if (outlineRef.current) outlineRef.current.material.opacity = 0.4 + Math.sin(clock.elapsedTime * 3) * 0.35;
  });
  const outlineGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(width, h, length)), [width, h, length]);

  const walls = [
    { pos: [0, midY, -length / 2], args: [width, h, t] },
    { pos: [0, midY, length / 2], args: [width, h, t] },
    { pos: [-width / 2, midY, 0], args: [t, h, length] },
    { pos: [width / 2, midY, 0], args: [t, h, length] },
  ];

  // Hydraulic trench shoring — horizontal steel struts between the shield walls
  const braceYs = depth > 2 ? [-h * 0.35, -h * 0.7] : [-h * 0.5];
  const braceColor = "#B8C7D6";

  return (
    <group position={[0, 0, 0]}>
      {/* Trench shield walls (hazard-taped metal) */}
      {walls.map(({ pos, args }, i) => (
        <mesh key={i} position={pos} castShadow>
          <boxGeometry args={args} />
          <meshStandardMaterial map={wallTex} roughness={0.9} metalness={0} transparent opacity={0.82} />
        </mesh>
      ))}

      {/* Floor — worked earth */}
      <mesh
        position={[0, -h, 0]}
        onClick={(e) => { e.stopPropagation(); onSelect?.("excavation"); }}
        onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = "pointer"; }}
        onPointerOut={() => { document.body.style.cursor = ""; }}
      >
        <boxGeometry args={[width, t, length]} />
        <meshStandardMaterial color={selected === "excavation" ? "#4A2A10" : "#3D1F08"} roughness={1} />
      </mesh>

      {/* In-situ soil still inside the pit — recedes as the dig progresses */}
      {digProgress < 0.999 && (
        <mesh position={[0, -(h * (1 + digProgress)) / 2, 0]}>
          <boxGeometry args={[width - 0.12, h * (1 - digProgress), length - 0.12]} />
          <meshStandardMaterial color="#5E4526" roughness={1} />
        </mesh>
      )}

      {/* Active dig front: a red line at the current cut depth + readout */}
      {digProgress > 0.001 && digProgress < 0.999 && (
        <group position={[0, 0.02, 0]}>
          <mesh position={[0, -digProgress * h, 0]}>
            <boxGeometry args={[width + 0.05, 0.03, length + 0.05]} />
            <meshBasicMaterial color="#FF3D2E" transparent opacity={0.55} toneMapped={false} />
          </mesh>
          <Text position={[0, -digProgress * h + 0.9, 0]} fontSize={0.2} color="#FF3D2E" anchorX="center" outlineColor="#000" outlineWidth={0.04}>
            ▼ digging · {(digProgress * depth).toFixed(2)} m
          </Text>
        </group>
      )}

      {/* Hydraulic shoring struts */}
      {braceYs.map((by) => (
        <group key={by} position={[0, by, 0]}>
          <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.06, 0.06, width + 0.2, 12]} />
            <meshStandardMaterial color={braceColor} metalness={0.8} roughness={0.3} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.06, 0.06, length + 0.2, 12]} />
            <meshStandardMaterial color={braceColor} metalness={0.8} roughness={0.3} />
          </mesh>
          {[-width / 2 - 0.1, width / 2 + 0.1].map((ox) => (
            <mesh key={ox} position={[ox, 0, 0]}>
              <boxGeometry args={[0.16, 0.1, 0.16]} />
              <meshStandardMaterial color="#5E6E7E" metalness={0.8} roughness={0.4} />
            </mesh>
          ))}
        </group>
      ))}

      {/* Pulsing outline */}
      <lineSegments ref={outlineRef} geometry={outlineGeo} position={[0, midY, 0]}>
        <lineBasicMaterial color="#FF3D2E" transparent opacity={0.7} />
      </lineSegments>

      {/* Top frame at ground level */}
      <lineSegments position={[0, 0, 0]}>
        <edgesGeometry args={[new THREE.BoxGeometry(width, 0.04, length)]} />
        <lineBasicMaterial color="#FF3D2E" />
      </lineSegments>

      {/* Pit mouth — a dark void that opens as the excavation proceeds.
          FrontSide only: from above it reads as the pit, from below it's
          invisible so the buried pipes/floor can still be inspected. Its
          opacity is tied to digProgress so the ground is sealed (not black)
          until the dig actually starts. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
        <planeGeometry args={[width, length]} />
        <meshStandardMaterial color="#05070B" roughness={0.85} metalness={0} transparent opacity={digProgress} />
      </mesh>

      {/* Concrete/steel collar — edge protection at grade */}
      {[
        [0, 0, -length / 2 - 0.15, width + 0.3, 0.12, 0.12],
        [0, 0, length / 2 + 0.15, width + 0.3, 0.12, 0.12],
        [-width / 2 - 0.15, 0, 0, 0.12, 0.12, length + 0.3],
        [width / 2 + 0.15, 0, 0, 0.12, 0.12, length + 0.3],
      ].map(([px, py, pz, sx, sy, sz], i) => (
        <mesh key={i} position={[px, py + 0.06, pz]} castShadow>
          <boxGeometry args={[sx, sy, sz]} />
          <meshStandardMaterial color="#C9CDD3" metalness={0.6} roughness={0.35} />
        </mesh>
      ))}

      {/* Dimension label */}
      <Text position={[0, 0.55, 0]} fontSize={0.24} color="#FF3D2E" anchorX="center" outlineColor="#000" outlineWidth={0.04}>
        ⚠ EXCAVATION  {width}m × {length}m × {depth}m deep
      </Text>

      {/* Depth marker line at the planned dig bottom */}
      <mesh position={[0, -h + 0.02, 0]}>
        <boxGeometry args={[width, 0.04, length]} />
        <meshBasicMaterial color="#FF3D2E" transparent opacity={0.4} />
      </mesh>
    </group>
  );
}

// ─── Worksite props: safety corner posts + caution tape ───────────────────────
function WorksiteProps({ width, length }) {
  const posts = [
    [width / 2 + 0.9, length / 2 + 0.9],
    [-width / 2 - 0.9, length / 2 + 0.9],
    [width / 2 + 0.9, -length / 2 - 0.9],
    [-width / 2 - 0.9, -length / 2 - 0.9],
  ];

  return (
    <group>
      {/* Orange safety corner posts with reflective banding */}
      {posts.map(([px, pz], i) => (
        <group key={i} position={[px, 0, pz]}>
          <mesh position={[0, 0.45, 0]} castShadow>
            <cylinderGeometry args={[0.045, 0.055, 0.9, 10]} />
            <meshStandardMaterial color="#F26522" roughness={0.6} emissive="#F26522" emissiveIntensity={0.25} />
          </mesh>
          <mesh position={[0, 0.62, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.14, 10]} />
            <meshStandardMaterial color="#E7F2F7" roughness={0.4} emissive="#E7F2F7" emissiveIntensity={0.3} />
          </mesh>
        </group>
      ))}

      {/* Caution tape: a tensioned string between the near posts */}
      <mesh position={[0, 0.72, length / 2 + 0.9]} castShadow>
        <boxGeometry args={[width + 1.8, 0.02, 0.02]} />
        <meshStandardMaterial color="#F7B32B" emissive="#FFB800" emissiveIntensity={0.5} />
      </mesh>
      <mesh position={[0, 0.72, -length / 2 - 0.9]} castShadow>
        <boxGeometry args={[width + 1.8, 0.02, 0.02]} />
        <meshStandardMaterial color="#F7B32B" emissive="#FFB800" emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

// ─── Camera fly-to presets ─────────────────────────────────────────────────────
const CAM_PRESETS = {
  iso:  () => ({ p: new THREE.Vector3(16, 7.5, 16), t: new THREE.Vector3(0, 0, 0) }),
  dig:  (depth) => ({ p: new THREE.Vector3(7.2, 3.2, 8.5), t: new THREE.Vector3(0, -depth * 0.55, 0) }),
  plan: () => ({ p: new THREE.Vector3(0.02, 19, 0.02), t: new THREE.Vector3(0, 0, 0) }),
};

// ─── Cinematic camera transitions ──────────────────────────────────────────────
// Eases the camera + orbit target toward a requested preset with a frame-rate
// independent damping curve, has a gentle fly-in on mount, and gives up control
// the instant the user grabs the view. The target is stashed on the controls
// object so manual drags (OrbitControls onStart) can cancel it directly.
function CameraRig({ controlsRef, viewCmd, depth }) {
  const depthRef = useRef(depth);
  depthRef.current = depth;

  // Fly into the default Overview angle once the controls are ready.
  const introDone = useRef(false);
  useEffect(() => {
    const c = controlsRef.current;
    if (!c || introDone.current) return;
    introDone.current = true;
    c.object.position.set(34, 26, 40);
    c.target.set(0, 0, 0);
    c.update();
    c._camDest = CAM_PRESETS.iso();
  }, [controlsRef]);

  // Queue a new destination whenever a view preset is requested.
  useEffect(() => {
    const c = controlsRef.current;
    if (!c || !viewCmd) return;
    const make = CAM_PRESETS[viewCmd.mode];
    c._camDest = make ? make(depthRef.current) : CAM_PRESETS.iso();
  }, [viewCmd, controlsRef]);

  useFrame((_, delta) => {
    const c = controlsRef.current;
    if (!c || !c._camDest) return;
    const { p, t } = c._camDest;
    const lambda = 1 - Math.exp(-5.5 * delta); // eased, frame-rate independent
    c.object.position.lerp(p, lambda);
    c.target.lerp(t, lambda);
    c.update();
    // Arrived — stop easing so manual orbit is fully responsive again.
    if (c.object.position.distanceTo(p) < 0.04 && c.target.distanceTo(t) < 0.04) {
      c._camDest = null;
    }
  });
  return null;
}

// ─── Auto-rotate until user interacts (pauses briefly after a view preset) ────
function AutoRotate({ controlsRef, viewAt }) {
  useFrame(() => {
    const c = controlsRef.current;
    if (!c) return;
    if (Date.now() - viewAt < 6000) return;   // user just asked for a specific view
    if (!c._interacting) {
      c.azimuthAngle += 0.0018;
      c.update();
    }
  });
  return null;
}

// ─── Ambient dust motes drifting in the sun shaft ─────────────────────────────
function Dust() {
  return (
    <Sparkles
      count={90}
      scale={[GROUND_SIZE * 0.7, 4, GROUND_SIZE * 0.7]}
      position={[0, -1.5, 0]}
      size={0.035}
      speed={0.35}
      opacity={0.35}
      color="#FFD9A0"
    />
  );
}

// ─── Live risk sensors (ESP32 GPS / active digs) placed on the twin ──────────
const SENSOR_COLOR = { LOW: "#3DD68C", MEDIUM: "#F5A623", HIGH: "#FF3D2E", CRITICAL: "#FF6B5E" };

function BeaconPulse({ color }) {
  const ref = useRef();
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const k = (clock.elapsedTime * 1.1) % 1;
    ref.current.scale.setScalar(0.4 + k * 1.8);
    ref.current.material.opacity = 0.5 * (1 - k);
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <ringGeometry args={[0.3, 0.36, 24]} />
      <meshBasicMaterial color={color} transparent side={THREE.DoubleSide} />
    </mesh>
  );
}

function LiveSensors({ sensors }) {
  return (
    <group>
      {sensors.map((s) => {
        const col = SENSOR_COLOR[(s.level || "medium").toLowerCase()] || SENSOR_COLOR.medium;
        return (
          <group key={s.id} position={[s.x, 0, s.z]}>
            <BeaconPulse color={col} />
            {/* staff + beacon */}
            <mesh position={[0, 0.4, 0]}>
              <boxGeometry args={[0.03, 0.8, 0.03]} />
              <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.5} />
            </mesh>
            <mesh position={[0, 0.45, 0]}>
              <sphereGeometry args={[0.17, 18, 18]} />
              <meshStandardMaterial color={col} emissive={col} emissiveIntensity={1.7} />
            </mesh>
            <Float speed={2} floatIntensity={0.4} rotationIntensity={0}>
              <Text position={[0, 0.95, 0]} fontSize={0.2} color={col} anchorX="center" outlineColor="#000" outlineWidth={0.04}>
                {s.score} · {s.label}
              </Text>
            </Float>
          </group>
        );
      })}
    </group>
  );
}

// ─── Full scene ────────────────────────────────────────────────────────────────
function Scene({ utilitiesList, base, excavation, viewCmd, selected, onSelect, digProgress, liveSensors }) {
  const controlsRef = useRef();

  const exc = useMemo(
    () => ({ point: base, depth: excavation.depth, width: excavation.width, length: excavation.length }),
    [base, excavation]
  );

  const lastViewAt = viewCmd?.ts || 0;

  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const bgColor = theme === 'light' ? '#E2E8F0' : '#0B1A2E';

  return (
    <>
      <color attach="background" args={[bgColor]} />
      <fog attach="fog" args={[bgColor, 30, 75]} />

      {/* Golden-hour sky */}
      <Sky
        distance={450000}
        sunPosition={[22, 18, 14]}
        turbidity={7}
        rayleigh={2.2}
        mieCoefficient={0.005}
        mieDirectionalG={0.8}
      />

      {/* Lighting rig — warm sun key, cool sky fill, warm soil bounce */}
      <ambientLight intensity={0.28} />
      <hemisphereLight skyColor="#A9D6FF" groundColor="#2E1B08" intensity={0.6} />
      <directionalLight
        position={[22, 20, 14]} intensity={2.4} color="#FFE0B8"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-22} shadow-camera-right={22}
        shadow-camera-top={22} shadow-camera-bottom={-22}
        shadow-bias={-0.0004}
        shadow-radius={6}
      />
      {/* Underground fill lights */}
      <pointLight position={[0, -2.5, 0]} color="#B8793A" intensity={0.7} distance={18} />
      <pointLight position={[0, -5, 0]} color="#3366CC" intensity={0.9} distance={15} />

      <Terrain size={GROUND_SIZE} />
      <GroundDetail />
      <SoilLayers maxDepth={excavation.depth} />
      <DepthRuler plannedDepth={excavation.depth} />
      <NorthArrow />
      <DangerZoneRing />
      <Dust />

      {/* Soft shadow contact under everything */}
      <ContactShadows position={[0, 0.035, 0]} opacity={0.55} scale={34} blur={2.4} far={13} resolution={1024} color="#020408" />

      {/* Pipes — positioned relative to excavation point */}
      {utilitiesList.map((u) => (
        <UtilityPipe key={u.id} utility={u} base={base} excavation={exc} onSelect={onSelect} selected={selected} digProgress={digProgress} />
      ))}

      {/* Shaft always at scene origin = excavation point */}
      <ExcavationShaft depth={excavation.depth} width={excavation.width} length={excavation.length} onSelect={onSelect} selected={selected} digProgress={digProgress} />
      <WorksiteProps width={excavation.width} length={excavation.length} />
      <LiveSensors sensors={liveSensors} />

      <OrbitControls
        ref={controlsRef}
        enablePan={true}
        minDistance={3}
        maxDistance={38}
        onStart={() => {
          const c = controlsRef.current;
          if (c) { c._interacting = true; c._camDest = null; } // user grabbed view → cancel the tween
        }}
        onEnd={() => {
          if (controlsRef.current)
            setTimeout(() => { if (controlsRef.current) controlsRef.current._interacting = false; }, 3000);
        }}
      />
      <CameraRig controlsRef={controlsRef} viewCmd={viewCmd} depth={excavation.depth} />
      <AutoRotate controlsRef={controlsRef} viewAt={lastViewAt} />
    </>
  );
}

// ─── Read planned excavation from localStorage ─────────────────────────────────
function readPlan() {
  try {
    const s = localStorage.getItem("terratwin_planned_excavation");
    if (!s) return null;
    const p = JSON.parse(s);
    return {
      point:   p.point   || BASE,
      depth:   p.depth   ?? 1.5,
      width:   p.width   ?? 2,
      length:  p.length  ?? 3,
      purpose: p.purpose || "Foundation",
    };
  } catch {
    return null;
  }
}

const VIEW_MODES = [
  { id: "iso", label: "Overview" },
  { id: "dig", label: "Dig site" },
  { id: "plan", label: "Plan view" },
];

// ─── Twin page ─────────────────────────────────────────────────────────────────
export default function Twin() {
  const [utilitiesList, setUtilitiesList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState(() => readPlan() || { point: BASE, depth: 1.5, width: 2, length: 3, purpose: "Foundation" });
  const [viewCmd, setViewCmd] = useState({ mode: "iso", ts: Date.now() });
  const [selected, setSelected] = useState(null);
  const [dig, setDig] = useState({ progress: 0, running: false });

  // Animates the excavation: increments progress until fully dug, then idles.
  useEffect(() => {
    if (!dig.running) return;
    const iv = setInterval(() => {
      setDig((d) => {
        const np = Math.min(d.progress + 0.02, 1);
        return { progress: np, running: np < 1 };
      });
    }, 110);
    return () => clearInterval(iv);
  }, [dig.running]);

  function startDig() {
    setDig((d) => (d.running ? d : { progress: d.progress >= 1 ? 0 : d.progress, running: true }));
  }

  // Live risk sensors from Live Monitoring — replays markers on the twin.
  const [liveSensors, setLiveSensors] = useState([]);
  const planPointLat = plan.point.lat;
  const planPointLng = plan.point.lng;
  useEffect(() => {
    const point = { lat: planPointLat, lng: planPointLng };
    async function load() {
      const [devs, excs] = await Promise.all([api.listDevices(), api.listExcavations()]);
      const list = [];
      (devs || []).forEach((d) => {
        const l = toSceneXZ(point, Number(d.latitude), Number(d.longitude));
        list.push({ id: d.deviceId, x: l.x, z: l.z, level: d.riskLevel || "MEDIUM", score: d.digSafeScore ?? "—", label: d.deviceId });
      });
      (excs || []).filter((e) => e.status === "active").forEach((e) => {
        const l = toSceneXZ(point, Number(e.latitude), Number(e.longitude));
        list.push({
          id: e.id, x: l.x, z: l.z,
          level: e.riskScore != null ? bandFor(e.riskScore) : "LOW",
          score: e.riskScore != null ? Math.round(e.riskScore) : "—",
          label: e.worker || e.id,
        });
      });
      setLiveSensors(list.filter((s) => Math.hypot(s.x, s.z) <= 30));
    }
    load();
    const iv = setInterval(load, 25000);
    return () => clearInterval(iv);
  }, [planPointLat, planPointLng]);

  // Live-sync plan from localStorage every 500 ms.
  useEffect(() => {
    const interval = setInterval(() => {
      const fresh = readPlan();
      if (!fresh) return;
      setPlan((prev) => {
        const changed =
          prev.depth !== fresh.depth ||
          prev.width !== fresh.width ||
          prev.length !== fresh.length ||
          prev.point.lat !== fresh.point.lat ||
          prev.point.lng !== fresh.point.lng;
        return changed ? fresh : prev;
      });
    }, 500);
    const onStorage = () => {
      const fresh = readPlan();
      if (fresh) setPlan(fresh);
    };
    window.addEventListener("storage", onStorage);
    return () => { clearInterval(interval); window.removeEventListener("storage", onStorage); };
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const res = await api.getUtilities();
      if (res?.utilities) setUtilitiesList(res.utilities);
      setLoading(false);
    }
    load();
  }, []);

  async function handleDeleteUtility(id) {
    await api.deleteUtility(id);
    setUtilitiesList((prev) => prev.filter((u) => u.id !== id));
  }

  const nearbyUtilities = useMemo(() => {
    return utilitiesList.filter((u) => metersBetween(plan.point, { lat: u.lat, lng: u.lng }) <= NEARBY_M);
  }, [utilitiesList, plan.point]);

  const zoneItems = useMemo(
    () =>
      nearbyUtilities.map((u) => ({
        u,
        r: scoreUtility({ point: plan.point, depth: plan.depth, width: plan.width, length: plan.length }, u),
      })),
    [nearbyUtilities, plan.point, plan.depth, plan.width, plan.length]
  );
  // A conflict is a pipe the scene actually draws red: inside the danger radius
  // AND scored above LOW. This keeps the badge/count in sync with the 3D view.
  const conflictCount = useMemo(
    () => zoneItems.filter((i) => i.r.dist <= DANGER_RADIUS_M && i.r.level !== "LOW").length,
    [zoneItems]
  );

  const isCurrentlyColliding = useMemo(() => {
    const currentDepth = dig.progress * plan.depth;
    return zoneItems.some(({ u, r }) => {
      const isConflict = r.dist <= DANGER_RADIUS_M && r.level !== "LOW";
      return isConflict && currentDepth >= (u.depth - 0.25) && currentDepth <= (u.depth + 0.25);
    });
  }, [zoneItems, dig.progress, plan.depth]);

  const hiddenCount = utilitiesList.length - nearbyUtilities.length;

  // Selection for tap-to-inspect
  const selectedUtility = useMemo(
    () => nearbyUtilities.find((u) => u.id === selected) || null,
    [selected, nearbyUtilities]
  );
  const selectedRisk = useMemo(
    () => (selectedUtility ? scoreUtility({ point: plan.point, depth: plan.depth, width: plan.width, length: plan.length }, selectedUtility) : null),
    [selectedUtility, plan]
  );

  // Live site snapshot — fills the space below the twin with the same real
  // inputs the scene shows: overall site risk, conflicts, and sensor status.
  const siteRisk = useMemo(
    () => scoreExcavation({ point: plan.point, depth: plan.depth, width: plan.width, length: plan.length }, nearbyUtilities),
    [nearbyUtilities, plan.point, plan.depth, plan.width, plan.length]
  );
  const worstLiveLevel = useMemo(() => {
    const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
    return order.find((lvl) => liveSensors.some((s) => (s.level || "MEDIUM").toUpperCase() === lvl)) || null;
  }, [liveSensors]);
  const RISK_ACCENT = { CRITICAL: "text-red", HIGH: "text-amber", MEDIUM: "text-amber", LOW: "text-green-400" };

  return (
    <section>
      <div className="grid lg:grid-cols-[1fr_290px] gap-5">

        {/* ── Left column: 3D canvas + live site snapshot ─────────── */}
        <div className="flex flex-col gap-4">

        {/* ── 3D Canvas ─────────────────────────────────────────── */}
        <div className="relative h-[640px] rounded-lg border border-[var(--border)] overflow-hidden shadow-2xl bg-[#0B1A2E]">

          {/* HUD overlay — top-left */}
          <div className="absolute top-3 left-4 z-10 pointer-events-none select-none space-y-1">
            <div className="font-mono text-[9.5px] text-white/35 tracking-widest">
              DRAG · SCROLL · RIGHT-DRAG TO PAN
            </div>
            <div className="font-mono text-[9.5px] text-[var(--text-dim)]">
              {plan.point.lat.toFixed(5)}°, {plan.point.lng.toFixed(5)}°
            </div>
            <div className="font-mono text-[9.5px] text-white/40">
              1 scene unit = 1 metre · depth 1:1 scale
            </div>
          </div>

          {/* Conflict badge — top-right */}
          {conflictCount > 0 && (
            <div className="absolute top-3 right-4 z-10 bg-[var(--bg-panel-2)] border border-red-400/40 rounded-lg px-3 py-1.5 font-mono text-[11px] text-red font-semibold">
              ⚠ {conflictCount} CONFLICT{conflictCount > 1 ? "S" : ""} IN ZONE
            </div>
          )}

          {/* Live sensor badge */}
          {liveSensors.length > 0 && (
            <div className="absolute top-14 right-4 z-10 bg-[#0C1626]/80 border border-green-400/40 rounded-lg px-3 py-1.5 font-mono text-[11px] text-green-400">
              ● {liveSensors.length} LIVE SENSOR{liveSensors.length > 1 ? "S" : ""}
            </div>
          )}

          {/* View presets — bottom-left */}
          <div className="absolute bottom-3 left-4 z-10 flex items-center gap-1.5">
            {VIEW_MODES.map((v) => (
              <button
                key={v.id}
                onClick={() => setViewCmd({ mode: v.id, ts: Date.now() })}
                className={`font-mono text-[10.5px] px-3 py-1.5 rounded-md border transition ${
                  viewCmd.mode === v.id
                    ? "border-cyan bg-cyan/15 text-cyan"
                    : "border-white/15 bg-black/40 text-white/50 hover:text-white hover:border-white/40"
                }`}
              >
                {v.label}
              </button>
            ))}
            <span className="ml-1 font-mono text-[9px] text-white/30 pointer-events-none">· auto-orbits</span>
          </div>

{/* Live-sync badge */}
          <div className="absolute bottom-3 right-4 z-10 font-mono text-[9px] text-green-400/60 pointer-events-none">
            ● LIVE — synced from Planner
          </div>

          {/* Inspect card — tap/click a pipe or the shaft */}
          {(selectedUtility || selected === "excavation") && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-14 z-20 w-[320px] max-w-[92%] bg-[#0C1626]/95 backdrop-blur border border-cyan/30 rounded-lg shadow-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between bg-cyan/10">
                <span className="font-mono text-[10px] tracking-[0.18em] text-cyan">
                  {selectedUtility ? "UTILITY INSPECT" : "EXCAVATION SHAFT"}
                </span>
                <button
                  onClick={() => setSelected(null)}
                  aria-label="Close"
                  className="w-5 h-5 rounded flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition"
                >
                  ✕
                </button>
              </div>
              <div className="px-4 py-3 text-[12px] leading-relaxed">
                {selectedUtility ? (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="inline-block w-3 h-3 rounded-full" style={{ background: selectedUtility.color || (PIPE_MATS[selectedUtility.type]?.color || "#888") }} />
                      <span className="font-semibold text-white/90">{selectedUtility.type[0].toUpperCase() + selectedUtility.type.slice(1)} utility</span>
                      {selectedRisk && selectedRisk.level !== "LOW" && (
                        <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-md ${selectedRisk.level === "CRITICAL" ? "bg-[var(--bg-panel-2)] text-red" : "bg-[var(--bg-panel-2)] text-amber"}`}>
                          {selectedRisk.level}
                        </span>
                      )}
                    </div>
                    <InfoLine label="Depth" value={selectedUtility.depth ? `${selectedUtility.depth} m below grade` : "—"} />
                    <InfoLine label="Material" value={selectedUtility.material || PIPE_MATS[selectedUtility.type]?.paint || "—"} />
                    {selectedRisk && <InfoLine label="Clearance" value={selectedRisk.dist ? `${selectedRisk.dist.toFixed(2)} m from shaft` : "—"} />}
                    <InfoLine label="Recorded by" value={selectedUtility.owner || "Authority registry"} />
                    <InfoLine label="Confidence" value={selectedUtility.confidence != null ? `${selectedUtility.confidence}%` : "—"} />
                    <div className="mt-2 text-[10.5px] text-cyan-200/70 font-mono">
                      ✔ Click another pipe to switch · click ground to deselect
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mb-2 font-semibold text-white/90">Planned excavation</div>
                    <InfoLine label="Purpose" value={plan.purpose} />
                    <InfoLine label="Dimensions" value={`${plan.width} w × ${plan.length} l × ${plan.depth} d m`} />
                    <InfoLine label="Volume" value={`${(plan.depth * plan.width * plan.length).toFixed(2)} m³`} />
                    <div className="mt-2 text-[10.5px] text-cyan-200/70 font-mono">
                      Shored trench · hazard shields · spoil removed
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          {loading ? (
            <LoadingState label="Loading utilities…" />
          ) : (
            <Canvas
              shadows
              dpr={[1, 1.75]}
              camera={{ position: [16, 7.5, 16], fov: 42 }}
              gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.12 }}
              onPointerMissed={() => setSelected(null)}
            >
              <Suspense fallback={null}>
                <Scene utilitiesList={nearbyUtilities} base={plan.point} excavation={plan} viewCmd={viewCmd} selected={selected} onSelect={setSelected} digProgress={dig.progress} liveSensors={liveSensors} />
              </Suspense>
            </Canvas>
          )}
        </div>

        {/* ── Live site snapshot — puts the space below the twin to work ── */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <SnapshotTile
            label="SITE RISK"
            value={siteRisk.level}
            accent={RISK_ACCENT[siteRisk.level] || "text-[var(--text)]"}
            sub={nearbyUtilities.length === 0
              ? "clear site · no utilities within 15 m"
              : `score ${Math.round(siteRisk.overall)} / 100 · ${conflictCount} in danger zone`}
          />
          <SnapshotTile
            label="CONFLICTS IN ZONE"
            value={String(conflictCount)}
            accent={conflictCount > 0 ? "text-red" : "text-green-400"}
            sub={`within ${DANGER_RADIUS_M} m danger ring`}
          />
          <SnapshotTile
            label="UTILITIES NEARBY"
            value={`${nearbyUtilities.length} / ${utilitiesList.length}`}
            accent="text-[var(--text)]"
            sub={hiddenCount > 0 ? `+${hiddenCount} beyond ${NEARBY_M} m hidden` : "all registry records shown"}
          />
          <SnapshotTile
            label="LIVE SENSORS"
            value={String(liveSensors.length)}
            accent={worstLiveLevel ? RISK_ACCENT[worstLiveLevel] : "text-[var(--text-dim)]"}
            sub={worstLiveLevel ? `worst level ${worstLiveLevel}` : "no active sensors on site"}
          />
        </div>

        {/* ── Utilities in zone + live sensors — fills the remaining space ── */}
        <div className="grid md:grid-cols-2 gap-3">
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-semibold text-[14px]">Utilities in zone</h3>
              <span className="font-mono text-[10px] text-[var(--text-faint)]">≤ {NEARBY_M} m shown</span>
            </div>
            {zoneItems.length === 0 ? (
              <div className="py-3 text-[11px] text-[var(--text-faint)] italic text-center border border-dashed border-white/5 rounded-lg">
                No utilities within {NEARBY_M} m of the excavation point.
              </div>
            ) : (
              <ul className="divide-y divide-white/5">
                {zoneItems.map(({ u, r }) => {
                  const mat = PIPE_MATS[u.type] || PIPE_MATS.fiber;
                  const conflict = r.dist <= DANGER_RADIUS_M && r.level !== "LOW";
                  return (
                    <li key={u.id} className="flex items-center justify-between py-2 text-xs">
                      <span className="flex items-center gap-2" style={{ color: conflict ? "#FF3D2E" : mat.color }}>
                        <span className="inline-block w-2 h-2 rounded-full" style={{ background: conflict ? "#FF3D2E" : mat.color }} />
                        <span className="font-semibold">{u.type[0].toUpperCase() + u.type.slice(1)}</span>
                        {conflict && <span className="font-bold">⚠</span>}
                      </span>
                      <div className="flex items-center gap-3 font-mono text-[10.5px] text-[var(--text-dim)]">
                        <span>{r.dist.toFixed(1)} m</span>
                        <span>{u.depth} m deep</span>
                        <span className={`font-semibold ${r.level === "LOW" ? "text-green-400/70" : r.level === "CRITICAL" ? "text-red" : "text-amber"}`}>{r.level}</span>
                        {u.id.includes("-D") && (
                          <button
                            onClick={() => handleDeleteUtility(u.id)}
                            title="Delete utility"
                            className="text-red-400 hover:text-red hover:bg-red/10 w-5 h-5 rounded flex items-center justify-center font-bold text-[10px] transition"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-semibold text-[14px]">Live sensors & devices</h3>
              <span className="font-mono text-[10px] text-[var(--text-faint)]">{liveSensors.length} on twin</span>
            </div>
            {liveSensors.length === 0 ? (
              <div className="py-3 text-[11px] text-[var(--text-faint)] italic text-center border border-dashed border-white/5 rounded-lg">
                No active devices or digs on the twin yet.
              </div>
            ) : (
              <ul className="divide-y divide-white/5">
                {liveSensors.map((s) => {
                  const lvl = (s.level || "MEDIUM").toUpperCase();
                  return (
                    <li key={s.id} className="flex items-center justify-between py-2 text-xs">
                      <span className="flex items-center gap-2">
                        <span className="inline-block w-2 h-2 rounded-full" style={{ background: SENSOR_COLOR[lvl] || SENSOR_COLOR.MEDIUM }} />
                        <span className="font-mono text-[11px] text-white/85">{s.label}</span>
                      </span>
                      <div className="flex items-center gap-3 font-mono text-[10.5px] text-[var(--text-dim)]">
                        <span>{s.score}</span>
                        <span className={`font-semibold ${lvl === "CRITICAL" ? "text-red" : lvl === "LOW" ? "text-green-400/70" : "text-amber"}`}>{lvl}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        </div>

        {/* ── Side panel ────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">

          {/* Excavation plan summary */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-4">
            <h3 className="font-display font-semibold text-[14px] mb-3 text-red-400">
              Planned Excavation
            </h3>
            <div className="space-y-2 font-mono text-[11.5px]">
              <Row label="Purpose" value={plan.purpose} />
              <Row label="Depth" value={`${plan.depth} m`} />
              <Row label="Width" value={`${plan.width} m`} />
              <Row label="Length" value={`${plan.length} m`} />
              <Row label="Volume" value={`${(plan.depth * plan.width * plan.length).toFixed(2)} m³`} />
              <div className="pt-1 border-t border-white/5">
                <Row label="Location" value={`${plan.point.lat.toFixed(5)}, ${plan.point.lng.toFixed(5)}`} />
              </div>
            </div>
            <div className="mt-3 text-[10px] text-green-400/70 font-mono">
              ● Syncs live from Planner every 500 ms
            </div>

            {/* Dig simulation control */}
            <div className="mt-3 pt-3 border-t border-white/10">
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-[10px] text-[var(--text-faint)]">
                  EXCAVATION SIM
                </span>
                <span className="font-mono text-[11px] text-white/80 font-bold">
                  {Math.round(dig.progress * 100)}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-black/40 overflow-hidden mb-2.5">
                <div
                  className={`h-full rounded-full transition-all duration-150 ${dig.running ? "bg-gradient-to-r from-amber to-cyan" : "bg-cyan/70"}`}
                  style={{ width: `${dig.progress * 100}%` }}
                />
              </div>
              <button
                onClick={startDig}
                disabled={dig.running}
                className={`w-full font-semibold text-xs px-3 py-2 rounded-md border transition mb-3 ${
                  dig.running
                    ? "border-white/10 text-white/30 cursor-not-allowed bg-black/10"
                    : "border-amber/50 bg-amber/15 text-amber hover:bg-amber/25"
                }`}
              >
                {dig.running ? "Digging…" : dig.progress <= 0 ? "Dig excavation" : dig.progress >= 0.999 ? "Replay excavation" : "Resume excavation"}
              </button>

              <div className="border-t border-white/5 pt-2">
                <label className="flex items-center justify-between text-[10.5px] font-mono text-[var(--text-dim)] mb-1">
                  <span>Scrub depth manually:</span>
                  <span className="text-cyan font-bold">{(dig.progress * plan.depth).toFixed(2)} m</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={dig.progress}
                  onChange={(e) => setDig({ progress: parseFloat(e.target.value), running: false })}
                  className="w-full h-1 bg-black/40 rounded-lg appearance-none cursor-pointer accent-cyan"
                />
              </div>

              {isCurrentlyColliding && (
                <div className="mt-3 bg-red-500/15 border border-red-500/40 text-red text-[11px] rounded p-2.5 font-semibold animate-pulse leading-snug">
                  ⚠ STRIKE WARNING: Excavation depth has intersected a utility pipe! Sparks and warning indicators have triggered on the digital twin.
                </div>
              )}
            </div>
          </div>

          {/* Underground layer registry */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-semibold text-[14px]">Layer Registry</h3>
              <span className="font-mono text-[10px] text-[var(--text-faint)]">≤ {NEARBY_M} m shown</span>
            </div>

            {nearbyUtilities.length === 0 ? (
              <div className="py-3 text-[11px] text-[var(--text-faint)] italic text-center border border-dashed border-white/5 rounded-lg">
                No utilities within {NEARBY_M} m of excavation point.
              </div>
            ) : (
              nearbyUtilities.map((u) => {
                const mat = PIPE_MATS[u.type] || PIPE_MATS.fiber;
                const dist = metersBetween(plan.point, { lat: u.lat, lng: u.lng });
                const risk = scoreUtility({ point: plan.point, depth: plan.depth, width: plan.width, length: plan.length }, u);
                const isConflict = dist <= DANGER_RADIUS_M && risk.level !== "LOW";
                const isDeletable = u.id.includes("-D");
                return (
                  <div
                    key={u.id}
                    className={`flex justify-between items-center text-xs py-2 border-b border-white/5 last:border-none ${isConflict ? "bg-red-500/8 rounded px-1" : ""}`}
                  >
                    <span style={{ color: isConflict ? "#FF3D2E" : mat.color }} className="flex items-center gap-1.5">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: isConflict ? "#FF3D2E" : mat.color, boxShadow: `0 0 5px ${isConflict ? "#FF3D2E" : mat.color}` }}
                      />
                      <span>{u.type[0].toUpperCase() + u.type.slice(1)}</span>
                      {isConflict && <span className="font-bold">⚠</span>}
                    </span>
                    <div className="flex items-center gap-2">
                      <div className="text-right">
                        <div className="text-[var(--text-dim)]">{u.depth} m deep</div>
                        <div className="text-[10px] text-[var(--text-faint)]">{dist.toFixed(1)} m away</div>
                      </div>
                      {isDeletable && (
                        <button
                          onClick={() => handleDeleteUtility(u.id)}
                          title="Delete utility"
                          className="text-red-400 hover:text-red hover:bg-red/10 w-5 h-5 rounded flex items-center justify-center font-bold text-[10px] transition"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {/* Excavation entry */}
            <div className="flex justify-between items-center text-xs pt-2 mt-1 border-t border-white/5">
              <span className="text-red-400 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-sm border border-red-400" />
                Excavation shaft
              </span>
              <span className="text-[var(--text-dim)]">{plan.depth} m</span>
            </div>

            {hiddenCount > 0 && (
              <div className="mt-2 text-[10px] text-[var(--text-faint)] text-center font-mono">
                +{hiddenCount} utilities beyond {NEARBY_M} m hidden
              </div>
            )}
          </div>

          {/* Locate paint legend */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-4">
            <h3 className="font-display font-semibold text-[14px] mb-2.5">Locate paint (surface)</h3>
            <div className="space-y-1.5">
              {[
                { color: "#42A5F5", label: "Water" },
                { color: "#F44336", label: "Electric" },
                { color: "#FF9800", label: "Fiber / comms" },
                { color: "#FDD835", label: "Gas" },
                { color: "#4CAF50", label: "Sewer" },
              ].map((l) => (
                <div key={l.label} className="flex items-center gap-2 text-[11.5px] text-[var(--text-dim)]">
                  <span className="inline-block w-4 h-[3px] rounded" style={{ background: l.color }} />
                  {l.label}
                </div>
              ))}
            </div>
          </div>

          {/* Soil legend */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-4">
            <h3 className="font-display font-semibold text-[14px] mb-2.5">Soil Layers</h3>
            {[
              { depth: "0–1 m", label: "Topsoil", color: "#7A5C30" },
              { depth: "1–2 m", label: "Clay", color: "#6B4C22" },
              { depth: "2–3 m", label: "Subsoil", color: "#5A3D18" },
              { depth: "3 m+", label: "Bedrock", color: "#4A2E10" },
            ].map((l) => (
              <div key={l.depth} className="flex items-center gap-2 text-xs py-1 text-[var(--text-dim)]">
                <span className="w-3 h-3 rounded-sm border border-white/20" style={{ background: l.color }} />
                <span className="text-white/70 w-10">{l.depth}</span>
                <span>{l.label}</span>
              </div>
            ))}
          </div>

          {/* Danger zone legend */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-3.5 text-[11.5px] text-[var(--text-dim)] leading-relaxed">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-3 h-3 rounded-full border-2 border-red-500" />
              <span className="text-red-400 font-semibold text-xs">Red ring = {DANGER_RADIUS_M} m danger zone</span>
            </div>
            <p>Pipes <span className="text-red-400">inside the ring</span> glow red and are marked ⚠ in the registry. Orbit below ground to inspect depth clearance.</p>
            <p className="mt-2 text-[10.5px] text-[var(--text-faint)] italic">
              Each utility is one recorded point, not a surveyed route — line length shown near the shaft is
              capped so it never implies a conflict the score doesn&rsquo;t confirm. Locate paint, paint color
              follows the industry ground-marking code.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Small helper ──────────────────────────────────────────────────────────────
function Row({ label, value }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-[var(--text-faint)]">{label}</span>
      <span className="text-white/80 font-mono text-right">{value}</span>
    </div>
  );
}

function InfoLine({ label, value }) {
  return (
    <div className="flex justify-between items-baseline gap-3 py-1">
      <span className="text-[var(--text-faint)] whitespace-nowrap">{label}</span>
      <span className="text-white/85 font-mono text-right">{value}</span>
    </div>
  );
}

function SnapshotTile({ label, value, accent, sub }) {
  return (
    <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-3">
      <div className="font-mono text-[9.5px] tracking-[0.18em] text-[var(--text-faint)]">{label}</div>
      <div className={`mt-1 text-[22px] leading-none font-bold font-mono ${accent || "text-[var(--text)]"}`}>{value}</div>
      <div className="mt-1.5 text-[10.5px] text-[var(--text-dim)] leading-snug">{sub}</div>
    </div>
  );
}