import { cabinetPlacementSystemPrompt, perspectiveLabels, virtualRoomStyleLabels } from "../constants";
import type { PerspectiveOption, PlacementSettings, SceneAnalysis } from "../types";

const referenceRoomGenerationSystemPrompt = `你是专业的柜类家居场景摄影生成助手。当前任务是参考重建，不是编辑原场景照片。
场景参考图只用于理解装修风格、色彩、材质、采光和空间氛围，不得锁定或复制参考图的原相机机位，也不要求逐项保持参考图中的家具位置。
最后一张输入图是目标柜体原始产品图，是产品外观的最高优先级依据。必须保持产品类别、模块数量、宽度关系、柜门、抽屉、开放格、层板、玻璃、柜脚、颜色、材质、木纹和可见细节，不得生成相似款。
根据指定视角重新构建真实家居摄影画面，产品必须贴墙落地，透视、尺度、光线和阴影自然。`;

function buildPerspectiveCompositionPrompt(perspective: PerspectiveOption): string {
  if (perspective === "close") {
    return "近景只展示原始产品中一个明确存在的局部，不展示完整柜体。相机必须贴近柜体，只展示柜体整体约 8% 到 18% 的真实局部，例如一只拉手与门板交界、一个抽屉边角、一段层板连接、玻璃门框或一小块清晰木纹；只选择一个连续区域，不能同时拼接多个细节。柜体应自然超出画面四周，环境只保留少量墙面、地面或光影。必须以原始产品图为唯一几何依据，禁止补画原图不存在的五金、纹理、雕花、层板、抽屉或模块，也禁止把完整柜体缩小后继续放在画面中。";
  }
  if (perspective === "medium") {
    return "侧面视角以柜体主体为画面核心。柜体正常落地贴墙：柜体背板与墙面保持平行并完整贴墙，柜体自身的偏航、俯仰和翻滚角始终为零，禁止旋转、斜摆、平移、抬高、压低或拉伸柜体。只移动相机：相机沿水平圆弧移动到柜体左前方或右前方约 45 度，镜头始终对准柜体中心且保持水平，不使用荷兰角。允许柜体在新画面中的二维位置、投影大小和遮挡关系随相机自然变化，但现实中的柜体位置和朝向不变。侧板可见性只能来自相机视差，近侧侧板的投影宽度约占柜体可见投影总宽度的 12% 到 20%。画面必须清楚看到正面和一侧侧板、前沿与自然纵深关系；只展示柜体约 50% 到 70%，可自然裁掉一端、顶部或底部，不要求完整柜体。所有可见模块、柜门、抽屉、开放格和层板必须与原始产品一致。禁止正面平视、镜像翻转产品或通过旋转柜体制造侧面。";
  }
  return "远景完整展示柜体及其与墙面、地面、沙发、茶几或其他参照物的空间关系，保留完整家居环境。";
}

function placementPlanForPerspective(analysis: SceneAnalysis, perspective: PerspectiveOption) {
  if (perspective === "close") {
    return {
      ...analysis.placementPlan,
      facing: "使用真实近距离相机拍摄产品中明确存在的局部，不要求展示完整摆放方向或完整柜体。",
      candidates: []
    };
  }
  if (perspective !== "medium") return analysis.placementPlan;
  return {
    ...analysis.placementPlan,
    placement: "保持已确认的靠墙位置；柜体背板与墙面平行并完整贴墙，左右两端到墙面的距离一致，不允许斜放或一端离墙。",
    facing: "柜体朝向保持不变且正面与墙面平行；只把相机沿水平圆弧移动到柜体左前方或右前方约 45 度，通过相机视差清楚看到正面和一侧侧板。",
    rationale: "侧面效果完全由相机机位变化产生，不旋转、镜像或重新摆放柜体。",
    avoid: [...analysis.placementPlan.avoid, "柜体斜放", "柜体一端离墙", "为展示侧板而旋转柜体"],
    candidates: []
  };
}

