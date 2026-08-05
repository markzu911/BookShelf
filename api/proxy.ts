import type { IncomingMessage, ServerResponse } from "node:http";

const SAAS_ORIGIN = process.env.SAAS_API_ORIGIN || "http://aibigtree.com";
const BODY_LIMIT = 20 * 1024 * 1024;

class ImageGenerationUnavailable extends Error {
  constructor() {
    super("图片生成服务当前繁忙，请稍后重试。已尝试高精度与备用模型，但均未在限定时间内响应。");
  }
}

class GeminiUpstreamError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

interface JsonRequest extends IncomingMessage {
  body?: unknown;
}

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiRequestBody {
  mode?: "analyze" | "cutout" | "erase" | "generate" | "quality";
  model?: string;
  roomImage?: { base64: string; mimeType: string };
  roomReferenceImages?: Array<{ base64: string; mimeType: string }>;
  beddingImage?: { base64: string; mimeType: string };
  sofaImage?: { base64: string; mimeType: string };
  productReferenceImage?: { base64: string; mimeType: string };
  resultImage?: { base64: string; mimeType: string };
  systemPrompt?: string;
  perspectivePrompts?: Record<string, string>;
  settings?: {
    perspectives?: string[];
    ratio?: string;
    clarity?: string;
  };
}

export default async function handler(req: JsonRequest, res: ServerResponse) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  const path = getRequestPath(req);

  try {
    if (path === "/api/gemini" && req.method === "POST") {
      await handleGemini(req, res);
      return;
    }

    if (path.startsWith("/api/tool/") || path.startsWith("/api/upload/")) {
      await proxyToSaas(req, res, path);
      return;
    }

    sendJson(res, 404, { success: false, message: "API 路由不存在" });
  } catch (error) {
    const statusCode = error instanceof GeminiUpstreamError
      ? error.statusCode
      : error instanceof ImageGenerationUnavailable
        ? 503
        : 500;
    console.error("[api/proxy] request failed", {
      url: req.url,
      method: req.method,
      statusCode,
      ...describeError(error)
    });
    sendJson(res, statusCode, {
      success: false,
      message: error instanceof Error ? error.message : "服务端处理失败"
    });
  }
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) };
  const cause = (error as Error & { cause?: Record<string, unknown> }).cause;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack?.split("\n").slice(0, 5).join("\n"),
    cause: cause ? {
      name: cause.name,
      code: cause.code,
      errno: cause.errno,
      syscall: cause.syscall,
      address: cause.address,
      port: cause.port,
      message: cause.message
    } : undefined
  };
}

function fingerprintText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createGenerationTrace(
  body: GeminiRequestBody,
  perspective: string,
  usedModel: string,
  usedApi: string,
  durationMs: number,
  generatedData: Record<string, unknown>
) {
  const prompt = body.perspectivePrompts?.[perspective] || body.systemPrompt || "";
  return {
    timestamp: new Date().toISOString(),
    perspective,
    api: usedApi,
    model: usedModel,
    durationMs,
    promptFingerprint: fingerprintText(prompt),
    promptLength: prompt.length,
    inputs: {
      roomImage: Boolean(body.roomImage?.base64),
      roomReferences: (body.roomReferenceImages || []).filter((image) => image?.base64).length,
      foreground: Boolean(getBeddingImage(body)?.base64),
      productReference: Boolean(body.productReferenceImage?.base64)
    },
    response: {
      id: generatedData.id || null,
      model: generatedData.model || generatedData.modelVersion || null,
      status: generatedData.status || null
    }
  };
}

