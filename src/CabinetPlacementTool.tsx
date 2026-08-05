import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  Download,
  Loader2,
  Maximize2,
  PenLine,
  RefreshCcw,
  Send,
  Settings2,
  Sparkles,
  UploadCloud,
  Wand2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultSettings, perspectiveLabels, TOOL_COST, TOOL_NAME, virtualRoomStyleLabels } from "./constants";
import styles from "./CabinetPlacementTool.module.css";
import { analyzeScene, analyzeVirtualFurniture, erasePlannedFurniture, extractFurnitureForeground, generatePlacementImages, generateVirtualRoomImages } from "./services/gemini";
import { compressDataUrlToBlob, compressImage, GEMINI_IMAGE_TARGET_BYTES, GEMINI_PRODUCT_TARGET_BYTES } from "./services/image";
import { composeCabinetPoster } from "./services/poster";
import {
  consumeIntegral,
  createInitialPlatformContext,
  isInsufficientIntegralError,
  launchTool,
  mergeSaasInit,
  persistResultImage,
  type PlatformContext,
  verifyIntegral
} from "./services/platform";
import type {
  GeneratedImageResult,
  ImageRatio,
  PlacementSettings,
  SceneAnalysis,
  SaasInitPayload,
  ToolMode,
  TrialPlacementPlan,
  UploadedImage,
  VirtualRoomStyle
} from "./types";

type GuidedStep = "room" | "furniture" | "review" | "generating" | "result";

type ChatMessage = {
  role: "assistant" | "user";
  text: string;
  image?: UploadedImage;
};

function userFacingError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/not available in your current location|available-regions|当前调用地区不可用/i.test(message)) {
    return "Gemini API 当前调用地区不可用：请将后端服务部署在 Gemini API 支持的国家或地区，或改用 Google Cloud 的企业平台 Gemini API。";
  }
  if (/project has been denied access|denied access|permission denied/i.test(message)) {
    return "Gemini 项目访问被拒绝：请在 Google AI Studio 或 Google Cloud 为当前 API Key 所属项目开通模型访问权限后重试。";
  }
  return message || fallback;
}

const initialChatMessages: ChatMessage[] = [
  { role: "assistant", text: "您好，我是您的 AI 柜类试摆助手。" },
  { role: "assistant", text: "我可以把您上传的书柜、斗柜或其他柜类自然摆放到家居空间，并自动完成书籍饰品和完整海报。要开始摆放吗？" }
];

const ratioClass: Record<ImageRatio, string> = {
  "1:1": styles.ratioSquare,
  "3:4": styles.ratioPortrait,
  "4:3": styles.ratioClassic,
  "16:9": styles.ratioWide
};

const stepMeta: Array<{ key: GuidedStep; label: string }> = [
  { key: "room", label: "上传空间" },
  { key: "furniture", label: "上传柜体" },
  { key: "review", label: "确认方案" },
  { key: "generating", label: "AI 生成" },
  { key: "result", label: "查看结果" }
];

