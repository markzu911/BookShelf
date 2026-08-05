import type {
  GeminiAnalyzeResponse,
  GeminiImageResponse,
  GeminiGenerateRequest,
  GeminiQualityResponse,
  GenerationQualityCheck,
  PerspectiveOption,
  PlacementSettings,
  SceneAnalysis,
  TrialPlacementPlan,
  UploadedImage
} from "../types";
import { perspectiveLabels } from "../constants";
import { buildAnalysisPrompt, buildGenerationPrompt, buildQualityPrompt, buildVirtualAnalysisPrompt, buildVirtualRoomPrompt } from "./prompt";
import { compressDataUrlToImage, preserveTransparentDataUrl, removeGeneratedStudioBackground } from "./image";
import { resolvePlacementPlan } from "./placement";

export async function analyzeScene(
  roomImage: UploadedImage,
  furnitureImage: UploadedImage | null,
  roomReferenceImages: UploadedImage[],
  model: string,
  extraContext: string,
  extraPrompt: string[],
  userRequirements = ""
): Promise<SceneAnalysis> {
  const response = await postGemini<GeminiAnalyzeResponse>({
    mode: "analyze",
    model,
    roomImage,
    roomReferenceImages,
    ...(furnitureImage ? { beddingImage: furnitureImage } : {}),
    systemPrompt: buildAnalysisPrompt(extraContext, extraPrompt, userRequirements)
  });

  return normalizeSceneAnalysis(response.analysis);
}

export async function analyzeVirtualFurniture(
  furnitureImage: UploadedImage,
  model: string,
  styleLabel: string,
  extraContext: string,
  extraPrompt: string[],
  userRequirements = ""
): Promise<SceneAnalysis> {
  const response = await postGemini<GeminiAnalyzeResponse>({
    mode: "analyze",
    model,
    beddingImage: furnitureImage,
    systemPrompt: buildVirtualAnalysisPrompt(styleLabel, extraContext, extraPrompt, userRequirements)
  });
  return normalizeSceneAnalysis(response.analysis);
}

/** Frontend fallback: even a legacy/local API response must never leak objects into an editable text field. */
export function normalizeSceneAnalysis(value: unknown): SceneAnalysis {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    roomSummary: readableText(source.roomSummary, "已识别空间、墙面与地面关系。"),
    furnitureSummary: readableText(source.furnitureSummary, "已识别柜体主体、材质和结构。"),
    furnitureIdentity: normalizeFurnitureIdentity(source.furnitureIdentity, source.furnitureSummary),
    lighting: readableText(source.lighting, "已判断主要光线方向。"),
    perspective: readableText(source.perspective, "已判断空间透视。"),
    placementAdvice: readableText(source.placementAdvice, "建议按空间动线自然摆放。"),
    constraints: readableList(source.constraints, ["保持空间主体结构不变"]),
    placementPlan: resolvePlacementPlan(normalizePlacementPlan(source.placementPlan, source.placementAdvice)),
    stylingPlan: normalizeStylingPlan(source.stylingPlan),
    posterCopy: normalizePosterCopy(source.posterCopy)
  };
}

function normalizeFurnitureIdentity(value: unknown, fallback: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const summary = readableText(fallback, "目标柜类参考图中的产品主体");
  return {
    category: readableText(source.category, "柜类家具"),
    silhouette: readableText(source.silhouette, summary),
    structure: readableText(source.structure, "以参考图可见结构为准"),
    doors: readableText(source.doors, "以参考图可见柜门为准"),
    drawers: readableText(source.drawers, "以参考图可见抽屉为准"),
    shelves: readableText(source.shelves, "以参考图可见层板与开放格为准"),
    material: readableText(source.material, "以参考图为准"),
    color: readableText(source.color, "以参考图为准"),
    details: readableList(source.details, ["以参考图可见细节为准"])
  };
}