function buildHumanModelPrompt(settings: PlacementSettings): string {
  if (!settings.addHumanModel) {
    return "人物要求：用户未勾选添加模特。最终场景不得出现真实人物、人体假模型、人台、雕塑或人形装饰。";
  }

  const genderLabel = {
    any: "性别不限",
    female: "女性",
    male: "男性"
  }[settings.humanModelGender];
  const ageLabel = {
    adult: "成人",
    child: "儿童",
    senior: "老年"
  }[settings.humanModelAge];

  return [
    `人物要求：用户已勾选添加一位${genderLabel}、${ageLabel}的真实真人模特。`,
    "人物必须衣着完整、五官和肢体自然，呈现真实家居摄影质感；不得生成裸体人物、人体假模型、人台、雕塑或 3D 人偶。",
    "人物可以自然取书、阅读、整理摆件或从柜体前经过，允许根据真实前后关系自然遮挡部分柜体，并与场景风格、透视、尺度、光线和阴影一致。"
  ].join("\n");
}

export function buildAnalysisPrompt(extraContext = "", extraPrompt: string[] = [], userRequirements = ""): string {
  return [
    cabinetPlacementSystemPrompt,
    "输入图片顺序为：第一张是用户的家居场景主图；如有后续场景图，它们是同一空间的补充角度；最后一张是要试摆的柜类产品图。请综合分析并返回严格 JSON，不要输出 Markdown。",
    "场景分析必须覆盖：空间类型、可用墙面、地面、门窗、通道、采光、已有家具、墙面装饰、适合保留和可能需要移除的物品。",
    "产品分析必须先自动判断产品是书柜、组合柜、斗柜、餐边柜或其他柜类，再识别整体轮廓、模块数量、开放格、层板、柜门、玻璃、抽屉、柜脚、颜色、材质、木纹和可见细节。不要要求或虚构真实尺寸。",
    "JSON 顶层字段严格为：roomSummary, furnitureSummary, furnitureIdentity, lighting, perspective, placementAdvice, constraints, placementPlan, stylingPlan, posterCopy。",
    "furnitureIdentity 字段严格为：category, silhouette, structure, doors, drawers, shelves, material, color, details。前八项为中文字符串，details 为中文字符串数组。",
    "placementPlan 字段严格为：summary, placement, facing, scale, preserve, remove, avoid, rationale, candidates, selectedCandidateId。candidates 包含 2 到 3 个方案，每项字段严格为 id, label, placement, facing, scale, score, reasons, blocksWalkway, conflictsWithPreservedItems, violatesUserRequirements。",
    "stylingPlan 字段严格为：summary, books, ornaments, lighting, atmosphere。请根据柜体开放区域和场景风格自动规划书籍、陶瓷、艺术摆件、唱片、灯具或生活物品。",
    "posterCopy 字段严格为：seriesName, productName, headline, description, englishDescription。生成简洁、克制、适合高端家居海报的文案；不要包含尺寸、容量、价格、品牌承诺或无法从图片确认的材质等级。",
    "用户要求优先级最高。把用户明确提出的摆放、保留、移除、软装、灯光和人物要求写入方案；未明确时才由 AI 自行判断。",
    userRequirements ? `用户当前要求（最高优先级）：${userRequirements}` : "用户尚未给出额外要求，请依据空间与产品自然规划。",
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
  ].filter(Boolean).join("\n");
}

export function buildVirtualAnalysisPrompt(
  styleLabel: string,
  extraContext = "",
  extraPrompt: string[] = [],
  userRequirements = ""
): string {
  return [
    cabinetPlacementSystemPrompt,
    `输入图片只有一张柜类产品图。请识别产品，并为它规划一个${styleLabel}虚拟家居空间和海报文案。返回严格 JSON，不要输出 Markdown。`,
    "先自动判断产品是书柜、组合柜、斗柜、餐边柜或其他柜类，再识别整体轮廓、模块数量、开放格、层板、柜门、玻璃、抽屉、柜脚、颜色、材质、木纹和可见细节。不要要求或虚构真实尺寸。",
    "JSON 顶层字段严格为：roomSummary, furnitureSummary, furnitureIdentity, lighting, perspective, placementAdvice, constraints, placementPlan, stylingPlan, posterCopy。",
    "furnitureIdentity 字段严格为：category, silhouette, structure, doors, drawers, shelves, material, color, details。",
    "placementPlan 字段严格为：summary, placement, facing, scale, preserve, remove, avoid, rationale, candidates, selectedCandidateId。虚拟空间不需要生成候选位，candidates 返回空数组，selectedCandidateId 返回空字符串。",
    "stylingPlan 字段严格为：summary, books, ornaments, lighting, atmosphere。根据柜体开放区域和装修风格自动规划书籍、陶瓷、艺术摆件、唱片、灯具或生活物品。",
    "posterCopy 字段严格为：seriesName, productName, headline, description, englishDescription。生成高端家居海报文案，不要包含尺寸、容量、价格、品牌承诺或无法确认的材质等级。",
    userRequirements ? `用户当前要求（最高优先级）：${userRequirements}` : "",
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
  ].filter(Boolean).join("\n");
}

