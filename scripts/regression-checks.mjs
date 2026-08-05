import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const promptSource = await readFile(new URL("../src/services/prompt.ts", import.meta.url), "utf8");
const componentSource = await readFile(new URL("../src/CabinetPlacementTool.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../src/CabinetPlacementTool.module.css", import.meta.url), "utf8");
const constantsSource = await readFile(new URL("../src/constants.ts", import.meta.url), "utf8");
const geminiSource = await readFile(new URL("../src/services/gemini.ts", import.meta.url), "utf8");
const imageSource = await readFile(new URL("../src/services/image.ts", import.meta.url), "utf8");
const proxySource = await readFile(new URL("../api/proxy.ts", import.meta.url), "utf8");
const localServerSource = await readFile(new URL("../scripts/local-trial-server.mjs", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

assert.match(promptSource, /真实真人/);
assert.match(promptSource, /衣着完整/);
assert.match(promptSource, /不得生成裸体人物、人体假模型、人台、雕塑或 3D 人偶/);
assert.doesNotMatch(promptSource, /人物不能遮挡柜体主要轮廓/);
assert.match(promptSource, /最后一张是未经 AI 改画的原始产品图，是产品外观的最高优先级依据/);
assert.match(promptSource, /近景只展示原始产品中一个明确存在的局部/);
assert.match(promptSource, /近景沿用远景与侧面的正常摆放逻辑/);
assert.match(promptSource, /这是单次生成的近景源画面/);
assert.match(promptSource, /源画面展示柜体约 50% 到 70%/);
assert.match(promptSource, /中央安全取景区/);
assert.match(promptSource, /最终近景由前端本地裁切/);
assert.match(promptSource, /一个完整且可识别的结构单元/);
assert.doesNotMatch(promptSource, /柜体整体约 8% 到 18%/);
assert.doesNotMatch(promptSource, /近景应展示柜体整体约 15% 到 25%/);
assert.match(promptSource, /近景不是产品重设计或三维结构补全/);
assert.match(promptSource, /只能选择原始产品图中清晰可见、可直接核对的连续区域/);
assert.match(promptSource, /左前方或右前方约 45 度/);
assert.match(promptSource, /只展示柜体约 50% 到 70%/);
assert.match(promptSource, /侧板可见性只能来自相机视差/);
assert.match(promptSource, /柜体背板与墙面保持平行并完整贴墙/);
assert.match(promptSource, /柜体自身的偏航、俯仰和翻滚角始终为零/);
assert.match(promptSource, /近侧侧板的投影宽度约占柜体可见投影总宽度的 12% 到 20%/);
assert.match(promptSource, /允许柜体在新画面中的二维位置、投影大小和遮挡关系随相机自然变化/);
assert.match(promptSource, /唯一产品结构依据/);
assert.doesNotMatch(promptSource, /原始产品图及主图一致/);
assert.match(promptSource, /placement: "保持已确认的靠墙位置/);
assert.match(promptSource, /placement: "近景源画面保持已确认的正常靠墙落地位置/);
assert.match(promptSource, /最终近景只由前端本地裁切产生/);
assert.match(promptSource, /placementPlanForPerspective/);
assert.match(promptSource, /candidates: \[\]/);
assert.match(promptSource, /当前任务是参考重建，不是编辑原场景照片/);
assert.match(promptSource, /禁止把场景参考图当作编辑底图/);
assert.match(promptSource, /当前待检图是近景源画面，不是最终本地裁切图/);
assert.match(promptSource, /产品一致性为 P0，优先于用户备注、场景参考、摆放方案、软装方案、平台上下文、关键词和视角构图/);
assert.match(promptSource, /任何低优先级要求与产品结构、数量、比例、颜色、材质或可见细节冲突时，必须忽略冲突部分/);
assert.doesNotMatch(promptSource, /用户额外要求（最高优先级/);
assert.doesNotMatch(promptSource, /用户当前要求（最高优先级/);
assert.match(constantsSource, /绝不能覆盖第 1 条产品一致性/);
assert.match(constantsSource, /wide: "远景（空间全景）"/);
assert.match(constantsSource, /medium: "侧面视角（柜体主体）"/);
assert.match(constantsSource, /close: "近景（柜体细节）"/);
assert.match(proxySource, /https:\/\/generativelanguage\.googleapis\.com\/v1\/models\/\$\{encodeURIComponent\(model\)\}:generateContent/);
assert.match(proxySource, /"x-goog-api-key": apiKey/);
assert.match(localServerSource, /https:\/\/generativelanguage\.googleapis\.com\/v1\/models\/\$\{encodeURIComponent\(model\)\}:generateContent/);
assert.match(localServerSource, /"x-goog-api-key": apiKey/);
assert.ok(
  (proxySource.match(/body\.productReferenceImage\?\.base64/g) || []).length >= 4,
  "生产代理必须在通用输入、GenerateContent 和 Interactions 两个分支中转发原始产品图"
);
assert.ok(
  (localServerSource.match(/body\.productReferenceImage\?\.base64/g) || []).length >= 4,
  "本地代理必须在通用输入、GenerateContent 和 Interactions 两个分支中转发原始产品图"
);
assert.match(proxySource, /Array\.isArray\(parsed\) \? parsed\[0\] : parsed/);
assert.match(localServerSource, /Array\.isArray\(parsed\) \? parsed\[0\] : parsed/);
assert.doesNotMatch(typesSource, /generationStage|previousInteractionId|continuationModel|GeminiMasterResponse/);
assert.doesNotMatch(proxySource, /generationStage|previousInteractionId|previous_interaction_id|generateMasterStage|generateCameraStage/);
assert.doesNotMatch(localServerSource, /generationStage|previousInteractionId|previous_interaction_id|generateMasterStage|generateCameraStage/);
assert.match(proxySource, /model: usedModel, api: usedApi/);
assert.match(localServerSource, /model: usedModel, api: usedApi/);
assert.match(proxySource, /\[image-generation-success\]/);
assert.match(localServerSource, /\[image-generation-success\]/);
assert.match(localServerSource, /trial-runtime\.log/);
assert.match(proxySource, /promptFingerprint/);
assert.match(localServerSource, /promptFingerprint/);
assert.match(proxySource, /productReference: Boolean\(body\.productReferenceImage\?\.base64\)/);
assert.match(localServerSource, /productReference: Boolean\(body\.productReferenceImage\?\.base64\)/);
assert.match(proxySource, /以下图片是唯一产品结构依据/);
assert.match(localServerSource, /以下图片是唯一产品结构依据/);
assert.match(proxySource, /刚刚这张未经 AI 改画的原始产品图是产品事实源/);
assert.match(localServerSource, /刚刚这张未经 AI 改画的原始产品图是产品事实源/);
assert.match(proxySource, /近景源画面展示柜体约 50% 到 70%/);
assert.match(localServerSource, /近景源画面展示柜体约 50% 到 70%/);
assert.match(geminiSource, /async function generatePerspectiveBatch/);
assert.ok(
  (geminiSource.match(/const requestedPerspective = settings\.perspectives\[0\] \|\| "wide"/g) || []).length >= 2,
  "场景试摆和虚拟空间服务都必须只读取第一个视角"
);
assert.doesNotMatch(geminiSource, /buildCameraVariationPrompt|generationStage|GeminiMasterResponse|masterResponse|previousInteractionId/);
assert.match(geminiSource, /const retryableStatuses = new Set\(\[429, 500, 502, 503, 504\]\)/);
assert.doesNotMatch(
  geminiSource,
  /:\s*\{ roomImage, roomReferenceImages, beddingImage \}/,
  "远景生成不得重复发送体积不可控的透明柜体前景"
);
assert.match(geminiSource, /roomImage,\s*roomReferenceImages,\s*productReferenceImage/);
assert.match(geminiSource, /response\.status === 413/);
assert.doesNotMatch(geminiSource, /wideConsistencyReference/);
assert.match(geminiSource, /\[perspective\]: buildGenerationPrompt\([\s\S]*perspective !== "wide"/);
assert.match(geminiSource, /\[perspective\]: buildVirtualRoomPrompt/);
assert.doesNotMatch(promptSource, /上一轮远景|隐藏远景|换相机任务/);
assert.match(promptSource, /禁止旋转、斜摆、平移、抬高、压低或拉伸柜体/);
assert.match(promptSource, /清楚看到正面和一侧侧板/);
assert.doesNotMatch(promptSource, /相同的相机高度、焦距、拍摄距离和柜体垂直画面占比/);
assert.match(geminiSource, /perspectives: \[perspective\]/);
assert.match(geminiSource, /perspectivePrompts/);
assert.match(componentSource, /let generationFailures = generationBatch\.failures/);
assert.doesNotMatch(componentSource, /已保留其余结果/);
assert.match(componentSource, /function selectPerspective/);
assert.match(componentSource, /perspectives: \[value\]/);
assert.match(componentSource, /const selectedPerspective = settings\.perspectives\[0\] \|\| "wide"/);
assert.doesNotMatch(componentSource, /function togglePerspective/);
assert.match(componentSource, /单选；每次只生成一张完整海报/);
assert.match(componentSource, /Object\.entries\(perspectiveLabels\)/);
assert.doesNotMatch(componentSource, /每个视角生成一张完整海报/);
assert.match(componentSource, /title: `\$\{item\.title\}海报`/);
assert.match(componentSource, /clarity: selectedPerspective === "close" \? "2K" : settings\.clarity === "4K" \? "2K" : settings\.clarity/);
assert.match(componentSource, /selectedPerspective === "close" \? "2K"/);
assert.match(componentSource, /createFixedCameraViews\(closeSource\.imageUrl, \["close"\], generationSettings\.ratio\)/);
assert.match(componentSource, /images = \[\{ \.\.\.closeSource, imageUrl: closeView\.imageUrl \}\]/);
assert.match(imageSource, /perspective === "medium" \? 0\.5 : 0\.45/);
assert.match(imageSource, /export const GEMINI_PRODUCT_TARGET_BYTES = 900 \* 1024/);
assert.match(componentSource, /kind === "furniture" \? 1800 : undefined/);
assert.match(componentSource, /kind === "furniture" \? GEMINI_PRODUCT_TARGET_BYTES : GEMINI_IMAGE_TARGET_BYTES/);
assert.match(componentSource, /mode === "expert" && guidedStep === "generating" \? styles\.generatingShell : ""/);
assert.match(cssSource, /\.generatingShell[\s\S]*overflow:\s*hidden/);
assert.match(cssSource, /\.generatingShell \.generatingCard[\s\S]*min-height:\s*0/);
assert.match(cssSource, /@media \(max-width: 880px\)[\s\S]*\.generatingShell[\s\S]*overflow-y:\s*auto/);

const generateHandlerStart = componentSource.indexOf("async function handleGenerate");
const posterCompositionPosition = componentSource.indexOf("await composeCabinetPoster", generateHandlerStart);
assert.ok(generateHandlerStart >= 0, "应存在生成处理函数");
assert.equal(componentSource.indexOf("checkGeneratedPlacement", generateHandlerStart), -1, "生成主流程不得调用结果校验");
assert.ok(posterCompositionPosition > generateHandlerStart, "生成结果应直接进入海报合成");

const { removeConnectedStudioBackground } = await import("../src/services/backgroundMask.ts");

function makePixels(width, height, pixelAt) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue, alpha = 255] = pixelAt(x, y);
      pixels.set([red, green, blue, alpha], offset);
    }
  }
  return pixels;
}

const width = 12;
const height = 12;
const checkerPixels = makePixels(width, height, (x, y) => {
  if (x >= 4 && x <= 7 && y >= 3 && y <= 9) return [82, 49, 31, 255];
  return (x + y) % 2 === 0 ? [242, 242, 242, 255] : [214, 214, 214, 255];
});
const checkerResult = removeConnectedStudioBackground(checkerPixels, width, height);
assert.equal(checkerResult.pixels[3], 0, "棋盘格边角必须变为透明");
assert.equal(checkerResult.pixels[((6 * width + 6) * 4) + 3], 255, "柜体主体不能被抠除");
assert.ok(checkerResult.transparentEdgeRatio > 0.95, "棋盘格四周应全部透明");

const greenPixels = makePixels(width, height, (x, y) => {
  if (x >= 3 && x <= 8 && y >= 2 && y <= 10) return [99, 60, 36, 255];
  return [0, 255, 0, 255];
});
const greenResult = removeConnectedStudioBackground(greenPixels, width, height);
assert.equal(greenResult.pixels[3], 0, "绿幕边角必须变为透明");
assert.equal(greenResult.pixels[((6 * width + 6) * 4) + 3], 255, "绿幕抠除不能损伤柜体主体");

console.log("Regression checks passed.");