export function CabinetPlacementTool() {
  const [platform, setPlatform] = useState<PlatformContext>(() => createInitialPlatformContext());
  const [mode, setMode] = useState<ToolMode>("agent");
  const [guidedStep, setGuidedStep] = useState<GuidedStep>("room");
  const [roomImage, setRoomImage] = useState<UploadedImage | null>(null);
  const [useVirtualRoom, setUseVirtualRoom] = useState(false);
  const [furnitureImage, setFurnitureImage] = useState<UploadedImage | null>(null);
  const [furnitureForegroundImage, setFurnitureForegroundImage] = useState<UploadedImage | null>(null);
  const [clearedRoomImage, setClearedRoomImage] = useState<UploadedImage | null>(null);
  const [settings, setSettings] = useState<PlacementSettings>(defaultSettings);
  const [analysis, setAnalysis] = useState<SceneAnalysis | null>(null);
  const [results, setResults] = useState<GeneratedImageResult[]>([]);
  const [selectedResult, setSelectedResult] = useState(0);
  const [integral, setIntegral] = useState(0);
  const [toolCost, setToolCost] = useState(TOOL_COST);
  const [status, setStatus] = useState("准备就绪，请上传场景照片开始摆放");
  const [error, setError] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);
  const [isAnalyzingRoom, setIsAnalyzingRoom] = useState(false);
  const [isAnalyzingFurniture, setIsAnalyzingFurniture] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAnalysisEditor, setShowAnalysisEditor] = useState(false);
  const [reviewSubstep, setReviewSubstep] = useState<"plan" | "settings">("plan");
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialChatMessages);
  const [agentFlowStarted, setAgentFlowStarted] = useState(false);

  const isStandaloneTrial = platform.userId === "demo-user" && platform.toolId === "cabinet-placement";
  const currentResult = results[selectedResult];

  useEffect(() => {
    const handleMessage = (event: MessageEvent<SaasInitPayload>) => {
      if (event.data?.type === "SAAS_INIT") {
        setPlatform((current) => mergeSaasInit(current, event.data));
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    let active = true;
    if (isStandaloneTrial) {
      setIntegral(TOOL_COST * 9);
      setToolCost(TOOL_COST);
      setIsLaunching(false);
      return () => {
        active = false;
      };
    }

    setIsLaunching(true);
    launchTool(platform)
      .then((state) => {
        if (!active) return;
        setIntegral(state.user.integral);
        setToolCost(state.tool.integral);
      })
      .catch(() => active && setStatus("暂时无法读取积分信息，请刷新后重试"))
      .finally(() => active && setIsLaunching(false));

    return () => {
      active = false;
    };
  }, [platform.userId, platform.toolId, platform.launchUrl, isStandaloneTrial]);

  const guideCopy = useMemo(() => {
    if (guidedStep === "room") {
      return {
        eyebrow: "第 1 步",
        title: "先选择空间来源",
        desc: "可以上传客户场景照片，也可以跳过空间，直接生成指定风格的虚拟空间。",
        hint: "上传真实空间会进入原摆放流程；虚拟空间只需要柜体图和装修风格。"
      };
    }
    if (guidedStep === "furniture") {
      return {
        eyebrow: "第 2 步",
        title: "现在上传柜体产品图",
        desc: useVirtualRoom ? "柜体上传后会直接准备虚拟空间方案。" : "柜体上传后会自动分析款式、材质和适合的摆放方式。",
        hint: "建议柜体主体完整，正面或 45 度角，背景尽量简单。"
      };
    }
    if (guidedStep === "review") {
      return {
        eyebrow: "第 3 步",
        title: "确认摆放方案",
        desc: "我已经整理好空间、柜体和陈设分析。确认方案、海报信息与生成视角后即可生成。",
        hint: "高级设置已折叠，默认参数适合先快速看效果。"
      };
    }
    if (guidedStep === "generating") {
      return {
        eyebrow: "第 4 步",
        title: "正在生成摆放效果",
        desc: "我会按已确认的方案生成图片，完成后自动进入结果页。",
        hint: "当前只生成所选的一个视角并排版为完整海报，请保持页面打开。"
      };
    }
    return {
      eyebrow: "完成",
        title: "查看家居海报",
        desc: "查看本次所选视角的 1080 × 1440 海报，也可以下载、调整要求或重新生成。",
        hint: "如需更换视角或调整摆放与陈设，返回生成设置后重新生成。"
    };
  }, [guidedStep, useVirtualRoom]);

  function addChatMessage(message: ChatMessage) {
    setChatMessages((current) => [...current, message]);
  }

  function submitChatNote() {
    const note = chatDraft.trim();
    if (!note) return;
    setChatDraft("");
    addChatMessage({ role: "user", text: note });

    if (/^(你好|嗨|hi|hello)/i.test(note)) {
      addChatMessage({ role: "assistant", text: "你好，很高兴帮您做柜体摆放。您可以问我能做什么，或直接说“开始摆放”。" });
      return;
    }

    if (/(能做什么|可以干嘛|做什么|功能|怎么用)/.test(note)) {
      addChatMessage({ role: "assistant", text: "我能根据一张场景照片和一张柜体产品图，生成柜体在空间里的真实摆放效果。流程是：上传空间，自动分析；上传柜体，自动匹配；确认方案后生成效果图。准备好后对我说“开始摆放”。" });
      return;
    }

    if (/(开始|摆放|上传.*空间|空间.*照片)/.test(note) && !roomImage) {
      setAgentFlowStarted(true);
      addChatMessage({ role: "assistant", text: "好的，我们开始。请先上传家居空间照片，我会自动分析空间、光线和透视关系。" });
      return;
    }

    if (!agentFlowStarted) {
      addChatMessage({ role: "assistant", text: "我可以先回答您的问题。准备生成摆放效果时，直接对我说“开始摆放”即可。" });
      return;
    }

    if (agentFlowStarted) {
      setSettings((current) => ({ ...current, notes: current.notes ? `${current.notes}\n${note}` : note }));
      addChatMessage({
        role: "assistant",
        text: guidedStep === "review"
          ? "收到，这条要求已加入摆放方案。您可以继续补充，或点击下方按钮生成效果图。"
          : "收到，我已记下这条摆放要求，后续会与空间和柜体产品图一起用于合成。"
      });
      return;
    }
  }

  function startVirtualRoomFlow() {
    const styleLabel = virtualRoomStyleLabels[settings.virtualRoomStyle];
    setError("");
    setUseVirtualRoom(true);
    setAgentFlowStarted(true);
    setRoomImage(null);
    setFurnitureImage(null);
    setFurnitureForegroundImage(null);
    setClearedRoomImage(null);
    setAnalysis(null);
    setResults([]);
    setReviewSubstep("plan");
    setGuidedStep("furniture");
    setStatus(`已选择 ${styleLabel} 虚拟空间，请上传柜体产品图`);
    addChatMessage({ role: "assistant", text: `已切换为 ${styleLabel} 虚拟空间模式。请上传柜体产品图，后续会直接生成虚拟空间效果图。` });
  }

  async function handleUpload(kind: "room" | "furniture", file?: File) {
    if (!file) return;
    setError("");
    setStatus("正在压缩图片...");
    try {
      const image = await compressImage(
        file,
        kind === "furniture" ? 1800 : undefined,
        kind === "furniture" ? 0.82 : undefined,
        kind === "furniture" ? GEMINI_PRODUCT_TARGET_BYTES : GEMINI_IMAGE_TARGET_BYTES
      );
      setResults([]);
      if (kind === "room") {
        setUseVirtualRoom(false);
        setAgentFlowStarted(true);
        setRoomImage(image);
        setFurnitureImage(null);
        setFurnitureForegroundImage(null);
        setClearedRoomImage(null);
        setAnalysis(null);
        setReviewSubstep("plan");
        setGuidedStep("room");
        addChatMessage({ role: "user", text: "已上传场景照片", image });
        addChatMessage({ role: "assistant", text: "场景照片已收到，我正在分析空间尺度、光线和透视关系。" });
        await autoAnalyzeRoom(image);
      } else {
        setFurnitureImage(image);
        setFurnitureForegroundImage(null);
        setClearedRoomImage(null);
        addChatMessage({ role: "user", text: "已上传柜体产品图", image });
        addChatMessage({ role: "assistant", text: "柜体产品图已收到，我正在识别款式、材质、颜色和比例。" });
        await autoAnalyzeFurniture(image);
      }
    } catch (err) {
      setError(userFacingError(err, "上传失败"));
      setStatus("");
    }
  }

  async function autoAnalyzeRoom(nextRoomImage: UploadedImage) {
    setIsAnalyzingRoom(true);
    setStatus("正在自动解析空间...");
    try {
      if (!isStandaloneTrial) {
        await verifyIntegral(platform);
      }
      const nextAnalysis = await analyzeScene(nextRoomImage, null, [], settings.model, platform.context, platform.prompt, settings.notes);
      setAnalysis({
        ...nextAnalysis,
        furnitureSummary: "等待上传柜体产品图后补充柜体分析。"
      });
      setGuidedStep("furniture");
      setStatus("空间解析完成，请上传柜体产品图");
      addChatMessage({ role: "assistant", text: "空间解析完成。现在请上传要摆放的柜体产品图，建议选择正面或 45 度角、主体完整的图片。" });
    } catch (err) {
      if (isInsufficientIntegralError(err)) {
        const message = userFacingError(err, "积分不足，无法开始图片分析");
        setError(message);
        setStatus(message);
        setGuidedStep("room");
        addChatMessage({ role: "assistant", text: `${message}。请补充积分后再开始图片分析。` });
        return;
      }
      setError(userFacingError(err, "空间解析失败"));
      setStatus("空间解析失败，您仍可继续上传柜体后重试");
      setGuidedStep("furniture");
      addChatMessage({ role: "assistant", text: "场景分析暂时没有完成，但我们仍可继续。请上传柜体产品图，我会在生成时重新匹配。" });
    } finally {
      setIsAnalyzingRoom(false);
    }
  }

  async function autoAnalyzeFurniture(nextFurnitureImage: UploadedImage) {
    if (useVirtualRoom) {
      const styleLabel = virtualRoomStyleLabels[settings.virtualRoomStyle];
      setIsAnalyzingFurniture(true);
      setStatus("正在识别柜体并准备虚拟空间方案...");
      try {
        if (!isStandaloneTrial) {
          await verifyIntegral(platform);
        }
        const nextAnalysis = await analyzeVirtualFurniture(
          nextFurnitureImage,
          settings.model,
          styleLabel,
          platform.context,
          platform.prompt,
          settings.notes
        );
        const foreground = await extractFurnitureForeground(nextFurnitureImage, settings);
        setAnalysis(nextAnalysis);
        setFurnitureForegroundImage(foreground);
        setClearedRoomImage(null);
        setReviewSubstep("plan");
        setGuidedStep("review");
        setStatus("虚拟空间方案已准备好，请确认风格与海报信息");
        addChatMessage({ role: "assistant", text: `已准备 ${styleLabel} 虚拟空间方案。确认人物与海报信息后即可生成，生成前会校验积分。` });
      } catch (err) {
        setError(userFacingError(err, "虚拟空间方案准备失败"));
        setStatus("");
      } finally {
        setIsAnalyzingFurniture(false);
      }
      return;
    }

    if (!roomImage) {
      setError("请先上传场景照片");
      return;
    }

    setIsAnalyzingFurniture(true);
    setStatus("正在自动解析柜体并合并摆放建议...");
    try {
      if (!isStandaloneTrial) {
        await verifyIntegral(platform);
      }
      const nextAnalysis = await analyzeScene(roomImage, nextFurnitureImage, [], settings.model, platform.context, platform.prompt, settings.notes);
      setAnalysis(nextAnalysis);
      setStatus("正在提取并核验柜体前景...");
      const foreground = await extractFurnitureForeground(nextFurnitureImage, settings);
      setFurnitureForegroundImage(foreground);
      setStatus("正在按 AI 建议准备摆放底图...");
      const clearedRoom = await erasePlannedFurniture(roomImage, nextAnalysis, settings);
      setClearedRoomImage(clearedRoom);
      setReviewSubstep("plan");
      setGuidedStep("review");
      setStatus("柜体前景和干净场景已锁定，请确认摆放方案");
      addChatMessage({ role: "assistant", text: `已完成柜体前景提取和摆放底图准备。我的建议是：${nextAnalysis.placementAdvice}。请在下方确认方案，或直接告诉我您想调整的位置和陈设。` });
    } catch (err) {
      if (isInsufficientIntegralError(err)) {
        const message = userFacingError(err, "积分不足，无法分析柜体");
        setError(message);
        setStatus(message);
        setFurnitureForegroundImage(null);
        setClearedRoomImage(null);
        addChatMessage({ role: "assistant", text: `${message}。请补充积分后再继续图片分析。` });
        return;
      }
      setError(userFacingError(err, "柜体解析失败"));
      setFurnitureForegroundImage(null);
      setClearedRoomImage(null);
      setStatus("柜体前景或场景清场失败，请重新上传或重试；系统不会使用原图继续摆放");
      addChatMessage({ role: "assistant", text: "柜体前景提取或原场景清场没有完成。为避免生成出错误柜体或不同空间，系统已停止后续摆放，请重新上传清晰图片后重试。" });
    } finally {
      setIsAnalyzingFurniture(false);
    }
  }

  async function handleGenerate() {
    if (!furnitureImage || !analysis || (!useVirtualRoom && (!roomImage || !furnitureForegroundImage || !clearedRoomImage))) {
      setError("请先完成空间和柜体上传");
      return;
    }

    setError("");
    setIsGenerating(true);
    setGuidedStep("generating");
    setStatus("正在生成摆放效果图...");
    addChatMessage({ role: "assistant", text: useVirtualRoom ? "方案已确认，正在生成虚拟空间效果图。我会保留柜体产品特征，并匹配装修风格、光照和空间尺度。" : "方案已确认，正在生成摆放效果图。我会匹配柜体尺度、空间透视、光照和地面阴影。" });
    try {
      if (!isStandaloneTrial) {
        await verifyIntegral(platform);
      }
      const selectedPerspective = settings.perspectives[0] || "wide";
      let generationSettings: PlacementSettings = {
        ...settings,
        perspectives: [selectedPerspective],
        clarity: settings.clarity === "4K" ? "2K" : settings.clarity
      };

      const generateScenes = (activeSettings: PlacementSettings) => useVirtualRoom
        ? generateVirtualRoomImages(furnitureImage, analysis, activeSettings, platform.context, platform.prompt)
        : generatePlacementImages(clearedRoomImage as UploadedImage, furnitureImage, [], analysis, activeSettings, platform.context, platform.prompt);

      let generationBatch = await generateScenes(generationSettings);
      let images = generationBatch.images;
      let generationFailures = generationBatch.failures;
      if (!images.length) {
        throw new Error(generationFailures.map((failure) => `${failure.perspective}：${failure.message}`).join("；") || "所选视角未生成成功");
      }
      generationSettings = { ...generationSettings, perspectives: images.map((image) => image.perspective) };
      setStatus("场景主图已生成，正在排版 3:4 家居海报...");
      const generated: GeneratedImageResult[] = await Promise.all(images.map(async (item, index) => ({
        id: `${Date.now()}-${index}`,
        perspective: item.perspective,
        title: `${item.title}海报`,
        imageUrl: await composeCabinetPoster({
          sceneImageUrl: item.imageUrl,
          productImage: furnitureForegroundImage || furnitureImage,
          copy: analysis.posterCopy,
          seriesName: generationSettings.seriesName,
          productName: generationSettings.productName,
          price: generationSettings.price
        }),
        sceneImageUrl: item.imageUrl,
        uploadStatus: isStandaloneTrial ? "skipped" : "pending"
      })));

      if (!isStandaloneTrial) {
        const currentIntegral = await consumeIntegral(platform);
        if (typeof currentIntegral === "number") setIntegral(currentIntegral);
      } else {
        setIntegral((value) => Math.max(0, value - toolCost));
      }

      setResults(generated);
      setSelectedResult(0);
      setGuidedStep("result");
      setStatus("已生成 1 张所选视角的 3:4 家居海报");
      addChatMessage({ role: "assistant", text: "已生成所选视角的完整家居海报。您可以下载，或返回更换视角、调整要求后重新生成。" });

      if (!isStandaloneTrial) {
        await uploadGeneratedResults(generated);
      }
    } catch (err) {
      if (isInsufficientIntegralError(err)) {
        const message = userFacingError(err, "积分不足，无法生成效果图");
        setError(message);
        setGuidedStep("review");
        setReviewSubstep("settings");
        setStatus(message);
        addChatMessage({ role: "assistant", text: `${message}。本次没有开始生成，也不会扣除积分。` });
        return;
      }
      setError(userFacingError(err, "生成失败"));
      setGuidedStep("review");
      setReviewSubstep("settings");
      setStatus("生成失败，请调整方案后重试");
    } finally {
      setIsGenerating(false);
    }
  }

  async function uploadGeneratedResults(generated: GeneratedImageResult[]) {
    setStatus("生成完成，正在保存结果图...");
    const settled = await Promise.all(generated.map(async (item, index) => {
      try {
        const blob = await compressDataUrlToBlob(item.imageUrl);
        const saved = await persistResultImage(platform, blob, `${item.perspective}-${Date.now()}-${index + 1}.jpg`);
        setResults((current) => current.map((result) => result.id === item.id ? {
          ...result,
          savedUrl: saved.savedUrl,
          recordId: saved.recordId,
          uploadStatus: "saved"
        } : result));
        return { ok: true };
      } catch (err) {
        setResults((current) => current.map((result) => result.id === item.id ? {
          ...result,
          uploadStatus: "failed"
        } : result));
        return { ok: false, message: userFacingError(err, "结果图保存失败") };
      }
    }));

    const failed = settled.filter((item) => !item.ok);
    setStatus(failed.length
      ? `生成已完成，但有 ${failed.length} 张结果图保存失败，请稍后重试或下载保存`
      : "生成已完成，结果图已保存到我的图片");
  }

  function updateAnalysisField<K extends keyof SceneAnalysis>(field: K, value: SceneAnalysis[K]) {
    if (!analysis) return;
    setAnalysis({ ...analysis, [field]: value });
  }

  function updatePlacementPlanField<K extends keyof TrialPlacementPlan>(field: K, value: TrialPlacementPlan[K]) {
    if (!analysis) return;
    setAnalysis({ ...analysis, placementPlan: { ...analysis.placementPlan, [field]: value } });
  }

  function updateSettings(nextSettings: PlacementSettings) {
    setSettings(nextSettings);
  }

  function selectPerspective(value: PlacementSettings["perspectives"][number]) {
    setSettings((current) => ({ ...current, perspectives: [value] }));
  }

  async function refreshPlacementPlan() {
    if (!furnitureImage) return;
    await autoAnalyzeFurniture(furnitureImage);
  }

  function canVisitStep(step: GuidedStep) {
    if (step === "room") return !isGenerating;
    if (step === "furniture") return !isGenerating && (useVirtualRoom || Boolean(roomImage));
    if (step === "review") return !isGenerating && Boolean(analysis);
    if (step === "result") return !isGenerating && results.length > 0;
    return false;
  }

  function goToStep(step: GuidedStep) {
    if (!canVisitStep(step)) return;
    setError("");
    if (step === "review") {
      setReviewSubstep("settings");
    }
    setGuidedStep(step);
    setStatus(step === "furniture" ? "可查看或重新上传柜体产品图，已有结果会保留到重新上传或重新生成为止" : "");
  }

  function resetFlow() {
    setGuidedStep("room");
    setReviewSubstep("plan");
    setUseVirtualRoom(false);
    setRoomImage(null);
    setFurnitureImage(null);
    setFurnitureForegroundImage(null);
    setClearedRoomImage(null);
    setAnalysis(null);
    setResults([]);
    setAgentFlowStarted(false);
    setChatMessages(initialChatMessages);
    setError("");
    setStatus("准备就绪，请上传场景照片开始摆放");
  }

  const currentStepContent = (
    <>
      {guidedStep === "room" && (
        <div className={styles.roomEntryLayout}>
          <UploadStep
            kind="room"
            image={roomImage}
            busy={isAnalyzingRoom}
            title="上传场景照片"
            description="上传后自动解析空间，不需要手动点击下一步。"
            onFile={(file) => handleUpload("room", file)}
          />
          <VirtualRoomStarter
            selectedStyle={settings.virtualRoomStyle}
            onStyleChange={(virtualRoomStyle) => setSettings((current) => ({ ...current, virtualRoomStyle }))}
            onStart={startVirtualRoomFlow}
          />
        </div>
      )}

      {guidedStep === "furniture" && (
        <div className={styles.focusLayout}>
          {useVirtualRoom ? (
            <VirtualRoomSummary selectedStyle={settings.virtualRoomStyle} />
          ) : (
            <PreviewCard title="空间已解析" image={roomImage} loading={isAnalyzingRoom} />
          )}
          <UploadStep
            kind="furniture"
            image={furnitureImage}
            busy={isAnalyzingFurniture}
            title="上传柜体产品图"
            description="上传后自动合并空间和柜体分析，生成摆放建议。"
            onFile={(file) => handleUpload("furniture", file)}
          />
        </div>
      )}

      {guidedStep === "review" && analysis && (
        <ReviewStep
          analysis={analysis}
          furnitureForegroundImage={furnitureForegroundImage}
          settings={settings}
          useVirtualRoom={useVirtualRoom}
          substep={reviewSubstep}
          showAnalysisEditor={showAnalysisEditor}
            onToggleAnalysis={() => setShowAnalysisEditor((value) => !value)}
            onAnalysisChange={updateAnalysisField}
            onPlanChange={updatePlacementPlanField}
            onRefreshPlan={refreshPlacementPlan}
            onSettingsChange={updateSettings}
            onPerspectiveSelect={selectPerspective}
          onConfirmPlan={() => setReviewSubstep("settings")}
          onBackToPlan={() => setReviewSubstep("plan")}
          onGenerate={handleGenerate}
          isGenerating={isGenerating}
          isRefreshingPlan={isAnalyzingFurniture}
        />
      )}

      {guidedStep === "generating" && (
        <section className={styles.generatingCard}>
          <Loader2 className={styles.spin} size={42} />
          <h3>正在生成柜体摆放效果</h3>
          <p>我正在匹配空间透视、柜体尺度、光照和地面阴影。完成后会自动进入结果页。</p>
        </section>
      )}

      {guidedStep === "result" && currentResult && (
        <ResultStep
          roomImage={roomImage}
          furnitureImage={furnitureImage}
          useVirtualRoom={useVirtualRoom}
          result={currentResult}
          results={results}
          selectedResult={selectedResult}
          ratio="3:4"
          onSelectResult={setSelectedResult}
          onBack={() => { setReviewSubstep("settings"); setGuidedStep("review"); }}
          onBackToFurniture={() => goToStep("furniture")}
          onRegenerate={handleGenerate}
          isGenerating={isGenerating}
        />
      )}
    </>
  );

  return (
    <main className={`${styles.toolShell} ${mode === "expert" && guidedStep === "generating" ? styles.generatingShell : ""}`}>
      <header className={styles.toolHeader}>
        <div className={styles.brandBlock}>
          <div className={styles.logoMark}>
            <Sparkles size={22} />
          </div>
          <div>
            <h1>{TOOL_NAME}</h1>
            <p>上传素材、确认 AI 方案、生成完整家居海报</p>
          </div>
        </div>

        <div className={styles.headerActions}>
          <div className={styles.modeSwitch}>
            <button className={mode === "agent" ? styles.activeMode : ""} onClick={() => setMode("agent")}>
              <Bot size={16} />
              智能体聊天
            </button>
            <button className={mode === "expert" ? styles.activeMode : ""} onClick={() => setMode("expert")}>
              <Settings2 size={16} />
              工作台模式
            </button>
          </div>
          <div className={styles.integralPill}>
            <Sparkles size={16} />
            {isLaunching ? "积分读取中" : `积分: ${integral}`}
          </div>
        </div>
      </header>

      {mode === "agent" ? (
        <ChatWorkspace
          messages={chatMessages}
          stepContent={agentFlowStarted ? currentStepContent : null}
          draft={chatDraft}
          status={isAnalyzingRoom || isAnalyzingFurniture || isGenerating ? status : ""}
          error={error}
          onDraftChange={setChatDraft}
          onSend={submitChatNote}
          onReset={resetFlow}
        />
      ) : (
        <section className={`${styles.workbenchFrame} ${guidedStep === "result" ? styles.resultWorkbenchFrame : ""}`}>
          <aside className={styles.workbenchSidebar}>
            <div className={styles.sidebarIntro}>
              <span>{guideCopy.eyebrow}</span>
              <strong>摆放流程</strong>
            </div>
            <nav className={styles.sideProgress} aria-label="摆放步骤">
              {stepMeta.map((item, index) => {
                const activeIndex = stepMeta.findIndex((step) => step.key === guidedStep);
                const isDone = index < activeIndex;
                const isActive = item.key === guidedStep;
                const canVisit = canVisitStep(item.key);
                return (
                  <button
                    className={`${styles.sideProgressItem} ${isActive ? styles.currentProgress : ""} ${isDone ? styles.doneProgress : ""}`}
                    key={item.key}
                    onClick={() => goToStep(item.key)}
                    disabled={!canVisit || isActive}
                    title={canVisit && !isActive ? `返回${item.label}` : item.label}
                  >
                    <span>{isDone ? <CheckCircle2 size={16} /> : index + 1}</span>
                    <b>{item.label}</b>
                  </button>
                );
              })}
            </nav>
            <button className={styles.secondaryButton} onClick={resetFlow}>
              <RefreshCcw size={16} />
              重新开始
            </button>
          </aside>

          <section className={styles.workbenchMain}>
            <section className={styles.flowHeader}>
              <div>
                <h2>{guideCopy.title}</h2>
                <p>{guideCopy.desc}</p>
              </div>
            </section>

            <section className={styles.statusBar}>
              <span>{guideCopy.hint}</span>
              {status && <strong>{status}</strong>}
              {error && <strong className={styles.errorText}>{error}</strong>}
            </section>

            <section className={styles.workbenchStage}>{currentStepContent}</section>
          </section>

        </section>
      )}
    </main>
  );
}

function ChatWorkspace({
  messages,
  stepContent,
  draft,
  status,
  error,
  onDraftChange,
  onSend,
  onReset
}: {
  messages: ChatMessage[];
  stepContent: ReactNode;
  draft: string;
  status: string;
  error: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onReset: () => void;
}) {
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, stepContent]);

  return (
    <section className={styles.chatWorkspace}>
      <header className={styles.chatWorkspaceHeader}>
        <div className={styles.chatAgentIdentity}>
          <span className={styles.chatAvatar}><Bot size={19} /></span>
          <div>
            <strong>AI 柜类试摆助手</strong>
            <small>正在为您提供一对一摆放服务</small>
          </div>
        </div>
        <button className={styles.secondaryButton} onClick={onReset}>
          <RefreshCcw size={16} />
          重置对话
        </button>
      </header>

      <div className={styles.chatConversation}>
        {messages.map((message, index) => (
          message.role === "assistant" ? (
            <div className={styles.assistantMessage} key={`${message.text}-${index}`}>
              <span className={styles.messageAvatar}><Bot size={16} /></span>
              <p>{message.text}</p>
            </div>
          ) : (
            <div className={styles.userMessage} key={`${message.text}-${index}`}>
              <div className={styles.userBubble}>
                {message.image && <img src={message.image.dataUrl} alt={message.text} />}
                <p>{message.text}</p>
              </div>
            </div>
          )
        ))}
        {stepContent && <div className={styles.chatTask}>{stepContent}</div>}
        {(status || error) && (
          <div className={`${styles.chatStatus} ${error ? styles.errorText : ""}`}>
            {error || status}
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <footer className={styles.chatComposer}>
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="补充任何要求，例如：朝向壁炉、替换旧柜体、保留地毯、留出通道…"
        />
        <button className={styles.sendButton} onClick={onSend} aria-label="发送摆放要求" disabled={!draft.trim()}>
          <Send size={19} />
        </button>
      </footer>
    </section>
  );
}

function VirtualRoomStarter({
  selectedStyle,
  onStyleChange,
  onStart
}: {
  selectedStyle: VirtualRoomStyle;
  onStyleChange: (style: VirtualRoomStyle) => void;
  onStart: () => void;
}) {
  return (
    <section className={styles.virtualRoomPanel}>
      <div className={styles.virtualRoomHeader}>
        <Wand2 size={20} />
        <div>
          <strong>跳过空间，生成虚拟空间</strong>
          <span>选择装修风格后，只上传柜体即可生成虚拟空间效果。</span>
        </div>
      </div>
      <div className={styles.choiceGrid}>
        {Object.entries(virtualRoomStyleLabels).map(([value, label]) => (
          <button
            key={value}
            className={selectedStyle === value ? styles.selectedChoice : ""}
            onClick={() => onStyleChange(value as VirtualRoomStyle)}
            aria-pressed={selectedStyle === value}
          >
            {label}
          </button>
        ))}
      </div>
      <button className={styles.primaryButton} onClick={onStart}>
        <Sparkles size={18} />
        使用虚拟空间
      </button>
    </section>
  );
}

function VirtualRoomSummary({ selectedStyle }: { selectedStyle: VirtualRoomStyle }) {
  return (
    <section className={styles.virtualRoomPanel}>
      <div className={styles.virtualRoomHeader}>
        <Wand2 size={20} />
        <div>
          <strong>{virtualRoomStyleLabels[selectedStyle]}虚拟空间</strong>
          <span>已跳过真实空间上传。接下来上传柜体，AI 会生成同一虚拟空间的完整家居海报。</span>
        </div>
      </div>
    </section>
  );
}

function UploadStep({
  title,
  description,
  image,
  busy,
  onFile
}: {
  kind: "room" | "furniture";
  title: string;
  description: string;
  image: UploadedImage | null;
  busy: boolean;
  onFile: (file?: File) => void;
}) {
  return (
    <section className={styles.uploadHero}>
      <label className={styles.bigUploader}>
        <input type="file" accept="image/*" onChange={(event) => onFile(event.target.files?.[0])} />
        {image ? (
          <img src={image.dataUrl} alt={title} />
        ) : (
          <span>
            <UploadCloud size={44} />
            <strong>{title}</strong>
            <small>{description}</small>
            <em>支持 JPG、PNG、WebP，最大 20MB，上传后自动压缩</em>
          </span>
        )}
        {busy && (
          <div className={styles.busyOverlay}>
            <Loader2 className={styles.spin} size={30} />
            正在自动解析...
          </div>
        )}
      </label>
    </section>
  );
}

function PreviewCard({ title, image, loading }: { title: string; image: UploadedImage | null; loading?: boolean }) {
  return (
    <section className={styles.previewCard}>
      <h3>{title}</h3>
      {image ? <img src={image.dataUrl} alt={title} /> : <div className={styles.previewEmpty}>等待上传</div>}
      {loading && <p>解析中...</p>}
    </section>
  );
}

function ReviewStep({
  analysis,
  furnitureForegroundImage,
  settings,
  useVirtualRoom,
  substep,
  showAnalysisEditor,
  onToggleAnalysis,
  onAnalysisChange,
  onPlanChange,
  onRefreshPlan,
  onSettingsChange,
  onPerspectiveSelect,
  onConfirmPlan,
  onBackToPlan,
  onGenerate,
  isGenerating,
  isRefreshingPlan
}: {
  analysis: SceneAnalysis;
  furnitureForegroundImage: UploadedImage | null;
  settings: PlacementSettings;
  useVirtualRoom: boolean;
  substep: "plan" | "settings";
  showAnalysisEditor: boolean;
  onToggleAnalysis: () => void;
  onAnalysisChange: <K extends keyof SceneAnalysis>(field: K, value: SceneAnalysis[K]) => void;
  onPlanChange: <K extends keyof TrialPlacementPlan>(field: K, value: TrialPlacementPlan[K]) => void;
  onRefreshPlan: () => void;
  onSettingsChange: (settings: PlacementSettings) => void;
  onPerspectiveSelect: (value: PlacementSettings["perspectives"][number]) => void;
  onConfirmPlan: () => void;
  onBackToPlan: () => void;
  onGenerate: () => void;
  isGenerating: boolean;
  isRefreshingPlan: boolean;
}) {
  const chosenCandidate = analysis.placementPlan.candidates.find(
    (candidate) => candidate.id === analysis.placementPlan.selectedCandidateId
  );

  return (
    <section className={styles.reviewLayout}>
      <div className={styles.reviewPanel}>
        {substep === "plan" ? (
          <>
            <div className={styles.planOverview}>
              <div className={styles.aiSummary}>
                <div>
                  <Bot size={20} />
                  <strong>AI 已整理摆放建议</strong>
                </div>
                <p>{analysis.placementAdvice}</p>
                <ul>
                  <li>{analysis.lighting}</li>
                  <li>{analysis.perspective}</li>
                </ul>
              </div>

              <section className={styles.planCard}>
                <div className={styles.planHeader}>
                  <div>
                    <Bot size={18} />
                    <strong>AI 已理解的摆放方案</strong>
                  </div>
                  <span>确认后进入生成设置</span>
                </div>
                <p>{analysis.placementPlan.summary}</p>
                <div className={styles.stylingSummary}>
                  <Sparkles size={16} />
                  <span><strong>AI 陈设：</strong>{analysis.stylingPlan.summary}</span>
                </div>
                {chosenCandidate && (
                  <div className={styles.planDecision}>
                    <strong>已采用：{chosenCandidate.label}</strong>
                    <span>{chosenCandidate.reasons.join("；")}</span>
                  </div>
                )}
                <div className={styles.planActions}>
                  <button className={styles.secondaryButton} onClick={onRefreshPlan} disabled={isRefreshingPlan}>
                    {isRefreshingPlan ? <Loader2 className={styles.spin} size={16} /> : <RefreshCcw size={16} />}
                    按当前要求重新规划
                  </button>
                  {furnitureForegroundImage && <span>柜体前景已锁定</span>}
                </div>
                <div className={styles.planGrid}>
                  <PlanField label="摆放位置" value={analysis.placementPlan.placement} onChange={(value) => onPlanChange("placement", value)} />
                  <PlanField label="柜体朝向" value={analysis.placementPlan.facing} onChange={(value) => onPlanChange("facing", value)} />
                  <PlanField label="尺寸与比例" value={analysis.placementPlan.scale} onChange={(value) => onPlanChange("scale", value)} />
                  <PlanListField label="保留内容" value={analysis.placementPlan.preserve} onChange={(value) => onPlanChange("preserve", value)} />
                  <PlanListField label="移除或替换" value={analysis.placementPlan.remove} onChange={(value) => onPlanChange("remove", value)} />
                  <PlanListField label="需要避免" value={analysis.placementPlan.avoid} onChange={(value) => onPlanChange("avoid", value)} />
                </div>
              </section>
            </div>
            <button className={styles.primaryButton} onClick={onConfirmPlan}>
              <CheckCircle2 size={18} />
              确认方案，进入生成设置
            </button>
          </>
        ) : (
          <>
            <div className={styles.settingsHeader}>
              <div>
                <strong>生成设置</strong>
                <span>每个勾选视角都会生成一张完整的 1080 × 1440 家居海报</span>
              </div>
              <button className={styles.secondaryButton} onClick={onBackToPlan}>
                <ChevronLeft size={16} />
                返回方案
              </button>
            </div>

            <div className={styles.settingsGrid}>
              {useVirtualRoom && (
                <div className={styles.optionBlock}>
                  <div className={styles.optionHeading}>
                    <strong>虚拟空间风格</strong>
                    <span>影响空间装修和软装搭配</span>
                  </div>
                  <div className={styles.choiceGrid}>
                    {Object.entries(virtualRoomStyleLabels).map(([value, label]) => (
                      <button
                        key={value}
                        className={settings.virtualRoomStyle === value ? styles.selectedChoice : ""}
                        onClick={() => onSettingsChange({ ...settings, virtualRoomStyle: value as VirtualRoomStyle })}
                        aria-pressed={settings.virtualRoomStyle === value}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className={styles.optionBlock}>
                <div className={styles.optionHeading}>
                  <strong>海报信息</strong>
                  <span>选填；留空时使用 AI 文案，价格留空则不展示</span>
                </div>
                <div className={styles.posterFieldGrid}>
                  <label>
                    <span>系列名</span>
                    <input
                      value={settings.seriesName}
                      onChange={(event) => onSettingsChange({ ...settings, seriesName: event.target.value })}
                      placeholder={analysis.posterCopy.seriesName}
                    />
                  </label>
                  <label>
                    <span>产品名</span>
                    <input
                      value={settings.productName}
                      onChange={(event) => onSettingsChange({ ...settings, productName: event.target.value })}
                      placeholder={analysis.posterCopy.productName}
                    />
                  </label>
                  <label>
                    <span>价格</span>
                    <input
                      value={settings.price}
                      onChange={(event) => onSettingsChange({ ...settings, price: event.target.value.replace(/[^\d.]/g, "") })}
                      inputMode="decimal"
                      placeholder="留空不显示"
                    />
                  </label>
                </div>
              </div>

              <div className={styles.optionBlock}>
                <div className={styles.optionHeading}>
                  <strong>图片清晰度</strong>
                  <span>越高耗时越长</span>
                </div>
                <div className={styles.choiceGrid}>
                  {(["1K", "2K", "4K"] as const).map((clarity) => (
                    <button key={clarity} className={settings.clarity === clarity ? styles.selectedChoice : ""} onClick={() => onSettingsChange({ ...settings, clarity })} aria-pressed={settings.clarity === clarity}>
                      {clarity}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.optionBlock}>
                <div className={styles.optionHeading}>
                  <strong>生成视角</strong>
                  <span>单选；每次只生成一张完整海报</span>
                </div>
                <div className={styles.choiceGrid}>
                  {Object.entries(perspectiveLabels).map(([value, label]) => (
                    <button
                      key={value}
                      className={settings.perspectives.includes(value as PlacementSettings["perspectives"][number]) ? styles.selectedChoice : ""}
                      onClick={() => onPerspectiveSelect(value as PlacementSettings["perspectives"][number])}
                      aria-pressed={settings.perspectives.includes(value as PlacementSettings["perspectives"][number])}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.optionBlock}>
                <div className={styles.optionHeading}>
                  <strong>真人模特</strong>
                  <span>在目标柜体附近自然互动</span>
                </div>
                <label className={styles.toggleControl}>
                  <input type="checkbox" checked={settings.addHumanModel} onChange={(event) => onSettingsChange({ ...settings, addHumanModel: event.target.checked })} />
                  <span>添加真人模特</span>
                </label>
                {settings.addHumanModel && (
                  <div className={styles.modelOptions}>
                    <div>
                      <span>性别</span>
                      <div className={styles.choiceGrid}>
                        {([["any", "不限"], ["female", "女"], ["male", "男"]] as const).map(([value, label]) => (
                          <button key={value} className={settings.humanModelGender === value ? styles.selectedChoice : ""} onClick={() => onSettingsChange({ ...settings, humanModelGender: value })} aria-pressed={settings.humanModelGender === value}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span>年龄段</span>
                      <div className={styles.choiceGrid}>
                        {([["adult", "成人"], ["child", "儿童"], ["senior", "老年"]] as const).map(([value, label]) => (
                          <button key={value} className={settings.humanModelAge === value ? styles.selectedChoice : ""} onClick={() => onSettingsChange({ ...settings, humanModelAge: value })} aria-pressed={settings.humanModelAge === value}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <label className={styles.freeformField}>
                补充合成要求
                <textarea value={settings.notes} onChange={(event) => onSettingsChange({ ...settings, notes: event.target.value })} placeholder="例如：保留沙发和地毯；书柜靠完整墙面摆放；多放书、少放摆件；不要改变原有墙画" />
              </label>
            </div>

            <div className={styles.foldActions}>
              <button className={styles.secondaryButton} onClick={onToggleAnalysis}>
                <PenLine size={16} />
                {showAnalysisEditor ? "收起分析内容" : "编辑分析内容"}
              </button>
            </div>

            {showAnalysisEditor && (
              <div className={styles.analysisEditor}>
                <AnalysisField label="场景分析" value={analysis.roomSummary} onChange={(value) => onAnalysisChange("roomSummary", value)} />
                <AnalysisField label="柜体分析" value={analysis.furnitureSummary} onChange={(value) => onAnalysisChange("furnitureSummary", value)} />
                <AnalysisField label="光线判断" value={analysis.lighting} onChange={(value) => onAnalysisChange("lighting", value)} />
                <AnalysisField label="透视判断" value={analysis.perspective} onChange={(value) => onAnalysisChange("perspective", value)} />
                <AnalysisField label="摆放建议" value={analysis.placementAdvice} onChange={(value) => onAnalysisChange("placementAdvice", value)} />
              </div>
            )}

            <button className={styles.primaryButton} onClick={onGenerate} disabled={isGenerating}>
              {isGenerating ? <Loader2 className={styles.spin} size={18} /> : <Wand2 size={18} />}
              一键生成摆放效果
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function ResultStep({
  roomImage,
  furnitureImage,
  useVirtualRoom,
  result,
  results,
  selectedResult,
  ratio,
  onSelectResult,
  onBack,
  onBackToFurniture,
  onRegenerate,
  isGenerating
}: {
  roomImage: UploadedImage | null;
  furnitureImage: UploadedImage | null;
  useVirtualRoom: boolean;
  result: GeneratedImageResult;
  results: GeneratedImageResult[];
  selectedResult: number;
  ratio: ImageRatio;
  onSelectResult: (index: number) => void;
  onBack: () => void;
  onBackToFurniture: () => void;
  onRegenerate: () => void;
  isGenerating: boolean;
}) {
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [viewerImage, setViewerImage] = useState<"result" | "original" | "product">("result");
  const viewerImageSrc = viewerImage === "product" && furnitureImage
    ? furnitureImage.dataUrl
    : viewerImage === "original" && roomImage
      ? roomImage.dataUrl
      : result.imageUrl;
  const viewerImageAlt = viewerImage === "product" && furnitureImage
    ? "柜体产品图"
    : viewerImage === "original" && roomImage
      ? "原始空间图"
      : "生成效果图";

  return (
    <section className={styles.resultPage}>
      <p className={styles.resultSummary}>本次已生成所选视角的 3:4 家居海报</p>
      <div className={styles.resultTabs}>
        {results.map((item, index) => (
          <button key={item.id} className={selectedResult === index ? styles.selectedChoice : ""} onClick={() => onSelectResult(index)}>
            {item.title}
          </button>
        ))}
      </div>
      <button className={`${styles.resultImageButton} ${ratioClass[ratio]}`} onClick={() => { setViewerImage("result"); setIsViewerOpen(true); }}>
        <img src={result.imageUrl} alt="生成效果图，点击查看大图" />
        <span><Maximize2 size={18} /> 点击查看大图</span>
      </button>
      <div className={styles.resultActions}>
        <button className={styles.secondaryButton} onClick={onBack}>
          <ChevronLeft size={16} />
          返回调整
        </button>
        <button className={styles.secondaryButton} onClick={onBackToFurniture}>
          <UploadCloud size={16} />
          重新上传柜体
        </button>
        <a className={styles.secondaryButton} href={result.imageUrl} download={`${result.title}.jpg`}>
          <Download size={16} />
          下载图片
        </a>
        <button className={styles.primaryInlineButton} onClick={onRegenerate} disabled={isGenerating}>
          <RefreshCcw size={16} />
          重新生成
        </button>
      </div>
      {isViewerOpen && (
        <div className={styles.imageViewer} role="dialog" aria-modal="true" aria-label="图片查看">
          <div className={styles.viewerToolbar}>
            <div>
              <button className={viewerImage === "result" ? styles.selectedChoice : ""} onClick={() => setViewerImage("result")}>效果图</button>
              {!useVirtualRoom && roomImage && <button className={viewerImage === "original" ? styles.selectedChoice : ""} onClick={() => setViewerImage("original")}>原图</button>}
              {furnitureImage && <button className={viewerImage === "product" ? styles.selectedChoice : ""} onClick={() => setViewerImage("product")}>产品图</button>}
            </div>
            <button className={styles.viewerClose} onClick={() => setIsViewerOpen(false)} aria-label="关闭查看"><X size={22} /></button>
          </div>
          <img src={viewerImageSrc} alt={viewerImageAlt} />
        </div>
      )}
    </section>
  );
}

function AnalysisField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={styles.analysisField}>
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PlanField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={styles.planField}>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PlanListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return (
    <label className={styles.planField}>
      {label}
      <textarea value={value.join("；")} onChange={(event) => onChange(event.target.value.split(/[；;\n]/).map((item) => item.trim()).filter(Boolean))} />
    </label>
  );
}

