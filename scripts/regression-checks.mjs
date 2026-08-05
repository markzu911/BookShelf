import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const promptSource = await readFile(new URL("../src/services/prompt.ts", import.meta.url), "utf8");
const componentSource = await readFile(new URL("../src/CabinetPlacementTool.tsx", import.meta.url), "utf8");
const constantsSource = await readFile(new URL("../src/constants.ts", import.meta.url), "utf8");
const geminiSource = await readFile(new URL("../src/services/gemini.ts", import.meta.url), "utf8");
const proxySource = await readFile(new URL("../api/proxy.ts", import.meta.url), "utf8");
const localServerSource = await readFile(new URL("../scripts/local-trial-server.mjs", import.meta.url), "utf8");

assert.match(promptSource, /真实真人/);
assert.match(promptSource, /衣着完整/);
assert.match(promptSource, /不得生成裸体人物、人体假模型、人台、雕塑或 3D 人偶/);
assert.doesNotMatch(promptSource, /人物不能遮挡柜体主要轮廓/);
assert.match(promptSource, /第三张是未经 AI 改画的原始产品图，是产品外观的最高优先级依据/);
assert.match(promptSource, /近景只展示原始产品中一个明确存在的局部/);
assert.match(promptSource, /侧面空场景重建/);
assert.match(promptSource, /画面中不得出现任何书柜、斗柜、组合柜或柜类产品/);
assert.match(promptSource, /viewpoint/);
assert.match(promptSource, /sideDirectionForProduct/);
assert.match(promptSource, /相机可以位于柜体左前方或右前方约40至45度/);
assert.doesNotMatch(promptSource, /50至55度/);
assert.match(promptSource, /相机向柜体靠近/);
assert.match(promptSource, /柜体主体约占纯场景画面横向宽度的80%至90%/);
assert.match(promptSource, /侧板可见性只能来自相机视差/);
assert.match(promptSource, /柜体背板与墙面保持平行并完整贴墙/);
assert.match(promptSource, /柜体正面长边、顶板长边和底座长边与墙脚线保持平行/);
assert.match(promptSource, /左右两端到墙面的距离必须一致/);
assert.match(promptSource, /placement: "保持已确认的靠墙位置/);
assert.match(promptSource, /placementPlanForPerspective/);
assert.match(promptSource, /candidates: \[\]/);
assert.match(promptSource, /当前任务是参考重建，不是编辑原场景照片/);
assert.match(promptSource, /禁止把场景参考图当作编辑底图/);
assert.match(promptSource, /近景质检不得要求画面出现完整柜体/);
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
assert.match(proxySource, /const requested = \[body\.settings\?\.perspectives\?\.\[0\] \|\| "wide"\]/);
assert.match(localServerSource, /const requested = \[body\.settings\?\.perspectives\?\.\[0\] \|\| "wide"\]/);
assert.match(proxySource, /for \(const perspective of requested\)/);
assert.match(localServerSource, /for \(const perspective of requested\)/);
assert.match(proxySource, /model: usedModel, api: usedApi/);
assert.match(localServerSource, /model: usedModel, api: usedApi/);
assert.match(proxySource, /\[image-generation-success\]/);
assert.match(localServerSource, /\[image-generation-success\]/);
assert.match(localServerSource, /trial-runtime\.log/);
assert.match(proxySource, /promptFingerprint/);
assert.match(localServerSource, /promptFingerprint/);
assert.match(proxySource, /productReference: Boolean\(body\.productReferenceImage\?\.base64\)/);
assert.match(localServerSource, /productReference: Boolean\(body\.productReferenceImage\?\.base64\)/);
assert.doesNotMatch(proxySource, /请先生成锁定布局的远景主图/);
assert.doesNotMatch(localServerSource, /请先生成锁定布局的远景主图/);
assert.match(proxySource, /只输出当前指定视角的最终效果图，不要改成其他视角/);
assert.match(localServerSource, /只输出当前指定视角的最终效果图，不要改成其他视角/);
assert.match(geminiSource, /async function generatePerspectiveBatch/);
assert.match(geminiSource, /perspective === "medium"/);
assert.match(geminiSource, /createLockedProductForeground\(productReferenceImage\)/);
assert.match(geminiSource, /composeLockedProductScene\(/);
assert.match(geminiSource, /buildLockedSideScenePrompt/);
assert.match(geminiSource, /viewpoint: readableText/);
assert.ok(
  (geminiSource.match(/const requestedPerspective = settings\.perspectives\[0\] \|\| "wide"/g) || []).length >= 2,
  "场景试摆和虚拟空间服务都必须只读取第一个视角"
);
assert.match(geminiSource, /const roomAsReference = perspective !== "wide"/);
assert.doesNotMatch(
  geminiSource,
  /:\s*\{ roomImage, roomReferenceImages, beddingImage \}/,
  "远景生成不得重复发送体积不可控的透明柜体前景"
);
assert.match(geminiSource, /:\s*\{ roomImage, roomReferenceImages \}/);
assert.match(geminiSource, /response\.status === 413/);
assert.match(geminiSource, /roomReferenceImages: referenceImages/);
assert.doesNotMatch(geminiSource, /wide-scale-anchor\.jpg/);
assert.match(promptSource, /低清尺度缩略图/);
assert.match(promptSource, /远景尺度缩略图不是编辑底图，也不是产品结构依据/);
assert.match(promptSource, /原始产品图是唯一高清产品结构依据/);
assert.match(promptSource, /清楚看到正面和一侧侧板/);
assert.doesNotMatch(promptSource, /相同的相机高度、焦距、拍摄距离和柜体垂直画面占比/);
assert.match(geminiSource, /不得沿用原场景相机机位/);
assert.match(geminiSource, /perspectives: \[perspective\]/);
assert.match(geminiSource, /perspectivePrompts: \{\s*\[perspective\]: buildGenerationPrompt/);
assert.match(geminiSource, /perspectivePrompts: \{\s*\[perspective\]: buildVirtualRoomPrompt/);
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
assert.match(componentSource, /clarity: settings\.clarity === "4K" \? "2K" : settings\.clarity/);
assert.match(componentSource, /selectedPerspective === "medium"\s*\? await createLockedProductForeground\(furnitureImage\)/);
assert.match(componentSource, /productImage: lockedSideProduct \|\| furnitureForegroundImage \|\| furnitureImage/);

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

const whiteShadowPixels = makePixels(width, height, (x, y) => {
  if (x >= 2 && x <= 7 && y >= 2 && y <= 9) return [72, 61, 54, 255];
  if (x >= 8 && x <= 10 && y >= 8 && y <= 10) return [164, 162, 159, 255];
  return [250, 250, 250, 255];
});
const whiteShadowResult = removeConnectedStudioBackground(whiteShadowPixels, width, height);
assert.equal(whiteShadowResult.pixels[((9 * width + 9) * 4) + 3], 0, "白底相连的中性灰棚拍投影必须移除");
assert.equal(whiteShadowResult.pixels[((5 * width + 5) * 4) + 3], 255, "深色柜体像素不能被白底投影清理损伤");

console.log("Regression checks passed.");
