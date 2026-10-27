import type { ReactNode } from "react";

import type { AreaRating } from "./sample-player";

const CENTER = 100;
const RADIUS = 78;
const LABEL_RADIUS = 98;
const MAX_RATING = 99;
const GRID_STEPS = [0.25, 0.5, 0.75, 1];

function pointAt(index: number, count: number, distance: number): readonly [number, number] {
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  return [CENTER + Math.cos(angle) * distance, CENTER + Math.sin(angle) * distance];
}

function polygon(count: number, distanceFor: (index: number) => number): string {
  return Array.from({ length: count }, (_, index) =>
    pointAt(index, count, distanceFor(index))
      .map((value) => value.toFixed(1))
      .join(","),
  ).join(" ");
}

export function AreaRadar({ areas }: { areas: readonly AreaRating[] }): ReactNode {
  const count = areas.length;
  const shape = polygon(count, (index) => (RADIUS * (areas[index]?.rating ?? 0)) / MAX_RATING);

  return (
    <svg aria-hidden="true" className="area-radar h-auto w-full" viewBox="-24 -6 248 212">
      {GRID_STEPS.map((step) => (
        <polygon className="radar-grid" key={step} points={polygon(count, () => RADIUS * step)} />
      ))}
      {areas.map((area, index) => {
        const [x, y] = pointAt(index, count, RADIUS);
        return (
          <line className="radar-grid" key={area.short} x1={CENTER} x2={x} y1={CENTER} y2={y} />
        );
      })}
      <polygon className="radar-shape" points={shape} />
      {areas.map((area, index) => {
        const [x, y] = pointAt(index, count, (RADIUS * area.rating) / MAX_RATING);
        return <circle className="radar-dot" cx={x} cy={y} key={area.short} r="3" />;
      })}
      {areas.map((area, index) => {
        const [x, y] = pointAt(index, count, LABEL_RADIUS);
        return (
          <text
            className="radar-label"
            dominantBaseline="middle"
            key={area.short}
            textAnchor="middle"
            x={x}
            y={y}
          >
            {area.short}
          </text>
        );
      })}
    </svg>
  );
}