function normalizeStylingPlan(value: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    summary: readableText(source.summary, "以书籍与克制的艺术摆件完成自然家居陈设。"),
    books: readableText(source.books, "根据开放格数量自然摆放书籍，保持疏密有序。"),
    ornaments: readableText(source.ornaments, "搭配少量陶瓷、画框或生活物品，不遮挡柜体结构。"),
    lighting: readableText(source.lighting, "沿用场景主光，并为柜体增加自然暖色层次。"),
    atmosphere: readableText(source.atmosphere, "温暖、真实、克制的高端家居摄影氛围。")
  };
}

function normalizePosterCopy(value: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    seriesName: readableText(source.seriesName, "栖居"),
    productName: readableText(source.productName, "柜"),
    headline: readableText(source.headline, "重构多元居家空间"),
    description: readableText(source.description, "温润木质与有序收纳相互平衡，让日常藏品、阅读与生活片段都有从容位置。"),
    englishDescription: readableText(source.englishDescription, "Warm wood, thoughtful storage and collected objects shape a calm, lived-in home.")
  };
}

function normalizePlacementPlan(value: unknown, fallbackAdvice: unknown): TrialPlacementPlan {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const fallback = readableText(fallbackAdvice, "根据可用墙面、现有家具和通行动线自然摆放目标柜体。");
  return {
    summary: readableText(source.summary, fallback),
    placement: readableText(source.placement, "由 AI 根据可用墙面、现有家具和动线选择合适位置"),
    facing: readableText(source.facing, "根据主要视觉焦点和用户要求确定朝向"),
    scale: readableText(source.scale, "保持与空间透视和周边家具视觉比例协调"),
    preserve: readableList(source.preserve, ["保留未被用户明确要求移除的原有结构、家具与装饰"]),
    remove: readableList(source.remove, ["无明确移除对象"]),
    avoid: readableList(source.avoid, ["不要遮挡门、窗、主要通道和采光"]),
    rationale: readableList(source.rationale, [fallback]),
    candidates: normalizeCandidates(source.candidates),
    selectedCandidateId: readableText(source.selectedCandidateId, "")
  };
}

function normalizeCandidates(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item, index) => {
    const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      id: readableText(source.id, `candidate-${index + 1}`),
      label: readableText(source.label, `候选方案 ${index + 1}`),
      placement: readableText(source.placement, "由 AI 根据空间动线选择合适位置"),
      facing: readableText(source.facing, "面向主要视觉焦点"),
      scale: readableText(source.scale, "按空间透视协调视觉比例"),
      score: Number.isFinite(Number(source.score)) ? Number(source.score) : 0.5,
      reasons: readableList(source.reasons, ["符合空间视觉关系"]),
      blocksWalkway: source.blocksWalkway === true,
      conflictsWithPreservedItems: source.conflictsWithPreservedItems === true,
      violatesUserRequirements: source.violatesUserRequirements === true
    };
  });
}

function readableText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => readableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  if (value && typeof value === "object") {
    const text = Object.values(value as Record<string, unknown>).map((item) => readableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  return fallback;
}

function readableList(value: unknown, fallback: string[]): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const result = items.map((item) => readableText(item, "")).filter(Boolean);
  return result.length ? result : fallback;
}

export async function generatePlacementImages(
  roomImage: UploadedImage,
  productReferenceImage: UploadedImage,
  roomReferenceImages: UploadedImage[],
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext: string,
  extraPrompt: string[]
): Promise<PerspectiveGenerationBatch> {
  const requestedPerspective = settings.perspectives[0] || "wide";
  const requestedPerspectives: PerspectiveOption[] = [requestedPerspective];
  return generatePerspectiveBatch(requestedPerspectives, async (perspective, singleViewSettings) => {
    const perspectivePrompts: Record<string, string> = {
      [perspective]: buildGenerationPrompt(
        analysis,
        singleViewSettings,
        perspective,
        extraContext,
        extraPrompt,
        perspective !== "wide"
      )
    };
    const response = await postGemini<GeminiImageResponse>({
      mode: "generate",
      model: settings.model,
      roomImage,
      roomReferenceImages,
      productReferenceImage,
      analysis,
      settings: singleViewSettings,
      systemPrompt: "直接根据原始场景与原始产品生成当前指定视角的一张柜类试摆场景主图，不生成中间图。",
      perspectivePrompts
    });
    return response.images;
  }, settings);
}

