// The Pages builder provides static portraits. The server build uses its own public assets.
const portraits =
  typeof __HC_PORTRAITS__ === "undefined" ? null : __HC_PORTRAITS__;
export const browserDemo = portraits !== null;
export const hostPhoto = (id) => portraits?.[id] ?? `/hosts/${id}.jpg`;

// Pages embeds the photos so the downloadable HTML also works offline.
const moments = typeof __HC_MOMENTS__ === "undefined" ? null : __HC_MOMENTS__;
export const momentPhoto = (id) => moments?.[id] ?? `/moments/${id}.webp`;
