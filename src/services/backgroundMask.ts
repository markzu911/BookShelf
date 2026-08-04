export interface BackgroundRemovalResult {
  pixels: Uint8ClampedArray;
  transparentEdgeRatio: number;
  opaquePixelRatio: number;
}

interface Color {
  red: number;
  green: number;
  blue: number;
}

const COLOR_BUCKET_SIZE = 16;
const MAX_BACKGROUND_COLORS = 12;

/**
 * Removes a generated studio background without touching enclosed product pixels.
 * It supports true transparency, a green screen, a flat backdrop and the
 * gray/white checkerboard that image models sometimes bake into "transparent" PNGs.
 */
export function removeConnectedStudioBackground(
  source: Uint8ClampedArray,
  width: number,
  height: number
): BackgroundRemovalResult {
  if (width <= 0 || height <= 0 || source.length !== width * height * 4) {
    throw new Error("无效的柜体前景像素数据");
  }

  const pixels = new Uint8ClampedArray(source);
  const edgeIndexes = collectEdgeIndexes(width, height);
  const backgroundPalette = createEdgePalette(pixels, edgeIndexes);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  for (const index of edgeIndexes) {
    if (isBackgroundPixel(pixels, index, backgroundPalette) && !visited[index]) {
      visited[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
  }

  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y + 1 < height ? index + width : -1
    ];
    for (const neighbor of neighbors) {
      if (neighbor >= 0 && !visited[neighbor] && isBackgroundPixel(pixels, neighbor, backgroundPalette)) {
        visited[neighbor] = 1;
        queue[tail] = neighbor;
        tail += 1;
      }
    }
  }

  let opaquePixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    if (visited[index]) pixels[offset + 3] = 0;
    if (pixels[offset + 3] > 16) opaquePixels += 1;
  }

  const transparentEdges = edgeIndexes.reduce(
    (count, index) => count + (pixels[index * 4 + 3] <= 16 ? 1 : 0),
    0
  );

  return {
    pixels,
    transparentEdgeRatio: transparentEdges / edgeIndexes.length,
    opaquePixelRatio: opaquePixels / (width * height)
  };
}

function createEdgePalette(pixels: Uint8ClampedArray, edgeIndexes: number[]): Color[] {
  const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>();
  for (const index of edgeIndexes) {
    const offset = index * 4;
    if (pixels[offset + 3] <= 16) continue;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const key = [
      Math.round(red / COLOR_BUCKET_SIZE),
      Math.round(green / COLOR_BUCKET_SIZE),
      Math.round(blue / COLOR_BUCKET_SIZE)
    ].join(":");
    const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }

  const minimumCount = Math.max(2, Math.floor(edgeIndexes.length * 0.015));
  return [...buckets.values()]
    .filter((bucket) => bucket.count >= minimumCount)
    .sort((left, right) => right.count - left.count)
    .slice(0, MAX_BACKGROUND_COLORS)
    .map((bucket) => ({
      red: bucket.red / bucket.count,
      green: bucket.green / bucket.count,
      blue: bucket.blue / bucket.count
    }));
}

function isBackgroundPixel(pixels: Uint8ClampedArray, index: number, palette: Color[]): boolean {
  const offset = index * 4;
  const alpha = pixels[offset + 3];
  if (alpha <= 16) return true;

  const red = pixels[offset];
  const green = pixels[offset + 1];
  const blue = pixels[offset + 2];
  if (green > 130 && green > red * 1.28 && green > blue * 1.28) return true;

  return palette.some((color) => colorDistance(red, green, blue, color) <= 34);
}

function colorDistance(red: number, green: number, blue: number, color: Color): number {
  return Math.sqrt(
    ((red - color.red) ** 2)
    + ((green - color.green) ** 2)
    + ((blue - color.blue) ** 2)
  );
}

function collectEdgeIndexes(width: number, height: number): number[] {
  const indexes: number[] = [];
  for (let x = 0; x < width; x += 1) {
    indexes.push(x);
    if (height > 1) indexes.push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    indexes.push(y * width);
    if (width > 1) indexes.push(y * width + width - 1);
  }
  return indexes;
}
