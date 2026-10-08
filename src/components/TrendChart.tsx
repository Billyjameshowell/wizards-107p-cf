import { useEffect, useId, useRef, useState } from "react";
import type { PriceProjection } from "@shared/price-model";
import { formatMoney } from "@shared/format";

const NAVY = "#0c2340";
const GOLD = "#8a6a2f";
const GREEN = "#1f5c32";
const RED = "#8a1f1f";
const MUTED = "#5c6574";
const GRID = "#e4ddd0";
const TIP = "#c4a36a";

type Point = { date: string; median: number; cheapest: number | null };

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(280, Math.round(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function epoch(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`) / 86_400_000;
}

function monthDay(ymd: string): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return ymd;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function niceStep(span: number): number {
  const rough = span / 4;
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

function ticks(min: number, max: number): number[] {
  const step = niceStep(max - min || 1);
  const start = Math.ceil(min / step) * step;
  const values: number[] = [];
  for (let value = start; value <= max + step * 0.01; value += step) {
    if (value >= min - step * 0.01) values.push(Math.round(value * 100) / 100);
    if (values.length > 6) break;
  }
  return values;
}

function dollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function LegendSwatch({ stroke, dashed = false }: { stroke: string; dashed?: boolean }) {
  return (
    <svg width="28" height="10" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        y1="5"
        x2="27"
        y2="5"
        stroke={stroke}
        strokeWidth="2.5"
        strokeDasharray={dashed ? "4 3" : undefined}
      />
    </svg>
  );
}

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length === 0) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const last = values[values.length - 1] ?? min;
  const first = values[0] ?? min;
  const stroke = last > first + 0.005 ? "#1f5c32" : last < first - 0.005 ? "#8a1f1f" : NAVY;
  const coords = values.map((value, index) => {
    const x = values.length === 1 ? 48 : (index / (values.length - 1)) * 96;
    const y = 24 - ((value - min) / span) * 18;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox="0 0 96 28" className="h-8 w-24 shrink-0" role="img" aria-label={label}>
      {values.length > 1 ? (
        <polyline fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" points={coords.join(" ")} />
      ) : null}
      <circle cx={coords[coords.length - 1]?.split(",")[0]} cy={coords[coords.length - 1]?.split(",")[1]} r="2.4" fill={stroke} />
    </svg>
  );
}

export function PriceTrendChart({
  points,
  ask,
  today,
  gameDate,
  projection,
  title,
}: {
  points: Point[];
  ask: number | null;
  today: string;
  gameDate: string;
  projection: PriceProjection;
  title: string;
}) {
  const { ref, width } = useWidth();
  const labelId = useId();
  const height = width < 520 ? 248 : 300;
  const pad = { left: 52, right: 14, top: 16, bottom: 32 };
  const plotBottom = height - pad.bottom;
  const plotRight = width - pad.right;

  if (points.length === 0) {
    return (
      <div ref={ref} className="rounded-xl border border-dashed border-line bg-[#faf8f4] px-4 py-8 text-center text-sm text-muted-foreground">
        No similar-seat prices yet for this game.
      </div>
    );
  }

  const dates = points.map((point) => point.date);
  const xMin = Math.min(epoch(dates[0] ?? today), epoch(today));
  const xMax = Math.max(epoch(dates[dates.length - 1] ?? today), epoch(today), epoch(gameDate));
  const xSpan = xMax - xMin || 1;
  const xOf = (ymd: string) => pad.left + ((epoch(ymd) - xMin) / xSpan) * (plotRight - pad.left);

  const values: number[] = [];
  for (const point of points) {
    values.push(point.median);
    if (point.cheapest != null) values.push(point.cheapest);
  }
  if (ask != null) values.push(ask);
  if (projection.enough && projection.low != null && projection.high != null && projection.price != null) {
    values.push(projection.low, projection.high, projection.price);
  }
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  const yPad = Math.max(4, (yMax - yMin) * 0.12);
  yMin -= yPad;
  yMax += yPad;
  if (yMax - yMin < 8) {
    yMin -= 4;
    yMax += 4;
  }
  const ySpan = yMax - yMin || 1;
  const yOf = (value: number) => plotBottom - ((value - yMin) / ySpan) * (plotBottom - pad.top);

  const medianLine = points
    .map((point) => `${xOf(point.date).toFixed(1)},${yOf(point.median).toFixed(1)}`)
    .join(" ");
  const cheapPoints = points.filter((point) => point.cheapest != null);
  const cheapLine = cheapPoints
    .map((point) => `${xOf(point.date).toFixed(1)},${yOf(point.cheapest ?? 0).toFixed(1)}`)
    .join(" ");
  const yTicks = ticks(yMin + yPad * 0.2, yMax - yPad * 0.2);
  const showDots = points.length <= 24;
  const todayX = xOf(today);
  const tipX = xOf(gameDate);

  return (
    <figure className="m-0">
      <div ref={ref}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={labelId}
          className="block max-w-full"
        >
          <title id={labelId}>{title}</title>
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={pad.left} x2={plotRight} y1={yOf(tick)} y2={yOf(tick)} stroke={GRID} />
              <text x={pad.left - 8} y={yOf(tick) + 4} textAnchor="end" fill={MUTED} fontSize="12">
                {dollars(tick)}
              </text>
            </g>
          ))}
          <line x1={todayX} x2={todayX} y1={pad.top} y2={plotBottom} stroke={RED} strokeDasharray="3 3" strokeWidth="1.5" />
          <line x1={tipX} x2={tipX} y1={pad.top} y2={plotBottom} stroke={TIP} strokeWidth="2" />
          {ask != null ? (
            <line
              x1={pad.left}
              x2={plotRight}
              y1={yOf(ask)}
              y2={yOf(ask)}
              stroke={GREEN}
              strokeWidth="1.75"
              strokeDasharray="5 4"
            />
          ) : null}
          {cheapPoints.length > 1 ? (
            <polyline fill="none" stroke={GOLD} strokeWidth="2" strokeLinejoin="round" points={cheapLine} />
          ) : null}
          {points.length > 1 ? (
            <polyline fill="none" stroke={NAVY} strokeWidth="2.5" strokeLinejoin="round" points={medianLine} />
          ) : null}
          {showDots
            ? points.map((point) => (
                <circle key={point.date} cx={xOf(point.date)} cy={yOf(point.median)} r="3.5" fill={NAVY}>
                  <title>{`${monthDay(point.date)}: median ${formatMoney(point.median)}`}</title>
                </circle>
              ))
            : null}
          {showDots
            ? cheapPoints.map((point) => (
                <circle key={`c-${point.date}`} cx={xOf(point.date)} cy={yOf(point.cheapest ?? 0)} r="3" fill={GOLD}>
                  <title>{`${monthDay(point.date)}: cheapest ${formatMoney(point.cheapest)}`}</title>
                </circle>
              ))
            : null}
          {projection.enough && projection.price != null && projection.low != null && projection.high != null ? (
            <g>
              <line
                x1={tipX}
                x2={tipX}
                y1={yOf(projection.low)}
                y2={yOf(projection.high)}
                stroke={NAVY}
                strokeWidth="4"
                strokeLinecap="round"
                opacity="0.35"
              />
              <circle cx={tipX} cy={yOf(projection.price)} r="5" fill="#f6f3ea" stroke={NAVY} strokeWidth="2">
                <title>{`Rough game-day price ${dollars(projection.price)}`}</title>
              </circle>
            </g>
          ) : null}
          <text x={pad.left} y={height - 8} fill={MUTED} fontSize="12">
            {monthDay(dates[0] ?? today)}
          </text>
          <text x={plotRight} y={height - 8} textAnchor="end" fill={MUTED} fontSize="12">
            {monthDay(gameDate)}
          </text>
        </svg>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-[#3d4654]">
        <span className="inline-flex items-center gap-1.5">
          <LegendSwatch stroke={NAVY} /> Median of similar seats
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LegendSwatch stroke={GOLD} /> Cheapest similar seat
        </span>
        {ask != null ? (
          <span className="inline-flex items-center gap-1.5">
            <LegendSwatch stroke={GREEN} dashed /> Your ask today
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <LegendSwatch stroke={RED} dashed /> Today
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LegendSwatch stroke={TIP} /> Tip
        </span>
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Median of similar seats</th>
            <th>Cheapest similar seat</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td>{formatMoney(point.median)}</td>
              <td>{formatMoney(point.cheapest)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function DaysOutChart({
  curve,
  dots,
}: {
  curve: { daysOut: number; index: number; count: number }[];
  dots: { daysOut: number; index: number }[];
}) {
  const { ref, width } = useWidth();
  const labelId = useId();
  const height = width < 520 ? 240 : 280;
  const pad = { left: 48, right: 14, top: 16, bottom: 32 };
  const clipId = useId().replace(/:/g, "");
  const plotBottom = height - pad.bottom;
  const plotRight = width - pad.right;

  if (dots.length === 0) {
    return (
      <div ref={ref} className="rounded-xl border border-dashed border-line bg-[#faf8f4] px-4 py-8 text-center text-sm text-muted-foreground">
        Not enough price checks yet to see how seats move as tip gets closer.
      </div>
    );
  }

  const maxDays = Math.max(14, ...dots.map((dot) => dot.daysOut));
  const indexes = dots.map((dot) => dot.index * 100);
  for (const bucket of curve) indexes.push(bucket.index * 100);
  indexes.push(100);
  const sorted = indexes.slice().sort((a, b) => a - b);
  const quantile = (q: number) => {
    const index = (sorted.length - 1) * q;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    const left = sorted[low] ?? 100;
    const right = sorted[high] ?? left;
    return left + (right - left) * (index - low);
  };
  // One wild check should not flatten the season pattern.
  let yMin = Math.min(100, quantile(0.05));
  let yMax = Math.max(100, quantile(0.95));
  const yPad = Math.max(4, (yMax - yMin) * 0.2);
  yMin -= yPad;
  yMax += yPad;
  const xOf = (days: number) => pad.left + ((maxDays - days) / maxDays) * (plotRight - pad.left);
  const yOf = (percent: number) => plotBottom - ((percent - yMin) / (yMax - yMin || 1)) * (plotBottom - pad.top);
  const step = maxDays > 160 ? 60 : maxDays > 80 ? 30 : 14;
  const xTicks = [0];
  for (let days = step; days < maxDays; days += step) xTicks.push(days);
  const yTicks = ticks(yMin, yMax);
  const line = curve
    .slice()
    .sort((a, b) => b.daysOut - a.daysOut)
    .map((bucket) => `${xOf(bucket.daysOut).toFixed(1)},${yOf(bucket.index * 100).toFixed(1)}`)
    .join(" ");

  return (
    <figure className="m-0">
      <div ref={ref}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={labelId} className="block max-w-full">
          <title id={labelId}>
            Similar-seat prices compared with each game’s first median, by days before tip.
          </title>
          <defs>
            <clipPath id={clipId}>
              <rect x={pad.left} y={pad.top} width={plotRight - pad.left} height={plotBottom - pad.top} />
            </clipPath>
          </defs>
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={pad.left} x2={plotRight} y1={yOf(tick)} y2={yOf(tick)} stroke={GRID} />
              <text x={pad.left - 8} y={yOf(tick) + 4} textAnchor="end" fill={MUTED} fontSize="12">
                {`${Math.round(tick)}%`}
              </text>
            </g>
          ))}
          <line
            x1={pad.left}
            x2={plotRight}
            y1={yOf(100)}
            y2={yOf(100)}
            stroke={MUTED}
            strokeDasharray="4 4"
            strokeWidth="1.25"
          />
          <g clipPath={`url(#${clipId})`}>
            {dots.map((dot, index) => (
              <circle
                key={`${dot.daysOut}-${index}`}
                cx={xOf(dot.daysOut)}
                cy={yOf(dot.index * 100)}
                r="3"
                fill={NAVY}
                opacity="0.28"
              />
            ))}
            {curve.length > 1 ? (
              <polyline fill="none" stroke={NAVY} strokeWidth="2.5" strokeLinejoin="round" points={line} />
            ) : null}
          </g>
          {xTicks.map((days) => (
            <text key={days} x={xOf(days)} y={height - 8} textAnchor={days === 0 ? "end" : "middle"} fill={MUTED} fontSize="12">
              {days === 0 ? "Tip" : `${days}d`}
            </text>
          ))}
        </svg>
      </div>
      <figcaption className="mt-2 text-sm leading-relaxed text-[#3d4654]">
        Each game starts at 100% of the first median we saw for it. Dots are later checks. The line is the middle of
        those checks at that many days before tip.
      </figcaption>
    </figure>
  );
}