export function buildGenerationPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: PerspectiveOption,
  extraContext = "",
  extraPrompt: string[] = [],
  roomAsReference = false
): string {
  return [
    roomAsReference ? referenceRoomGenerationSystemPrompt : cabinetPlacementSystemPrompt,
    roomAsReference
      ? "这是家居场景参考重建任务。前面的图片均只作为装修风格、光线和氛围参考，最后一张是未经 AI 改画的原始产品图，也是唯一产品结构依据。禁止把场景参考图当作编辑底图，禁止保持其正面相机机位；必须直接依据原始产品图和当前指定视角重新构建画面，不生成或参考任何 AI 中间图。"
      : "这是严格的家居图片编辑与营销场景生成任务。第一张是已按确认方案清理的场景底图；最后一张是未经 AI 改画的原始产品图，是产品外观的最高优先级依据。",
    "生成一张没有任何文字、价格、Logo、水印、边框或海报排版的纯场景主图。应用会在生成后统一完成中文文字和海报版式。",
    `生成视角：${perspectiveLabels[perspective]}。采用自然家居摄影构图。${buildPerspectiveCompositionPrompt(perspective)}`,
    roomAsReference
      ? "执行以原始产品图为依据的场景重建，不做柜体概念设计。必须将同一个柜体放进新视角场景，逐项保持模块数量、各模块宽度关系、整体轮廓、开放格与层板关系、柜门和抽屉数量、玻璃或木门造型、柜脚、颜色、材质、木纹与可见细节。不得增删、合并、拆分或重新排列模块，也不得生成相似款。"
      : "执行产品级图片编辑，不做柜体概念设计。必须把原始产品图中的同一个柜体放进场景，逐项保持模块数量、各模块宽度关系、整体轮廓、开放格与层板关系、柜门和抽屉数量、玻璃或木门造型、柜脚、颜色、材质、木纹与可见细节。不得增删、合并、拆分或重新排列模块，不得把原场景柜体改色后冒充目标产品，也不得生成相似款。",
    `目标柜体身份卡：${JSON.stringify(analysis.furnitureIdentity)}`,
    `已确认摆放方案：${JSON.stringify(placementPlanForPerspective(analysis, perspective))}`,
    `已确认软装方案：${JSON.stringify(analysis.stylingPlan)}`,
    "书籍与饰品需要真实落在开放格、层板、玻璃柜内部或斗柜台面上，遮挡关系正确；封闭柜门和抽屉表面不得凭空出现物品。",
    "画面质感参考高端黑胡桃木家居摄影：暖色环境光、自然接地阴影、真实木纹、克制复古氛围、舒适生活感。不得把场景变成白底产品棚拍。",
    buildHumanModelPrompt(settings),
    settings.notes ? `用户额外要求（最高优先级，必须逐项执行）：${settings.notes}` : "",
    `融合强度：${settings.blendStrength}；输出比例：${settings.ratio}；清晰度：${settings.clarity}。`,
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
  ].filter(Boolean).join("\n");
}