export async function generateVirtualRoomImages(
  beddingImage: UploadedImage,
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext: string,
  extraPrompt: string[]
): Promise<PerspectiveGenerationBatch> {
  const requestedPerspective = settings.perspectives[0] || "wide";
  const requestedPerspectives: PerspectiveOption[] = [requestedPerspective];
  return generatePerspectiveBatch(requestedPerspectives, async (perspective, singleViewSettings) => {
    const perspectivePrompts: Record<string, string> = {
      [perspective]: buildVirtualRoomPrompt(analysis, singleViewSettings, perspective, extraContext, extraPrompt)
    };
    const response = await postGemini<GeminiImageResponse>({
      mode: "generate",
      model: settings.model,
      beddingImage,
      analysis,
      settings: singleViewSettings,
      systemPrompt: "直接根据原始产品生成当前指定视角的一张虚拟家居场景主图，不生成中间图。",
      perspectivePrompts
    });
    return response.images;
  }, settings);
}

export interface PerspectiveGenerationBatch {
  images: GeminiImageResponse["images"];
  failures: Array<{ perspective: PerspectiveOption; message: string }>;
}

async function generatePerspectiveBatch(
  perspectives: PerspectiveOption[],
  generateOne: (perspective: PerspectiveOption, settings: PlacementSettings) => Promise<GeminiImageResponse["images"]>,
  settings: PlacementSettings
): Promise<PerspectiveGenerationBatch> {
  const images: GeminiImageResponse["images"] = [];
  const failures: PerspectiveGenerationBatch["failures"] = [];

  for (const perspective of perspectives) {
    const singleViewSettings: PlacementSettings = { ...settings, perspectives: [perspective] };
    try {
      const responseImages = await generateOne(perspective, singleViewSettings);
      const image = responseImages.find((item) => item.perspective === perspective) || responseImages[0];
      if (!image?.imageUrl) throw new Error(`${perspectiveLabels[perspective]}未返回图片`);
      images.push({ ...image, perspective, title: perspectiveLabels[perspective] });
    } catch (error) {
      failures.push({
        perspective,
        message: error instanceof Error ? error.message : `${perspectiveLabels[perspective]}生成失败`
      });
    }
  }

  return { images, failures };
}

export async function extractFurnitureForeground(furnitureImage: UploadedImage, settings: PlacementSettings): Promise<UploadedImage> {
  const response = await postGemini<GeminiImageResponse>({
    mode: "cutout", model: settings.model, beddingImage: furnitureImage,
    settings: { ...settings, perspectives: ["wide"] },
    systemPrompt: "这是柜类产品抠图任务，不是室内设计或摆放任务。只提取输入照片中的同一个完整柜体产品或完整组合，严格保留模块数量、整体轮廓、柜门、抽屉、开放格、层板、玻璃、柜脚、颜色、材质、木纹和可见细节。删除人物、地面、墙面、其他家具、文字、价格和全部背景。输出画面只能有一个完整柜体产品，置于纯 RGB(0,255,0) 绿色背景；绿色区域必须完全均匀、无阴影、无渐变、无其他物体。禁止绘制灰白棋盘格、透明背景预览网格、白色卡片或展示底板。",
    perspectivePrompts: { wide: "输出用于后续合成和海报小图的单个完整柜体前景，不要改变产品设计。" }
  });
  const imageUrl = response.images.find((image) => image.perspective === "wide")?.imageUrl;
  if (!imageUrl) throw new Error("Gemini 未返回柜体前景图");
  const dataUrl = await removeGeneratedStudioBackground(imageUrl);
  return preserveTransparentDataUrl(dataUrl, `${furnitureImage.fileName.replace(/\.[^.]+$/, "")}-foreground.png`, 1000);
}

