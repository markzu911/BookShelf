import type { PosterCopy, UploadedImage } from "../types";

const POSTER_WIDTH = 1080;
const POSTER_HEIGHT = 1440;
const HERO_HEIGHT = 968;
const PAPER = "#eee8de";
const INK = "#30241d";
const MUTED_INK = "#5f534a";

interface PosterOptions {
  sceneImageUrl: string;
  productImage: UploadedImage;
  copy: PosterCopy;
  seriesName?: string;
  productName?: string;
  price?: string;
}

export async function composeCabinetPoster(options: PosterOptions): Promise<string> {
  const [scene, product] = await Promise.all([
    loadImage(options.sceneImageUrl),
    loadImage(options.productImage.dataUrl)
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = POSTER_WIDTH;
  canvas.height = POSTER_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持海报合成");

  drawCover(ctx, scene, 0, 0, POSTER_WIDTH, HERO_HEIGHT);
  drawHeroOverlay(ctx);
  drawHeroMeta(ctx, {
    seriesName: clean(options.seriesName) || options.copy.seriesName,
    productName: clean(options.productName) || options.copy.productName,
    price: clean(options.price)
  });

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, HERO_HEIGHT, POSTER_WIDTH, POSTER_HEIGHT - HERO_HEIGHT);
  drawEditorialCopy(ctx, options.copy);
  drawProductCutout(ctx, product);

  return canvas.toDataURL("image/jpeg", 0.94);
}

function drawHeroOverlay(ctx: CanvasRenderingContext2D) {
  const gradient = ctx.createLinearGradient(0, HERO_HEIGHT * 0.6, 0, HERO_HEIGHT);
  gradient.addColorStop(0, "rgba(28, 18, 12, 0)");
  gradient.addColorStop(1, "rgba(28, 18, 12, 0.42)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, HERO_HEIGHT * 0.55, POSTER_WIDTH, HERO_HEIGHT * 0.45);
}

function drawHeroMeta(
  ctx: CanvasRenderingContext2D,
  meta: { seriesName: string; productName: string; price: string }
) {
  const label = `#${meta.seriesName || "栖居"} · ${meta.productName || "柜"}`;
  ctx.textAlign = "right";
  ctx.fillStyle = "#fffaf2";
  ctx.font = '500 31px "Microsoft YaHei", "Noto Sans SC", sans-serif';
  ctx.fillText(label, 1024, 853);

  if (meta.price) {
    ctx.font = '700 64px "Microsoft YaHei", "Noto Sans SC", sans-serif';
    ctx.fillText(`¥${meta.price}`, 1000, 926);
    ctx.font = '600 23px "Microsoft YaHei", "Noto Sans SC", sans-serif';
    ctx.fillText("起", 1025, 928);
  }
  ctx.textAlign = "left";
}

function drawEditorialCopy(ctx: CanvasRenderingContext2D, copy: PosterCopy) {
  ctx.fillStyle = INK;
  ctx.font = '500 52px Georgia, "Times New Roman", serif';
  ctx.fillText("<About me>", 48, 1054);

  ctx.font = '700 31px "Microsoft YaHei", "Noto Sans SC", sans-serif';
  ctx.fillText(copy.headline, 48, 1134);

  ctx.fillStyle = INK;
  ctx.font = '500 24px "Microsoft YaHei", "Noto Sans SC", sans-serif';
  drawWrappedText(ctx, copy.description, 48, 1190, 675, 42, 3);

  ctx.fillStyle = MUTED_INK;
  ctx.font = '400 14px Georgia, "Times New Roman", serif';
  drawWrappedText(ctx, copy.englishDescription, 48, 1360, 935, 23, 2);
}

function drawProductCutout(ctx: CanvasRenderingContext2D, image: HTMLImageElement) {
  const box = { x: 765, y: 1017, width: 270, height: 310 };
  ctx.save();
  ctx.shadowColor = "rgba(65, 46, 35, 0.16)";
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 10;
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  ctx.drawImage(image, box.x + (box.width - width) / 2, box.y + box.height - height, width, height);
  ctx.restore();
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
) {
  const scale = Math.max(width / image.width, height / image.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = Math.max(0, (image.width - sourceWidth) / 2);
  const sourceY = Math.max(0, (image.height - sourceHeight) / 2);
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
) {
  const characters = Array.from(clean(text));
  const lines: string[] = [];
  let line = "";
  for (const character of characters) {
    const next = line + character;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = character;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  lines.forEach((item, index) => {
    const isLast = index === maxLines - 1 && characters.join("").length > lines.join("").length;
    ctx.fillText(isLast ? `${item.replace(/[，。；、\s]+$/, "")}…` : item, x, y + index * lineHeight);
  });
}

function clean(value?: string) {
  return String(value || "").trim();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("海报素材加载失败"));
    image.src = src;
  });
}