export function buildVirtualRoomPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: PerspectiveOption,
  extraContext = "",
  extraPrompt: string[] = []
): string {
  const styleLabel = virtualRoomStyleLabels[settings.virtualRoomStyle];
  return [
    cabinetPlacementSystemPrompt,
    "这是从柜类产品图直接生成虚拟家居空间的任务。没有用户场景原图，输入只包含目标柜体参考图。",
    `生成一个真实完整的${styleLabel}家居空间。书柜可放在客厅、书房或家庭阅读区；斗柜、餐边柜等低柜应根据产品自动选择合理空间。`,
    `生成视角：${perspectiveLabels[perspective]}。${buildPerspectiveCompositionPrompt(perspective)}`,
    "生成一张没有任何文字、价格、Logo、水印、边框或海报排版的纯场景主图。应用会在生成后统一完成海报排版。",
    "目标柜体原图是产品外观的最高优先级依据。执行产品级图片编辑，不做柜体概念设计；必须锁定模块数量、各模块宽度关系、整体轮廓、柜门、抽屉、开放格、层板、玻璃、柜脚、颜色、材质、木纹和可见细节，不得增删、合并、拆分、重新排列模块或生成相似款。",
    `目标柜体身份卡：${JSON.stringify(analysis.furnitureIdentity)}`,
    `虚拟摆放方案：${JSON.stringify(placementPlanForPerspective(analysis, perspective))}`,
    `软装方案：${JSON.stringify(analysis.stylingPlan)}`,
    "自动在开放格、玻璃柜或台面搭配书籍、陶瓷、艺术摆件、唱片、台灯和生活物品。陈设层次丰富、疏密有序，不能遮挡柜体结构。",
    buildHumanModelPrompt(settings),
    settings.notes ? `用户额外要求（最高优先级）：${settings.notes}` : "",
    `输出比例：${settings.ratio}；清晰度：${settings.clarity}。`,
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
  ].filter(Boolean).join("\n");
}

export function buildQualityPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext = "",
  extraPrompt: string[] = [],
  perspective: PerspectiveOption = "wide",
  hasRoomImage = true
): string {
  return [
    hasRoomImage
      ? "你是柜类试摆结果质检员。输入依次为原始场景图、目标柜体图和生成的纯场景结果图。"
      : "你是柜类虚拟空间结果质检员。输入依次为目标柜体原始产品图和生成的纯场景结果图。",
    perspective === "close"
      ? "近景质检不得要求画面出现完整柜体，也不得因为看不到完整模块数量而判定失败。近景必须只展示柜体局部细节并允许产品超出画面边缘；核对画面中可见的木纹、拉手、门板、层板、玻璃、柜脚或连接工艺是否确实来自目标产品，若虚构细节、生成相似款或仍以完整柜体为主体，必须判定 passed=false。"
      : perspective === "medium"
        ? "侧面视角质检必须确认画面来自真实左前方或右前方约40至45度机位，能够清楚看到柜体正面、一侧侧板、前沿与自然纵深关系；柜体背板必须与墙面平行并完整贴墙，左右两端到墙面距离一致。若柜体斜放、一端离墙、为朝向镜头而旋转、镜像翻转，或几乎看不到侧面，必须判定 passed=false。产品结构仍需与原始产品一致。"
        : "产品一致性是硬性门槛：逐项核对整体轮廓、模块数量、各模块宽度关系、门板数量、抽屉数量、开放格、层板位置、玻璃、柜脚、颜色、材质、木纹和可见细节。任意结构被增删、合并、拆分、重新排列，或生成相似款，都必须判定 passed=false。",
    perspective === "close"
      ? "检查近距离机位、透视、光影、景深和局部饰品关系是否自然；不得要求近景证明柜体的完整摆放位置、贴墙或落地关系。"
      : "同时检查位置、朝向、保留与移除策略是否符合确认方案，柜体是否贴墙落地，透视、视觉比例、光影和饰品摆放是否自然。",
    settings.addHumanModel
      ? "用户要求添加真人模特：人物必须衣着完整、真实自然、尺度和光影正确；若出现裸体人物、人体假模型、人台、雕塑或 3D 人偶，必须判定 passed=false。人物允许自然遮挡部分柜体，不得仅因遮挡而判定失败。"
      : "用户未要求添加人物：结果中不得出现真实人物、人体假模型、人台、雕塑或人形装饰。",
    "只返回严格 JSON：passed（布尔值）, issues（中文字符串数组）, correctionPrompt（中文字符串）。若不通过，correctionPrompt 必须明确要求恢复原产品结构或替换错误人物，供下一轮自动纠正。",
    `已确认摆放方案：${JSON.stringify(analysis.placementPlan)}`,
    `已确认软装方案：${JSON.stringify(analysis.stylingPlan)}`,
    settings.notes ? `用户当前要求（最高优先级）：${settings.notes}` : "",
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("；")}` : ""
  ].filter(Boolean).join("\n");
}
