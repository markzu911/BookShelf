import type { UploadedImage } from "../types";
import { removeConnectedStudioBackground } from "./backgroundMask";

const MAX_INPUT_SIZE = 20 * 1024 * 1024;
const MAX_EDGE = 1200;
const JPEG_QUALITY = 0.72;

export const GEMINI_IMAGE_TARGET_BYTES = 420 * 1024;
export const GEMINI_PRODUCT_TARGET_BYTES = 900 * 1024;
export const GEMINI_REFERENCE_TARGET_BYTES = 160 * 1024;

export async function compressImage(
  file: File,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
  targetBytes = GEMINI_IMAGE_TARGET_BYTES
): Promise<UploadedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请上传图片文件");
  }

  if (file.size > MAX_INPUT_SIZE) {
    throw new Error("图片不能超过 20MB");
  }

  const originalDataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(originalDataUrl);
  return renderCompressedImage(img, file.name.replace(/\.[^.]+$/, ".jpg"), maxEdge, quality, targetBytes);
}

export async function preserveOriginalProductImage(file: File): Promise<UploadedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请上传图片文件");
  }
  if (file.size > MAX_INPUT_SIZE) {
    throw new Error("图片不能超过 20MB");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const mimeType = file.type === "image/png"
    ? "image/png"
    : file.type === "image/jpeg" || file.type === "image/jpg"
      ? "image/jpeg"
      : null;

  if (mimeType) {
    return {
      fileName: file.name,
      mimeType,
      size: file.size,
      dataUrl,
      base64: dataUrl.split(",")[1] ?? "",
      width: image.width,
      height: image.height
    };
  }

  const scale = Math.min(1, 3200 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持保留原始产品图");
  ctx.drawImage(image, 0, 0, width, height);
  const pngDataUrl = canvas.toDataURL("image/png");
  const base64 = pngDataUrl.split(",")[1] ?? "";
  return {
    fileName: file.name.replace(/\.[^.]+$/, ".png"),
    mimeType: "image/png",
    size: Math.round((base64.length * 3) / 4),
    dataUrl: pngDataUrl,
    base64,
    width,
    height
  };
}

function renderCompressedImage(
  img: HTMLImageElement,
  fileName: string,
  maxEdge: number,
  quality: number,
  targetBytes: number
): UploadedImage {
  let edge = maxEdge;
  let currentQuality = quality;
  let compressed = drawJpeg(img, fileName, edge, currentQuality);
  while (compressed.size > targetBytes && (edge > 640 || currentQuality > 0.5)) {
    if (currentQuality > 0.5) {
      currentQuality = Math.max(0.5, currentQuality - 0.08);
    } else {
      edge = Math.max(640, Math.round(edge * 0.82));
      currentQuality = quality;
    }
    compressed = drawJpeg(img, fileName, edge, currentQuality);
  }
  return compressed;
}

function drawJpeg(img: HTMLImageElement, fileName: string, maxEdge: number, quality: number): UploadedImage {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("浏览器不支持图片压缩");
  }

  ctx.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = dataUrl.split(",")[1] ?? "";
  const size = Math.round((base64.length * 3) / 4);

  return {
    fileName,
    mimeType: "image/jpeg",
    size,
    dataUrl,
    base64,
    width,
    height
  };
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export async function compressDataUrlToImage(
  dataUrl: string,
  fileName: string,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
  targetBytes = GEMINI_IMAGE_TARGET_BYTES
): Promise<UploadedImage> {
  const image = await loadImage(dataUrl);
  return renderCompressedImage(image, fileName.replace(/\.[^.]+$/, ".jpg"), maxEdge, quality, targetBytes);
}

export async function compressDataUrlToBlob(
  dataUrl: string,
  maxEdge = 1600,
  quality = 0.86,
  targetBytes = 1200 * 1024
): Promise<Blob> {
  const image = await loadImage(dataUrl);
  let edge = maxEdge;
  let currentQuality = quality;
  let blob = await drawJpegBlob(image, edge, currentQuality);
  while (blob.size > targetBytes && (edge > 960 || currentQuality > 0.68)) {
    if (currentQuality > 0.68) {
      currentQuality = Math.max(0.68, currentQuality - 0.08);
    } else {
      edge = Math.max(960, Math.round(edge * 0.85));
      currentQuality = quality;
    }
    blob = await drawJpegBlob(image, edge, currentQuality);
  }
  return blob;
}

function drawJpegBlob(image: HTMLImageElement, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持结果图压缩");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("结果图压缩失败")), "image/jpeg", quality);
  });
}

export async function removeGeneratedStudioBackground(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("浏览器不支持柜体前景处理");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = removeConnectedStudioBackground(pixels.data, canvas.width, canvas.height);
  if (result.transparentEdgeRatio < 0.72 || result.opaquePixelRatio < 0.015 || result.opaquePixelRatio > 0.92) {
    throw new Error("柜体抠图没有形成可靠的透明背景，请重新提取");
  }
  pixels.data.set(result.pixels);
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL("image/png");
}

export async function preserveTransparentDataUrl(
  dataUrl: string,
  fileName: string,
  maxEdge = 1000
): Promise<UploadedImage> {
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持透明柜体前景处理");
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const outputDataUrl = canvas.toDataURL("image/png");
  const base64 = outputDataUrl.split(",")[1] ?? "";
  return {
    fileName: fileName.replace(/\.[^.]+$/, ".png"),
    mimeType: "image/png",
    size: Math.round((base64.length * 3) / 4),
    dataUrl: outputDataUrl,
    base64,
    width,
    height
  };
}