export async function erasePlannedFurniture(
  roomImage: UploadedImage,
  analysis: SceneAnalysis,
  settings: PlacementSettings
): Promise<UploadedImage> {
  const removalPlan = analysis.placementPlan.remove.join("；");
  if (!removalPlan || /^(无|无需|不移除|无明确移除对象)/.test(removalPlan)) {
    return roomImage;
  }
  const response = await postGemini<GeminiImageResponse>({
    mode: "erase",
    model: settings.model,
    roomImage,
    settings: { ...settings, perspectives: ["wide"] },
    systemPrompt: `这是确认方案后的局部场景清理任务，不是重新设计空间。只移除以下明确列出的内容：${removalPlan}。用周围真实墙面、地面、踢脚线、背景和光影自然补全遮挡区域。必须完整保留方案中要求保留的内容：${analysis.placementPlan.preserve.join("；")}。不得删除或移动未列出的家具、门窗、墙画、灯具、植物和建筑结构。保持原机位、透视、材质、颜色和光线。`,
    perspectivePrompts: { wide: "只输出按确认清单完成局部移除后的同一场景，不添加目标柜体或其他新家具。" }
  });
  const imageUrl = response.images.find((image) => image.perspective === "wide")?.imageUrl;
  if (!imageUrl) throw new Error("Gemini 未返回清理后的场景图");
  return compressDataUrlToImage(imageUrl, `${roomImage.fileName.replace(/\.[^.]+$/, "")}-clear.jpg`, 1200, 0.78, 720 * 1024);
}

export async function checkGeneratedPlacement(
  roomImage: UploadedImage | null,
  beddingImage: UploadedImage,
  roomReferenceImages: UploadedImage[],
  resultImageUrl: string,
  analysis: SceneAnalysis,
  perspective: PerspectiveOption,
  settings: PlacementSettings,
  extraContext: string,
  extraPrompt: string[]
): Promise<GenerationQualityCheck> {
  const resultImage = await compressDataUrlToImage(resultImageUrl, "quality-check.jpg", 820, 0.64, 300 * 1024);
  const response = await postGemini<GeminiQualityResponse>({
    mode: "quality",
    model: settings.model,
    ...(roomImage ? { roomImage } : {}),
    roomReferenceImages,
    beddingImage,
    resultImage,
    analysis,
    settings,
    systemPrompt: buildQualityPrompt(analysis, settings, extraContext, extraPrompt, perspective, Boolean(roomImage))
  });
  return response.quality;
}

function dataUrlToImage(dataUrl: string): Pick<UploadedImage, "base64" | "mimeType"> {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("生成结果格式异常，暂时无法进行质量检查");
  }
  return { mimeType: match[1] as UploadedImage["mimeType"], base64: match[2] };
}

async function postGemini<T>(payload: GeminiGenerateRequest): Promise<T> {
  const body = JSON.stringify(payload);
  const bodySize = new Blob([body]).size;
  if (bodySize > 3.5 * 1024 * 1024) {
    throw new Error("请求图片体积仍然过大，可能被服务端拒绝。请减少补充角度图片，或上传分辨率更低的场景/柜体图后重试。");
  }
  const retryableStatuses = new Set([429, 500, 502, 503, 504]);
  let response: Response | undefined;
  let lastNetworkError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      if (!retryableStatuses.has(response.status) || attempt === 1) break;
    } catch (error) {
      lastNetworkError = error;
      if (attempt === 1) throw error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 900));
  }

  if (!response) {
    throw lastNetworkError instanceof Error ? lastNetworkError : new Error("Gemini 接口暂时无法连接");
  }

  if (response.status === 413) {
    throw new Error("上传给 AI 的参考图片数据过大，线上代理已拒绝请求。系统已减少远景请求中的重复图片，请刷新页面并重新上传素材后再试。");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    if (response.status === 404 || response.status === 405) {
      throw new Error(`Gemini 接口地址不可用：/api/gemini 返回 ${response.status}，请确认主站已把工具 API 代理到 Vercel`);
    }
    throw new Error(`Gemini 接口返回异常：${response.status}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.message || "AI 处理失败");
  }
  return data as T;
}



