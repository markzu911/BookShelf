import type { PlacementSettings, PerspectiveOption, VirtualRoomStyle } from "./types";

export const TOOL_ID = "cabinet-placement";
export const TOOL_NAME = "AI 柜类试摆助手";
export const TOOL_COST = 10;

export const defaultSettings: PlacementSettings = {
  position: "auto",
  customPosition: "",
  perspectives: ["wide"],
  blendStrength: "medium",
  ratio: "4:3",
  model: "gemini-3",
  clarity: "1K",
  addHumanModel: false,
  humanModelGender: "any",
  humanModelAge: "adult",
  virtualRoomStyle: "modern",
  seriesName: "",
  productName: "",
  price: "",
  notes: ""
};

export const perspectiveLabels: Record<PerspectiveOption, string> = {
  wide: "远景（空间全景）",
  medium: "侧面视角（柜体主体）",
  close: "近景（柜体细节）"
};

export const virtualRoomStyleLabels: Record<VirtualRoomStyle, string> = {
  modern: "现代简约",
  italian: "意式轻奢",
  cream: "奶油风",
  "new-chinese": "新中式",
  "wabi-sabi": "侘寂风",
  american: "美式",
  nordic: "北欧",
  minimal: "极简黑白"
};

export const cabinetPlacementSystemPrompt = `你是专业的家居柜类试摆与软装视觉设计助手。你的任务是把用户上传的书柜、组合柜、斗柜或其他柜类产品真实自然地摆放到用户上传的家居场景中，或在虚拟家居空间里生成高级营销场景。

必须遵守：
1. 产品一致性是 P0 硬约束。不能把目标柜体换成相似款；必须保留上传产品的类别、模块数量、柜门与抽屉结构、开放格与层板关系、玻璃或木门造型、柜脚、颜色、材质、木纹和整体视觉比例。
2. 根据场景照片自动匹配透视、视觉尺度、贴墙与落地关系、光照方向、阴影、反射和环境色。柜体不能漂浮、穿模、倾斜或比例失真。
3. 不得擅自改变场景主体结构，不得改动门、窗、梁柱、墙地面材质、主要采光和用户要求保留的家具。
4. 不得遮挡门窗和主要通道。高柜优先选择完整墙面并保持垂直；斗柜和矮柜优先靠墙落地，并与墙画、沙发、灯具和周边家具形成自然关系。
5. 根据用户自然语言要求调整摆放、保留、移除、软装、灯光和人物；这些要求只优先于 AI 默认建议，绝不能覆盖第 1 条产品一致性。
6. 开放格和玻璃柜区域应由 AI 自动搭配书籍、陶瓷、艺术摆件、唱片或生活物品，陈设丰富但不过度拥挤，并与场景风格协调。
7. 这是“编辑原场景图”的任务，不允许直接返回未改动的原图。目标柜体必须在最终图中清楚可见，并依照已确认方案产生明显改变。
8. 输出尽量结构化，分析阶段返回 JSON；生成阶段返回图片。`;