export async function createPixelLockedCloseupScene(
  backgroundImageUrl: string | null,
  productImageUrl: string
): Promise<string> {
  const product = await loadImage(productImageUrl);
  const productCanvas = document.createElement("canvas");
  productCanvas.width = product.width;
  productCanvas.height = product.height;
  const productContext = productCanvas.getContext("2d", { willReadFrequently: true });
  if (!productContext) throw new Error("浏览器不支持近景产品处理");
  productContext.drawImage(product, 0, 0);

  const pixels = productContext.getImageData(0, 0, product.width, product.height);
  const removal = removeConnectedStudioBackground(pixels.data, product.width, product.height);
  if (removal.transparentEdgeRatio < 0.72 || removal.opaquePixelRatio < 0.04 || removal.opaquePixelRatio > 0.92) {
    throw new Error("产品图背景过于复杂，无法在不重绘产品的前提下生成可靠近景；请上传背景简洁的产品图");
  }
  pixels.data.set(removal.pixels);
  productContext.putImageData(pixels, 0, 0);

  const bounds = findOpaqueBounds(removal.pixels, product.width, product.height);
  if (!bounds || bounds.width < 32 || bounds.height < 32) {
    throw new Error("未能从产品图中识别出清晰柜体，请上传主体完整且背景简洁的产品图");
  }

  const outputWidth = 1600;
  const outputHeight = Math.round(outputWidth * 968 / 1080);
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持近景合成");

  if (backgroundImageUrl) {
    const background = await loadImage(backgroundImageUrl);
    ctx.save();
    ctx.filter = "blur(14px) saturate(0.78) brightness(1.04)";
    drawCoverImage(ctx, background, -28, -28, outputWidth + 56, outputHeight + 56);
    ctx.restore();
  } else {
    const wall = ctx.createLinearGradient(0, 0, 0, outputHeight);
    wall.addColorStop(0, "#e7ded1");
    wall.addColorStop(0.72, "#cfc0ad");
    wall.addColorStop(1, "#9f8a73");
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, outputWidth, outputHeight);
  }
  const veil = ctx.createLinearGradient(0, 0, outputWidth, outputHeight);
  veil.addColorStop(0, "rgba(255, 250, 242, 0.34)");
  veil.addColorStop(1, "rgba(40, 29, 21, 0.12)");
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, outputWidth, outputHeight);

  const cropWidth = Math.max(1, bounds.width * 0.34);
  const cropHeight = Math.max(1, bounds.height * 0.72);
  const focalX = bounds.x + bounds.width * 0.38;
  const focalY = bounds.y + bounds.height * 0.56;
  const sourceX = clamp(focalX - cropWidth / 2, bounds.x, bounds.x + bounds.width - cropWidth);
  const sourceY = clamp(focalY - cropHeight / 2, bounds.y, bounds.y + bounds.height - cropHeight);
  const scale = Math.max(outputWidth * 0.92 / cropWidth, outputHeight * 0.9 / cropHeight);
  const drawWidth = cropWidth * scale;
  const drawHeight = cropHeight * scale;
  const drawX = (outputWidth - drawWidth) / 2;
  const drawY = (outputHeight - drawHeight) / 2;

  ctx.save();
  ctx.shadowColor = "rgba(24, 18, 13, 0.22)";
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 10;
  ctx.drawImage(productCanvas, sourceX, sourceY, cropWidth, cropHeight, drawX, drawY, drawWidth, drawHeight);
  ctx.restore();

  return canvas.toDataURL("image/png");
}

function findOpaqueBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] <= 16) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const scale = Math.max(width / image.width, height / image.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.width - sourceWidth) / 2;
  const sourceY = (image.height - sourceHeight) / 2;
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function assertDistinctCameraViews(masterImageUrl: string, variations: string[]): Promise<void> {
  if (!variations.length) return;
  const masterImage = await loadImage(masterImageUrl);
  const master = imagePixels(masterImage);
  const cropScales = [0.72, 0.62, 0.5, 0.4, 0.32];
  for (const variationUrl of variations) {
    const variationImage = await loadImage(variationUrl);
    const variation = imagePixels(variationImage);
    const normalizedDifference = pixelDifference(master, variation);
    if (normalizedDifference < 0.025) {
      throw new Error("镜头变化不足，已拦截本次结果。请重新生成，系统不会把近乎相同的画面当作不同视角。");
    }
    for (const scale of cropScales) {
      const crop = imagePixels(masterImage, scale);
      if (pixelDifference(crop, variation) < 0.035) {
        throw new Error("镜头疑似只是远景裁切或缩放，已拦截本次结果。请重新生成真实不同机位。");
      }
    }
  }
}

function pixelDifference(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  let totalDifference = 0;
  for (let index = 0; index < left.length; index += 4) {
    totalDifference += Math.abs(left[index] - right[index]);
    totalDifference += Math.abs(left[index + 1] - right[index + 1]);
    totalDifference += Math.abs(left[index + 2] - right[index + 2]);
  }
  return totalDifference / ((left.length / 4) * 3 * 255);
}

function imagePixels(image: HTMLImageElement, cropScale = 1): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("浏览器不支持镜头结果校验");
  const sourceWidth = image.width * cropScale;
  const sourceHeight = image.height * cropScale;
  const sourceX = (image.width - sourceWidth) / 2;
  const sourceY = (image.height - sourceHeight) / 2;
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片格式无法识别"));
    img.src = src;
  });
}