async function handleGemini(req: JsonRequest, res: ServerResponse) {
  const body = (await readJsonBody<GeminiRequestBody>(req)) || {};
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    sendJson(res, 500, {
      success: false,
      message: "未配置 GEMINI_API_KEY，当前没有调用真实 Gemini API。请在 Vercel 环境变量中配置后重新部署。"
    });
    return;
  }

  const model = mapModel(body.model, body.mode);

  const parts: GeminiPart[] = [
    { text: body.systemPrompt || "" }
  ];

  if (body.roomImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: body.roomImage.mimeType || "image/jpeg",
        data: body.roomImage.base64
      }
    });
  }

  for (const image of body.roomReferenceImages || []) {
    if (image.base64) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType || "image/jpeg",
          data: image.base64
        }
      });
    }
  }

  const beddingImage = getBeddingImage(body);
  if (beddingImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: beddingImage.mimeType || "image/jpeg",
        data: beddingImage.base64
      }
    });
  }

  if (body.productReferenceImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: body.productReferenceImage.mimeType || "image/jpeg",
        data: body.productReferenceImage.base64
      }
    });
  }

  if (body.resultImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: body.resultImage.mimeType || "image/jpeg",
        data: body.resultImage.base64
      }
    });
  }

  if (body.mode === "generate") {
    const images = await generateDirectStage(body, apiKey, model);
    sendJson(res, 200, images.length ? { success: true, images } : createMockGeminiResponse(body));
    return;
  }

  if (body.mode === "cutout" || body.mode === "erase") {
    const { response, raw } = await requestImageWithFallback(body, apiKey, model, "wide");
    if (!response.ok) throw toGeminiUpstreamError(response.status, raw, body.mode === "erase" ? "原场景清理失败" : "柜体前景提取失败");
    const assetData = JSON.parse(raw);
    const image = extractInteractionImage(assetData) || extractGeneratedContentImage(assetData);
    if (!image) throw new Error(body.mode === "erase" ? "Gemini 未返回可用的干净场景图" : "Gemini 未返回可用的柜体前景图");
    sendJson(res, 200, { success: true, images: [{ perspective: "wide", title: body.mode === "erase" ? "干净场景" : "柜体前景", imageUrl: `data:${image.mimeType};base64,${image.data}` }] });
    return;
  }

  const response = await fetchWithDiagnostics(
    `generateContent-json:${model}:${body.mode || "unknown"}`,
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    }
  );

  const raw = await response.text();
  if (!response.ok) {
    sendJson(res, response.status, {
      success: false,
      message: parseGeminiError(raw) || "Gemini 请求失败"
    });
    return;
  }

  const data = JSON.parse(raw);
  if (body.mode === "analyze") {
    sendJson(res, 200, {
      success: true,
      analysis: parseAnalysis(data)
    });
    return;
  }

  if (body.mode === "quality") {
    sendJson(res, 200, { success: true, quality: parseQuality(data) });
    return;
  }

  sendJson(res, 200, parseGeneratedImages(data, body));
}

async function generateDirectStage(body: GeminiRequestBody, apiKey: string, model: string) {
  const requestedPerspective = body.settings?.perspectives?.[0] || "wide";
  const startedAt = Date.now();
  const { response, raw, model: usedModel, api: usedApi } = await requestImageWithFallback(body, apiKey, model, requestedPerspective);
  if (!response.ok) throw toGeminiUpstreamError(response.status, raw, "Gemini 图片生成失败");
  const generatedData = JSON.parse(raw);
  const generatedImage = extractInteractionImage(generatedData) || extractGeneratedContentImage(generatedData);
  if (!generatedImage) throw new Error("Gemini 未返回可用的摆放主图");
  console.log("[image-generation-success]", createGenerationTrace(
    body,
    requestedPerspective,
    usedModel,
    usedApi,
    Date.now() - startedAt,
    generatedData as Record<string, unknown>
  ));
  return [{
    perspective: requestedPerspective,
    title: requestedPerspective === "wide" ? "远景（空间全景）" : requestedPerspective === "medium" ? "侧面视角（柜体主体）" : "近景（柜体细节）",
    imageUrl: `data:${generatedImage.mimeType};base64,${generatedImage.data}`
  }];
}

