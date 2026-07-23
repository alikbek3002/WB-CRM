// Категориальная палитра (тёмная тема), провалидирована dataviz-валидатором:
// lightness band / chroma / contrast — PASS; CVD 10.3 (floor band) — поэтому
// у доната обязательны прямые подписи в легенде и 2px зазоры между сегментами.
export const SERIES = [
  "#3987e5", // blue
  "#199e70", // aqua
  "#c98500", // yellow
  "#008300", // green
  "#9085e9", // violet
  "#e66767", // red
] as const;

export const PRIMARY = SERIES[0];

export const GRID_STROKE = "rgba(255,255,255,0.07)";
export const AXIS_TICK = { fill: "#9b9b93", fontSize: 11 } as const;

export const TOOLTIP_STYLE = {
  backgroundColor: "#232323",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  fontSize: 12,
  color: "#ececec",
} as const;
