import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const distDir = join(root, "dist");
const runtimeLogPath = join(root, "trial-runtime.log");
const preferredPort = Number(process.env.PORT || 5174);

class ImageGenerationUnavailable extends Error {
  constructor() {
    super("图片生成服务当前繁忙，请稍后重试。已尝试高精度与备用模型，但均未在限定时间内响应。");
  }
}

class GeminiUpstreamError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

loadEnv(join(root, ".env.local"));
loadEnv(join(root, ".env"));

const server = createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/gemini" && req.method === "POST") {
      await handleGemini(req, res);
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    const statusCode = error instanceof GeminiUpstreamError
      ? error.statusCode
      : error instanceof ImageGenerationUnavailable
        ? 503
        : 500;
    console.error("[local-trial-server] request failed", {
      url: req.url,
      method: req.method,
      statusCode,
      ...describeError(error)
    });
    sendJson(res, statusCode, {
      success: false,
      message: error instanceof Error ? error.message : "本地服务处理失败"
    });
  }
});

listenWithFallback(server, preferredPort);

function listenWithFallback(targetServer, targetPort) {
  targetServer.once("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      const nextPort = targetPort + 1;
      console.log(`Port ${targetPort} is in use, trying ${nextPort}...`);
      listenWithFallback(targetServer, nextPort);
      return;
    }
    throw error;
  });

  targetServer.listen(targetPort, () => {
    console.log(`Local trial server ready: http://localhost:${targetPort}`);
  });
}

function describeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  const cause = error.cause instanceof Error || typeof error.cause === "object" && error.cause
    ? error.cause
    : undefined;
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

function fingerprintText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createGenerationTrace(body, perspective, usedModel, usedApi, durationMs, generatedData) {
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
      id: generatedData?.id || null,
      model: generatedData?.model || generatedData?.modelVersion || null,
      status: generatedData?.status || null
    }
  };
}

function logGenerationSuccess(trace) {
  const line = `[image-generation-success] ${JSON.stringify(trace)}`;
  console.log(line);
  try {
    appendFileSync(runtimeLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("[local-trial-server] failed to persist runtime log", describeError(error));
  }
}

async function handleGemini(req, res) {
  const body = await readJson(req);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    sendJson(res, 500, {
      success: false,
      message: "未配置 GEMINI_API_KEY，当前没有调用真实 Gemini API。请在 .env.local 或 Vercel 环境变量中配置后重启服务。"
    });
    return;
  }

  const model = mapModel(body.model, body.mode);
  const parts = [{ text: body.systemPrompt || "" }];

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

  if (getBeddingImage(body)?.base64) {
    parts.push({
      inlineData: {
        mimeType: getBeddingImage(body).mimeType || "image/jpeg",
        data: getBeddingImage(body).base64
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
    sendJson(res, 200, images.length ? { success: true, images } : createMockResponse(body));
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
    sendJson(res, 200, { success: true, analysis: parseAnalysis(data) });
    return;
  }

  if (body.mode === "quality") {
    sendJson(res, 200, { success: true, quality: parseQuality(data) });
    return;
  }

  sendJson(res, 200, parseGeneratedImages(data, body));
}

async function generateDirectStage(body, apiKey, model) {
  const requestedPerspective = body.settings?.perspectives?.[0] || "wide";
  const startedAt = Date.now();
  const { response, raw, model: usedModel, api: usedApi } = await requestImageWithFallback(body, apiKey, model, requestedPerspective);
  if (!response.ok) throw toGeminiUpstreamError(response.status, raw, "Gemini 图片生成失败");
  const generatedData = JSON.parse(raw);
  const generatedImage = extractInteractionImage(generatedData) || extractGeneratedContentImage(generatedData);
  if (!generatedImage) console.error("[local-trial-server] Gemini image response had no extractable image", summarizeGeminiShape(generatedData));
  if (!generatedImage) throw new Error("Gemini 未返回可用的摆放主图");
  logGenerationSuccess(createGenerationTrace(body, requestedPerspective, usedModel, usedApi, Date.now() - startedAt, generatedData));
  return [{
    perspective: requestedPerspective,
    title: requestedPerspective === "wide" ? "远景（空间全景）" : requestedPerspective === "medium" ? "侧面视角（柜体主体）" : "近景（柜体细节）",
    imageUrl: `data:${generatedImage.mimeType};base64,${generatedImage.data}`
  }];
}

async function requestImageWithFallback(body, apiKey, model, perspective) {
  let primary;
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

function shouldTryGenerateContent(status, raw) {
  return status === 400 && /not available in your current location|available-regions|not supported|unsupported|not found/i.test(raw);
}

function getBeddingImage(body) {
  return body.beddingImage || body.sofaImage;
}

function finalProductLockInstruction(perspective) {
  const closeRule = perspective === "close"
    ? "近景只展示柜体整体约 15% 到 25% 的一个连续局部，至少保留一个完整可识别的结构单元；柜体仍正常靠墙落地且方向不变，只移动相机靠近取景。只能选择这张图中清晰可见的区域，不得推测不可见结构、重绘产品或生成相似细节。"
    : "所有可见产品结构、模块、比例、颜色、材质与细节都必须以这张图为准，不得重设计或生成相似款。";
  return `刚刚这张未经 AI 改画的原始产品图是产品事实源。${closeRule}`;
}

function requestImageGenerateContent(body, apiKey, model, perspective) {
  const prompt = body.perspectivePrompts?.[perspective] || body.systemPrompt || "";
  const parts = [{ text: prompt }];
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
            ...(String(model).includes("3") ? { imageSize: body.settings?.clarity || "1K" } : {})
          }
        }
      }
    })
  });
}