async function requestImageWithFallback(body: GeminiRequestBody, apiKey: string, model: string, perspective: string) {
  let primary: { response: Response; raw: string } | undefined;
  try {
    const response = await requestImageInteraction(body, apiKey, model, perspective);
    primary = { response, raw: await response.text() };
    if (primary.response.ok) {
      return { ...primary, model, api: "interactions" };
    }
    if (shouldTryGenerateContent(primary.response.status, primary.raw)) {
      const fallbackResponse = await requestImageGenerateContent(body, apiKey, model, perspective);
      const fallbackRaw = await fallbackResponse.text();
      if (fallbackResponse.ok) return { response: fallbackResponse, raw: fallbackRaw, model, api: "generateContent" };
    }
    if (!isHighDemand(primary.response.status, primary.raw) || !model.includes("pro-image")) {
      return { ...primary, model, api: "interactions" };
    }
  } catch (error) {
    if (!model.includes("pro-image") || !isRequestTimeout(error)) throw error;
  }

  const fallbackModel = process.env.GEMINI_IMAGE_MODEL_FALLBACK || process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  if (fallbackModel === model) {
    if (primary) return { ...primary, model, api: "interactions" };
    throw new ImageGenerationUnavailable();
  }

  try {
    const response = await requestImageInteraction(body, apiKey, fallbackModel, perspective);
    const raw = await response.text();
    if (!response.ok && shouldTryGenerateContent(response.status, raw)) {
      const fallbackResponse = await requestImageGenerateContent(body, apiKey, fallbackModel, perspective);
      const fallbackRaw = await fallbackResponse.text();
      if (fallbackResponse.ok) return { response: fallbackResponse, raw: fallbackRaw, model: fallbackModel, api: "generateContent" };
    }
    if (!response.ok && isHighDemand(response.status, raw)) throw new ImageGenerationUnavailable();
    return { response, raw, model: fallbackModel, api: "interactions" };
  } catch (error) {
    if (error instanceof ImageGenerationUnavailable) throw error;
    if (isRequestTimeout(error)) throw new ImageGenerationUnavailable();
    throw error;
  }
}

function shouldTryGenerateContent(status: number, raw: string) {
  return status === 400 && /not available in your current location|available-regions|not supported|unsupported|not found/i.test(raw);
}

function getBeddingImage(body: GeminiRequestBody): { base64: string; mimeType: string } | undefined {
  return body.beddingImage || body.sofaImage;
}

function finalProductLockInstruction(perspective: string) {
  const closeRule = perspective === "close"
    ? "近景只展示柜体整体约 15% 到 25% 的一个连续局部，至少保留一个完整可识别的结构单元；柜体仍正常靠墙落地且方向不变，只移动相机靠近取景。只能选择这张图中清晰可见的区域，不得推测不可见结构、重绘产品或生成相似细节。"
    : "所有可见产品结构、模块、比例、颜色、材质与细节都必须以这张图为准，不得重设计或生成相似款。";
  return `刚刚这张未经 AI 改画的原始产品图是产品事实源。${closeRule}`;
}

function requestImageGenerateContent(body: GeminiRequestBody, apiKey: string, model: string, perspective: string) {
  const prompt = body.perspectivePrompts?.[perspective] || body.systemPrompt || "";
  const parts: GeminiPart[] = [{ text: prompt }];
  const beddingImage = getBeddingImage(body);
  if (body.roomImage?.base64) {
    parts.push({ text: "以下图片是场景与现实摆位参考，不作为产品结构依据。" });
    parts.push({ inlineData: { mimeType: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 } });
  }
  if ((body.roomReferenceImages || []).some((image) => image.base64)) {
    parts.push({ text: "以下补充图片只参考装修风格、材质、采光和空间氛围，不作为产品结构依据。" });
  }
  for (const image of body.roomReferenceImages || []) {
    if (image.base64) parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.base64 } });
  }
  if (beddingImage?.base64) {
    parts.push({ text: "以下图片是唯一产品结构依据。逐项锁定可见模块、柜门、抽屉、层板、开放格、比例、颜色和材质。" });
    parts.push({ inlineData: { mimeType: beddingImage.mimeType || "image/jpeg", data: beddingImage.base64 } });
    parts.push({ text: finalProductLockInstruction(perspective) });
  }
  if (body.productReferenceImage?.base64) {
    parts.push({ text: "以下图片是唯一产品结构依据。逐项锁定可见模块、柜门、抽屉、层板、开放格、比例、颜色和材质。" });
    parts.push({ inlineData: { mimeType: body.productReferenceImage.mimeType || "image/jpeg", data: body.productReferenceImage.base64 } });
    parts.push({ text: finalProductLockInstruction(perspective) });
  }
  return fetchWithDiagnostics(`generateContent:${model}:${perspective}`, `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["Image"],
        responseFormat: {
          image: {
            aspectRatio: body.settings?.ratio || "16:9",
            ...(model.includes("3") ? { imageSize: body.settings?.clarity || "1K" } : {})
          }
        }
      }
    })
  });
}

function requestImageInteraction(body: GeminiRequestBody, apiKey: string, model: string, perspective: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  const isAssetEdit = body.mode === "cutout" || body.mode === "erase";
  const prompt = body.perspectivePrompts?.[perspective] || body.systemPrompt || "";
  const beddingImage = getBeddingImage(body);
  const input = isAssetEdit
    ? [
        { type: "text", text: prompt },
        ...(body.mode === "erase" && body.roomImage?.base64
          ? [{ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }]
          : beddingImage?.base64
            ? [{ type: "image", mime_type: beddingImage.mimeType || "image/jpeg", data: beddingImage.base64 }]
            : [])
      ]
    : [
        { type: "text", text: `${prompt}\n\n直接从原始输入生成指定视角：${perspective}。只生成一张最终图片，不生成或参考任何 AI 中间图。` },
        ...(body.roomImage?.base64 ? [
          { type: "text", text: "以下图片是原始场景参考。远景可作为编辑底图；侧面和近景只参考空间、装修、材质与光线，不作为产品结构依据。" },
          { type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }
        ] : []),
        ...((body.roomReferenceImages || []).filter((image) => image.base64).flatMap((image) => [
          { type: "text", text: "以下图片只参考装修风格与空间氛围，不作为产品结构依据。" },
          { type: "image", mime_type: image.mimeType || "image/jpeg", data: image.base64 }
        ])),
        ...(beddingImage?.base64 ? [
          { type: "text", text: "以下未经 AI 改画的原始产品图是唯一产品结构依据。" },
          { type: "image", mime_type: beddingImage.mimeType || "image/jpeg", data: beddingImage.base64 },
          { type: "text", text: finalProductLockInstruction(perspective) }
        ] : []),
        ...(body.productReferenceImage?.base64 ? [
          { type: "text", text: "以下未经 AI 改画的原始产品图是唯一产品结构依据。" },
          { type: "image", mime_type: body.productReferenceImage.mimeType || "image/jpeg", data: body.productReferenceImage.base64 },
          { type: "text", text: finalProductLockInstruction(perspective) }
        ] : [])
      ];
  return fetchWithDiagnostics(`interactions:${model}:${perspective}:direct`, "https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      input,
      response_format: {
        type: "image",
        mime_type: "image/jpeg",
        aspect_ratio: body.settings?.ratio || "16:9",
        image_size: body.settings?.clarity || "1K"
      }
    })
  }).finally(() => clearTimeout(timeout));
}

async function fetchWithDiagnostics(label: string, url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      console.error("[api/proxy] upstream fetch failed", {
        label,
        attempt,
        willRetry: attempt < 3 && isRetryableFetchError(error),
        ...describeError(error)
      });
      if (attempt >= 3 || !isRetryableFetchError(error)) throw error;
      await sleep(700 * attempt);
    }
  }
  throw lastError;
}

function isRetryableFetchError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const cause = (error as Error & { cause?: Record<string, unknown> }).cause;
  const causeText = String(cause?.code || cause?.name || cause?.message || "");
  return /fetch failed|network|socket|terminated|timeout|aborted/i.test(error.message)
    || /ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(causeText);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHighDemand(status: number, raw: string): boolean {
  return status === 429 || status === 503 || /high demand|try again later|resource exhausted/i.test(raw);
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
}

function toGeminiUpstreamError(statusCode: number, raw: string, fallbackMessage: string): GeminiUpstreamError {
  const upstreamMessage = parseGeminiError(raw) || fallbackMessage;
  if (/denied access|permission|api key|unauthenticated|forbidden/i.test(upstreamMessage) || statusCode === 401 || statusCode === 403) {
    return new GeminiUpstreamError(statusCode, "Gemini API Key 或当前项目权限不可用，请检查 API Key 所属项目及 Gemini API 访问权限。");
  }
  if (statusCode === 404 || /not found|not supported|model.*not/i.test(upstreamMessage)) {
    return new GeminiUpstreamError(statusCode, "当前 Gemini 图片模型不可用或不支持此接口，请检查模型配置。");
  }
  return new GeminiUpstreamError(statusCode, upstreamMessage);
}


async function proxyToSaas(req: JsonRequest, res: ServerResponse, path: string) {
  const target = `${SAAS_ORIGIN}${path}${getQuery(req)}`;
  const headers: Record<string, string> = {};
  const contentType = req.headers["content-type"];

  if (typeof contentType === "string") {
    headers["Content-Type"] = contentType;
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    if (contentType?.includes("application/json")) {
      init.body = JSON.stringify(await readJsonBody(req));
    } else {
      init.body = req as never;
      init.duplex = "half";
    }
  }

  const response = await fetch(target, init);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

function createMockGeminiResponse(body: GeminiRequestBody) {
  if (body.mode === "analyze") {
    return {
      success: true,
      analysis: {
        roomSummary: "空间墙面、地面与主要通道关系清晰，可结合门窗和现有家具规划柜体位置。",
        furnitureSummary: "柜体主体清晰，应保留模块、门板、抽屉、层板、材质、颜色和木纹。",
        furnitureIdentity: {
          category: "组合书柜",
          silhouette: "以柜体参考图整体轮廓为准",
          structure: "保留参考图中的模块数量和组合关系",
          doors: "以可见柜门和玻璃门为准",
          drawers: "以可见抽屉数量为准",
          shelves: "以开放格和层板关系为准",
          material: "以可见材质纹理为准",
          color: "以主色为准",
          details: ["保留柜门、抽屉、玻璃、层板、柜脚和木纹细节"]
        },
        lighting: "自然光从侧向进入，生成时需要补充地面接触阴影和环境反射。",
        perspective: "空间具备明显纵深，柜体应随墙地关系调整视觉比例和角度。",
        placementAdvice: "建议将柜体靠完整墙面摆放，避开门窗和主要通行动线。",
        constraints: ["不要改变空间主体结构", "保持原柜体结构、材质和比例"],
        placementPlan: {
          summary: "将目标柜体靠完整墙面自然摆放，兼顾采光、现有家具和通行动线。",
          placement: "由 AI 结合可用墙面、门窗和动线选择最合适的位置。",
          facing: "柜体正面朝向空间主要活动区。",
          scale: "按墙地透视和周边家具视觉比例匹配。",
          preserve: ["保留未被明确要求移除的结构、家具和装饰"],
          remove: ["无明确移除对象"],
          avoid: ["不要遮挡门、窗和主要通道"],
          rationale: ["优先保证柜体完整展示与空间动线"],
          candidates: [
            { id: "candidate-main", label: "主墙面方案", placement: "靠完整墙面摆放，避开门窗和进出通道", facing: "正面朝向主要活动区", scale: "与墙地透视协调", score: 0.9, reasons: ["通道完整", "柜体展示充分"], blocksWalkway: false, conflictsWithPreservedItems: false, violatesUserRequirements: false },
            { id: "candidate-side", label: "侧墙方案", placement: "靠近侧墙摆放，保留采光和通道", facing: "正面朝向空间中心", scale: "略小于主墙面方案", score: 0.65, reasons: ["保留中央活动区"], blocksWalkway: false, conflictsWithPreservedItems: false, violatesUserRequirements: false }
          ],
          selectedCandidateId: "candidate-main"
        },
        stylingPlan: {
          summary: "在开放格中疏密有序地搭配书籍、陶瓷与艺术摆件。",
          books: "以竖放和横叠书籍形成层次。",
          ornaments: "搭配少量陶瓷、画框和生活物品。",
          lighting: "使用温暖环境光和自然柜内层次光。",
          atmosphere: "克制、温暖的高端家居摄影氛围。"
        },
        posterCopy: {
          seriesName: "栖居",
          productName: "书柜",
          headline: "重构多元居家空间",
          description: "温润木质与有序收纳相互平衡，让阅读、藏品与生活片段都有从容位置。",
          englishDescription: "Warm wood, thoughtful storage and collected objects shape a calm, lived-in home."
        }
      }
    };
  }

  if (body.mode === "quality") {
    return { success: true, quality: { passed: true, issues: [], correctionPrompt: "" } };
  }

  const perspectives = body.settings?.perspectives?.length ? body.settings.perspectives : ["medium"];
  return {
    success: true,
    images: perspectives.map((perspective, index) => ({
      perspective,
      title: `摆放效果 ${index + 1}`,
      imageUrl: createMockSvgDataUrl(perspective, body.settings?.ratio || "16:9")
    }))
  };
}

function parseAnalysis(data: unknown) {
  const text = extractText(data);
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return {
      roomSummary: toReadableText(parsed.roomSummary, "已识别空间、墙面与地面关系。"),
      furnitureSummary: toReadableText(parsed.furnitureSummary, "已识别柜体主体、材质和结构。"),
      furnitureIdentity: parseFurnitureIdentity(parsed.furnitureIdentity),
      lighting: toReadableText(parsed.lighting, "已判断主要光线方向。"),
      perspective: toReadableText(parsed.perspective, "已判断空间透视。"),
      placementAdvice: toReadableText(parsed.placementAdvice, "建议按空间动线自然摆放。"),
      constraints: toReadableList(parsed.constraints, ["保持空间主体结构不变"]),
      placementPlan: parsePlacementPlan(parsed.placementPlan, parsed.placementAdvice),
      stylingPlan: parseStylingPlan(parsed.stylingPlan),
      posterCopy: parsePosterCopy(parsed.posterCopy)
    };
  } catch {
    return {
      roomSummary: text || "已识别空间、墙面与地面关系。",
      furnitureSummary: "已识别柜体主体、材质和结构。",
      furnitureIdentity: parseFurnitureIdentity(null),
      lighting: "已判断主要光线方向。",
      perspective: "已判断空间透视。",
      placementAdvice: "建议按空间动线自然摆放。",
      constraints: ["保持空间主体结构不变"],
      placementPlan: parsePlacementPlan(null, "根据可用墙面和通行动线自然摆放目标柜体。"),
      stylingPlan: parseStylingPlan(null),
      posterCopy: parsePosterCopy(null)
    };
  }
}

function parseFurnitureIdentity(value: unknown) {
  const item = asRecord(value);
  return {
    category: toReadableText(item.category, "柜类家具"),
    silhouette: toReadableText(item.silhouette, "以参考图整体轮廓为准"),
    structure: toReadableText(item.structure, "以参考图可见结构为准"),
    doors: toReadableText(item.doors, "以参考图可见柜门为准"),
    drawers: toReadableText(item.drawers, "以参考图可见抽屉为准"),
    shelves: toReadableText(item.shelves, "以参考图可见开放格和层板为准"),
    material: toReadableText(item.material, "以参考图可见材质为准"),
    color: toReadableText(item.color, "以参考图主色为准"),
    details: toReadableList(item.details, ["保留参考图可见细节"])
  };
}

function parseStylingPlan(value: unknown) {
  const item = asRecord(value);
  return {
    summary: toReadableText(item.summary, "由 AI 根据柜体和空间完成自然陈设。"),
    books: toReadableText(item.books, "在开放格中疏密有序地摆放书籍。"),
    ornaments: toReadableText(item.ornaments, "搭配少量陶瓷、画框或生活物品。"),
    lighting: toReadableText(item.lighting, "沿用场景主光并增加温暖层次。"),
    atmosphere: toReadableText(item.atmosphere, "真实、温暖、克制的家居摄影氛围。")
  };
}

function parsePosterCopy(value: unknown) {
  const item = asRecord(value);
  return {
    seriesName: toReadableText(item.seriesName, "栖居"),
    productName: toReadableText(item.productName, "柜"),
    headline: toReadableText(item.headline, "重构多元居家空间"),
    description: toReadableText(item.description, "温润木质与有序收纳相互平衡，让阅读、藏品与生活片段都有从容位置。"),
    englishDescription: toReadableText(item.englishDescription, "Warm wood, thoughtful storage and collected objects shape a calm, lived-in home.")
  };
}

function parsePlacementPlan(value: unknown, fallbackAdvice: unknown) {
  const plan = asRecord(value);
  const fallback = toReadableText(fallbackAdvice, "根据可用墙面、现有家具和通行动线自然摆放目标柜体。");
  return {
    summary: toReadableText(plan.summary, fallback),
    placement: toReadableText(plan.placement, "由 AI 根据可用墙面、门窗和动线选择合适位置"),
    facing: toReadableText(plan.facing, "根据主要活动区和用户要求确定朝向"),
    scale: toReadableText(plan.scale, "保持与空间透视和周边家具视觉比例协调"),
    preserve: toReadableList(plan.preserve, ["保留未被用户明确要求移除的原有结构、家具与装饰"]),
    remove: toReadableList(plan.remove, ["无明确移除对象"]),
    avoid: toReadableList(plan.avoid, ["不要遮挡门、窗、主要通道和采光"]),
    rationale: toReadableList(plan.rationale, [fallback]),
    candidates: parseCandidates(plan.candidates),
    selectedCandidateId: toReadableText(plan.selectedCandidateId, "")
  };
}

function parseCandidates(value: unknown) {
  const candidates = Array.isArray(value) ? value : [];
  return candidates.map((candidate, index) => {
    const item = asRecord(candidate);
    const score = Number(item.score);
    return {
      id: toReadableText(item.id, `candidate-${index + 1}`),
      label: toReadableText(item.label, `候选方案 ${index + 1}`),
      placement: toReadableText(item.placement, "由 AI 根据空间动线选择合适位置"),
      facing: toReadableText(item.facing, "面向主要视觉焦点"),
      scale: toReadableText(item.scale, "按空间透视协调视觉比例"),
      score: Number.isFinite(score) ? score : 0.5,
      reasons: toReadableList(item.reasons, ["符合空间视觉关系"]),
      blocksWalkway: item.blocksWalkway === true,
      conflictsWithPreservedItems: item.conflictsWithPreservedItems === true,
      violatesUserRequirements: item.violatesUserRequirements === true
    };
  });
}

function parseQuality(data: unknown) {
  const text = extractText(data);
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return {
      passed: parsed.passed === true,
      issues: toReadableList(parsed.issues, []),
      correctionPrompt: toReadableText(parsed.correctionPrompt, "")
    };
  } catch {
    return {
      passed: false,
      issues: ["无法完成自动质检，请人工确认摆放效果。"],
      correctionPrompt: ""
    };
  }
}

/** Gemini 偶尔会把文本字段包装成数组或对象，统一转换为可展示的中文文本。 */
function toReadableText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => toReadableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  if (value && typeof value === "object") {
    const text = Object.values(value as Record<string, unknown>)
      .map((item) => toReadableText(item, ""))
      .filter(Boolean)
      .join("；");
    return text || fallback;
  }
  return fallback;
}

function toReadableList(value: unknown, fallback: string[]): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = items.map((item) => toReadableText(item, "")).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function parseGeneratedImages(data: unknown, body: GeminiRequestBody) {
  const candidates = asRecord(data).candidates as unknown[];
  const parts = asRecord(asRecord(candidates?.[0]).content).parts as unknown[];
  const images = (parts || [])
    .map((part) => asRecord(part).inlineData as { mimeType?: string; data?: string } | undefined)
    .filter((part): part is { mimeType?: string; data: string } => Boolean(part?.data))
    .map((part, index) => ({
      perspective: body.settings?.perspectives?.[index] || "medium",
      title: `摆放效果 ${index + 1}`,
      imageUrl: `data:${part.mimeType || "image/png"};base64,${part.data}`
    }));

  if (images.length) {
    return { success: true, images };
  }

  return createMockGeminiResponse(body);
}

function extractInteractionImage(data: unknown): { mimeType: string; data: string } | null {
  const record = asRecord(data);
  const outputImage = asRecord(record.output_image);
  if (typeof outputImage.data === "string") {
    return {
      mimeType: typeof outputImage.mime_type === "string" ? outputImage.mime_type : "image/png",
      data: outputImage.data
    };
  }

  const steps = Array.isArray(record.steps) ? record.steps : [];
  for (const step of steps) {
    const image = asRecord(asRecord(step).output_image);
    if (typeof image.data === "string") {
      return {
        mimeType: typeof image.mime_type === "string" ? image.mime_type : "image/png",
        data: image.data
      };
    }

    const content = asRecord(step).content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const contentItem = asRecord(item);
        if (typeof contentItem.data === "string" && String(contentItem.mime_type || "").startsWith("image/")) {
          return {
            mimeType: typeof contentItem.mime_type === "string" ? contentItem.mime_type : "image/png",
            data: contentItem.data
          };
        }
      }
    }
  }

  return findImagePayload([record.output, record.outputs, record.images, record.generated_images]);
}

function extractGeneratedContentImage(data: unknown): { mimeType: string; data: string } | null {
  const candidates = asRecord(data).candidates;
  const firstCandidate = Array.isArray(candidates) ? asRecord(candidates[0]) : {};
  const content = asRecord(firstCandidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    const source = asRecord(part);
    const image = asRecord(source.inlineData || source.inline_data);
    if (typeof image.data === "string") {
      return {
        mimeType: typeof image.mimeType === "string" ? image.mimeType : typeof image.mime_type === "string" ? image.mime_type : "image/png",
        data: image.data
      };
    }
  }
  return findImagePayload(parts);
}

function findImagePayload(source: unknown): { mimeType: string; data: string } | null {
  const queue = Array.isArray(source) ? [...source] : [source];
  const seen = new Set<object>();
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const record = item as Record<string, unknown>;

    const directMime = record.mime_type || record.mimeType || record.mime || record.media_type;
    if (typeof record.data === "string" && String(directMime || "").startsWith("image/")) {
      return { mimeType: String(directMime || "image/png"), data: record.data };
    }

    const inline = asRecord(record.inlineData || record.inline_data);
    const inlineMime = inline.mimeType || inline.mime_type || inline.mime;
    if (typeof inline.data === "string" && String(inlineMime || "").startsWith("image/")) {
      return { mimeType: String(inlineMime || "image/png"), data: inline.data };
    }

    const image = asRecord(record.image || record.output_image || record.generated_image);
    const imageMime = image.mimeType || image.mime_type || image.mime;
    if (typeof image.data === "string" && String(imageMime || "").startsWith("image/")) {
      return { mimeType: String(imageMime || "image/png"), data: image.data };
    }

    for (const key of ["content", "parts", "outputs", "output", "images", "generated_images"]) {
      const nested = record[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return null;
}

function extractText(data: unknown): string {
  const candidates = asRecord(data).candidates as unknown[];
  const parts = asRecord(asRecord(candidates?.[0]).content).parts as unknown[];
  return (parts || [])
    .map((part) => asRecord(part).text)
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .trim();
}

function mapModel(model?: string, mode?: string): string {
  if (mode === "analyze" || mode === "quality") {
    return process.env.GEMINI_ANALYZE_MODEL || "gemini-2.5-flash";
  }

  if (model === "gemini-3") {
    return process.env.GEMINI_IMAGE_MODEL_3 || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
  }

  return process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
}

async function readJsonBody<T = unknown>(req: JsonRequest): Promise<T> {
  if (req.body) {
    return req.body as T;
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) {
      throw new Error("请求体超过 20MB，请压缩图片后重试");
    }
    chunks.push(buffer);
  }

  if (!chunks.length) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
}

function getRequestPath(req: IncomingMessage): string {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  if (url.pathname === "/api/proxy" || url.pathname === "/api/proxy.ts") {
    const rewrittenPath = url.searchParams.get("path");
    if (rewrittenPath) {
      return `/api/${rewrittenPath.replace(/^\/+/, "")}`;
    }
  }
  return url.pathname;
}

function getQuery(req: IncomingMessage): string {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  if (url.pathname === "/api/proxy" || url.pathname === "/api/proxy.ts") {
    url.searchParams.delete("path");
  }
  return url.search;
}

function stripCodeFence(text: string): string {
  return text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function parseGeminiError(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const message = asRecord(first).error && typeof asRecord(asRecord(first).error).message === "string"
      ? String(asRecord(asRecord(first).error).message)
      : "";
    if (/not available in your current location|available-regions/i.test(message)) {
      return "Gemini API 当前调用地区不可用。请将后端服务部署在 Gemini API 支持的国家或地区，或改用 Google Cloud 的企业平台 Gemini API。";
    }
    return message;
  } catch {
    if (/not available in your current location|available-regions/i.test(raw)) {
      return "Gemini API 当前调用地区不可用。请将后端服务部署在 Gemini API 支持的国家或地区，或改用 Google Cloud 的企业平台 Gemini API。";
    }
    return raw.slice(0, 200);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function createMockSvgDataUrl(perspective: string, ratio: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
  <rect width="1400" height="900" fill="#edf2f7"/>
  <path d="M0 610 L1400 470 L1400 900 L0 900 Z" fill="#d6c6ad"/>
  <path d="M0 0 H1400 V470 L0 610 Z" fill="#f8fafc"/>
  <rect x="170" y="190" width="390" height="250" rx="8" fill="#dbeafe"/>
  <rect x="775" y="190" width="430" height="250" rx="8" fill="#e2e8f0"/>
  <ellipse cx="700" cy="690" rx="390" ry="70" fill="#b8a58d" opacity=".36"/>
  <rect x="405" y="520" width="590" height="155" rx="30" fill="#52616f"/>
  <rect x="450" y="465" width="500" height="130" rx="28" fill="#64748b"/>
  <rect x="450" y="640" width="52" height="88" rx="12" fill="#334155"/>
  <rect x="898" y="640" width="52" height="88" rx="12" fill="#334155"/>
  <text x="700" y="805" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" fill="#334155">AI 柜类试摆 · ${escapeXml(perspective)} · ${escapeXml(ratio)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
    return map[char] || char;
  });
}