function requestImageInteraction(body, apiKey, model, perspective) {
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

async function fetchWithDiagnostics(label, url, init) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      console.error("[local-trial-server] upstream fetch failed", {
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

function isRetryableFetchError(error) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause || {};
  return /fetch failed|network|socket|terminated|timeout|aborted/i.test(error.message)
    || /ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(String(cause.code || cause.name || cause.message || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHighDemand(status, raw) {
  return status === 429 || status === 503 || /high demand|try again later|resource exhausted/i.test(raw);
}

function isRequestTimeout(error) {
  return error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
}

function toGeminiUpstreamError(statusCode, raw, fallbackMessage) {
  const upstreamMessage = parseGeminiError(raw) || fallbackMessage;
  if (/denied access|permission|api key|unauthenticated|forbidden/i.test(upstreamMessage) || statusCode === 401 || statusCode === 403) {
    return new GeminiUpstreamError(statusCode, "Gemini API Key 或当前项目权限不可用，请检查 API Key 所属项目及 Gemini API 访问权限。");
  }
  if (statusCode === 404 || /not found|not supported|model.*not/i.test(upstreamMessage)) {
    return new GeminiUpstreamError(statusCode, "当前 Gemini 图片模型不可用或不支持此接口，请检查模型配置。");
  }
  return new GeminiUpstreamError(statusCode, upstreamMessage);
}


function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(distDir, cleanPath));
  const safeDist = normalize(distDir);
  const target = filePath.startsWith(safeDist) && existsSync(filePath) ? filePath : join(distDir, "index.html");

  const content = readFileSync(target);
  res.writeHead(200, { "Content-Type": mimeType(target) });
  res.end(content);
}

function createMockResponse(body) {
  if (body.mode === "analyze") {
    return {
      success: true,
      analysis: {
        roomSummary: "空间墙面、地面和主要通道关系清晰，适合进行柜体试摆。",
        furnitureSummary: "柜体主体清晰，应保留模块、门板、抽屉、层板、材质、颜色和木纹。",
        furnitureIdentity: {
          category: "柜类家具",
          silhouette: "以参考图整体轮廓为准",
          structure: "以参考图可见模块和结构为准",
          doors: "以可见柜门为准",
          drawers: "以可见抽屉为准",
          shelves: "以开放格和层板关系为准",
          material: "以可见材质为准",
          color: "以参考图主色为准",
          details: ["保留柜门、抽屉、玻璃、层板、柜脚和木纹"]
        },
        lighting: "自然光从侧向进入，需要补充地面接触阴影和环境反射。",
        perspective: "空间具备明显纵深，柜体应随墙地关系调整视觉比例和角度。",
        placementAdvice: "建议优先靠完整墙面试摆，避免遮挡门窗和主要通行动线。",
        constraints: ["不要改变空间主体结构", "保持原柜体结构、材质和视觉比例"],
        placementPlan: {
          summary: "将目标柜体靠完整墙面自然试摆，优先保证通行与视觉平衡。",
          placement: "由 AI 结合可用墙面和动线选择最合适的位置。",
          facing: "正面朝向空间主要活动区。",
          scale: "按墙地透视和周边家具视觉比例匹配。",
          preserve: ["保留未被明确要求移除的结构、家具和装饰"],
          remove: ["无明确移除对象"],
          avoid: ["不要遮挡通道、门窗和主要采光"],
          rationale: ["优先保证会客区使用舒适与空间动线完整"],
          candidates: [
            { id: "candidate-main", label: "主墙面方案", placement: "靠完整墙面摆放，避开进出通道", facing: "正面朝向主要活动区", scale: "与墙地透视协调", score: 0.9, reasons: ["通道完整", "视觉平衡"], blocksWalkway: false, conflictsWithPreservedItems: false, violatesUserRequirements: false },
            { id: "candidate-side", label: "侧墙方案", placement: "靠近侧墙摆放", facing: "朝向空间中心", scale: "略小于主会客区方案", score: 0.65, reasons: ["可保留中央活动区"], blocksWalkway: false, conflictsWithPreservedItems: false, violatesUserRequirements: false },
            { id: "candidate-blocked", label: "通道阻塞方案", placement: "靠近出入口摆放", facing: "朝向电视墙", scale: "偏大", score: 0.8, reasons: ["会影响通行"], blocksWalkway: true, conflictsWithPreservedItems: false, violatesUserRequirements: false }
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
          productName: "柜",
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

function parseAnalysis(data) {
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

function parseFurnitureIdentity(value) {
  const item = value && typeof value === "object" ? value : {};
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

function parseStylingPlan(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    summary: toReadableText(item.summary, "由 AI 根据柜体和空间完成自然陈设。"),
    books: toReadableText(item.books, "在开放格中疏密有序地摆放书籍。"),
    ornaments: toReadableText(item.ornaments, "搭配少量陶瓷、画框或生活物品。"),
    lighting: toReadableText(item.lighting, "沿用场景主光并增加温暖层次。"),
    atmosphere: toReadableText(item.atmosphere, "真实、温暖、克制的家居摄影氛围。")
  };
}

function parsePosterCopy(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    seriesName: toReadableText(item.seriesName, "栖居"),
    productName: toReadableText(item.productName, "柜"),
    headline: toReadableText(item.headline, "重构多元居家空间"),
    description: toReadableText(item.description, "温润木质与有序收纳相互平衡，让阅读、藏品与生活片段都有从容位置。"),
    englishDescription: toReadableText(item.englishDescription, "Warm wood, thoughtful storage and collected objects shape a calm, lived-in home.")
  };
}

function parsePlacementPlan(value, fallbackAdvice) {
  const plan = value && typeof value === "object" ? value : {};
  const fallback = toReadableText(fallbackAdvice, "根据可用墙面和通行动线自然摆放目标柜体。");
  return {
    summary: toReadableText(plan.summary, fallback),
    placement: toReadableText(plan.placement, "由 AI 根据可用墙面、现有家具和动线选择合适位置"),
    facing: toReadableText(plan.facing, "根据主要活动区和用户要求确定朝向"),
    scale: toReadableText(plan.scale, "保持与空间透视和周边家具视觉比例协调"),
    preserve: toReadableList(plan.preserve, ["保留未被用户明确要求移除的原有结构、家具与装饰"]),
    remove: toReadableList(plan.remove, ["无明确移除对象"]),
    avoid: toReadableList(plan.avoid, ["不要遮挡通道、门窗、主要采光和核心功能区"]),
    rationale: toReadableList(plan.rationale, [fallback]),
    candidates: parseCandidates(plan.candidates),
    selectedCandidateId: toReadableText(plan.selectedCandidateId, "")
  };
}

function parseCandidates(value) {
  const candidates = Array.isArray(value) ? value : [];
  return candidates.map((candidate, index) => {
    const item = candidate && typeof candidate === "object" ? candidate : {};
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

function parseQuality(data) {
  const text = extractText(data);
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return {
      passed: parsed.passed === true,
      issues: toReadableList(parsed.issues, []),
      correctionPrompt: toReadableText(parsed.correctionPrompt, "")
    };
  } catch {
    return { passed: false, issues: ["无法完成自动质检，请人工确认摆放效果。"], correctionPrompt: "" };
  }
}

function toReadableText(value, fallback) {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => toReadableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  if (value && typeof value === "object") {
    const text = Object.values(value).map((item) => toReadableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  return fallback;
}

function toReadableList(value, fallback) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = items.map((item) => toReadableText(item, "")).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function parseGeneratedImages(data, body) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const images = parts
    .map((part) => part.inlineData)
    .filter((part) => part?.data)
    .map((part, index) => ({
      perspective: body.settings?.perspectives?.[index] || "medium",
      title: `摆放效果 ${index + 1}`,
      imageUrl: `data:${part.mimeType || "image/png"};base64,${part.data}`
    }));

  return images.length ? { success: true, images } : createMockResponse(body);
}

function summarizeGeminiShape(data) {
  const topLevel = data && typeof data === "object" ? Object.keys(data) : [];
  const candidateParts = data?.candidates?.[0]?.content?.parts || [];
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  return {
    topLevel,
    hasOutputImage: Boolean(data?.output_image),
    outputImageKeys: data?.output_image ? Object.keys(data.output_image) : [],
    candidatePartShapes: candidateParts.map((part) => ({
      keys: Object.keys(part || {}),
      inlineDataKeys: part?.inlineData ? Object.keys(part.inlineData) : [],
      inline_dataKeys: part?.inline_data ? Object.keys(part.inline_data) : [],
      textPreview: typeof part?.text === "string" ? part.text.slice(0, 160) : ""
    })),
    stepShapes: steps.slice(0, 3).map((step) => ({
      keys: Object.keys(step || {}),
      outputImageKeys: step?.output_image ? Object.keys(step.output_image) : [],
      contentTypes: Array.isArray(step?.content)
        ? step.content.slice(0, 5).map((item) => ({ keys: Object.keys(item || {}), type: item?.type, mime_type: item?.mime_type }))
        : []
    }))
  };
}

function extractInteractionImage(data) {
  if (data?.output_image?.data) {
    return {
      mimeType: data.output_image.mime_type || "image/png",
      data: data.output_image.data
    };
  }

  for (const step of data?.steps || []) {
    if (step?.output_image?.data) {
      return {
        mimeType: step.output_image.mime_type || "image/png",
        data: step.output_image.data
      };
    }

    for (const item of step?.content || []) {
      if (item?.data && String(item?.mime_type || "").startsWith("image/")) {
        return {
          mimeType: item.mime_type || "image/png",
          data: item.data
        };
      }
    }
  }

  return findImagePayload([data?.output, data?.outputs, data?.images, data?.generated_images]);
}

function extractGeneratedContentImage(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const image = part?.inlineData || part?.inline_data;
    if (image?.data) {
      return {
        mimeType: image.mimeType || image.mime_type || "image/png",
        data: image.data
      };
    }
  }
  return findImagePayload(parts);
}

function findImagePayload(source) {
  const queue = Array.isArray(source) ? [...source] : [source];
  const seen = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);

    const directMime = item.mime_type || item.mimeType || item.mime || item.media_type;
    if (typeof item.data === "string" && String(directMime || "").startsWith("image/")) {
      return { mimeType: directMime || "image/png", data: item.data };
    }

    const inline = item.inlineData || item.inline_data;
    const inlineMime = inline?.mimeType || inline?.mime_type || inline?.mime;
    if (typeof inline?.data === "string" && String(inlineMime || "").startsWith("image/")) {
      return { mimeType: inlineMime || "image/png", data: inline.data };
    }

    const image = item.image || item.output_image || item.generated_image;
    const imageMime = image?.mimeType || image?.mime_type || image?.mime;
    if (typeof image?.data === "string" && String(imageMime || "").startsWith("image/")) {
      return { mimeType: imageMime || "image/png", data: image.data };
    }

    for (const key of ["content", "parts", "outputs", "output", "images", "generated_images"]) {
      const nested = item[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return null;
}

function extractText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function mapModel(model, mode) {
  if (mode === "analyze" || mode === "quality") {
    return process.env.GEMINI_ANALYZE_MODEL || "gemini-2.5-flash";
  }

  if (model === "gemini-3") {
    return process.env.GEMINI_IMAGE_MODEL_3 || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
  }

  return process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseGeminiError(raw) {
  try {
    const parsed = JSON.parse(raw);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const error = asRecord(first).error;
    const message = typeof asRecord(error).message === "string" ? asRecord(error).message : "";
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

function stripCodeFence(text) {
  return text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function mimeType(path) {
  const ext = extname(path);
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  }[ext] || "application/octet-stream";
}

function createMockSvgDataUrl(perspective, ratio) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
  <rect width="1400" height="900" fill="#edf2f7"/>
  <path d="M0 610 L1400 470 L1400 900 L0 900 Z" fill="#d6c6ad"/>
  <path d="M0 0 H1400 V470 L0 610 Z" fill="#f8fafc"/>
  <rect x="170" y="190" width="390" height="250" rx="8" fill="#dbeafe"/>
  <rect x="775" y="190" width="430" height="250" rx="8" fill="#e2e8f0"/>
  <ellipse cx="700" cy="690" rx="390" ry="70" fill="#b8a58d" opacity=".36"/>
  <rect x="405" y="520" width="590" height="155" rx="30" fill="#52616f"/>
  <rect x="450" y="465" width="500" height="130" rx="28" fill="#64748b"/>
  <text x="700" y="805" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" fill="#334155">AI 柜类试摆 · ${escapeXml(perspective)} · ${escapeXml(ratio)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => {
    const map = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
    return map[char] || char;
  });
}
