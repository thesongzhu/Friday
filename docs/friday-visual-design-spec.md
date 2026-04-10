# Friday 视觉设计方案 — 色彩心理学 & 排版 & 交互

## 一、当前设计诊断

### 色彩现状
| 属性 | 英文模式 | 中文模式 |
|------|---------|---------|
| 背景 | #faf2e7 (暖米色) | #fbf4ea (更暖) |
| 主墨色 | #332922 (深棕) | #2d2118 (更深棕) |
| 强调色 | #6c7f92 (灰蓝) | #c87a3c (赤陶橙) |
| 表面 | rgba(255,255,255,0.56) 毛玻璃 | rgba(255,255,255,0.60) |
| 暗色模式 | **未实现** | **未实现** |

### 问题
1. **英文强调色太闷** — #6c7f92 灰蓝缺乏 AI 产品该有的能量和智能感
2. **状态色语义不清** — success/warning/destructive 共用 accent/text-secondary/ink
3. **暗色模式缺失** — Tailwind 有 `darkMode: ["class"]` 但 CSS 变量没有 dark 定义
4. **无 Skeleton 动画** — 加载用纯文字 "Loading..."
5. **信息密度偏低** — 中国用户偏好更紧凑的布局
6. **无障碍不足** — 仅 2 处 aria-label

---

## 二、色彩心理学研究 (基于网络调研)

### AI 产品配色参考

| 产品 | 主色 | 心理学 |
|------|------|--------|
| ChatGPT | #10A37F (青绿) | 成长、安全、亲近 |
| Claude | #C15F3C (赤陶) | 温暖、人性、扎实 |
| Perplexity | #1FB8CD (青色) | 好奇、清晰、信任 |
| Linear | #5E6AD2 (靛蓝) | 冷静权威、深度聚焦 |
| Cursor | #F54E00 (橙) + #8C7CCD (紫) | 能量、创造力 |
| Vercel/v0 | #0070F3 (蓝) | 稳定、精确 |

**紫色/靛蓝为什么主导 AI 品牌**：
- 蓝（信任）+ 红（能量）= 紫（技术魅力）
- 暗示变革、智慧、高端
- 蓝色被企业占了，绿色被健康占了，紫色是无主之地

### 中国市场色彩偏好

| App | 颜色 | Hex | 心理 |
|-----|------|-----|------|
| 微信 | 绿 | #07C160 | 沟通、活力 |
| 支付宝 | 蓝 | #1677FF (Ant Design) | 金融信任 |
| 抖音 | 粉+青 | #FF0050 + #00F2EA | 娱乐活力 |
| 小红书 | 红 | #FF2442 | 社交商业 |
| 钉钉 | 蓝 | #3296FA | 企业专业 |
| 飞书 | 蓝 | 干净极简 | 协作效率 |

**中国色彩文化**：
- **红** — 吉祥、成功、喜庆（不是"危险"，可用于正面 CTA）
- **金/琥珀** — 财富、权力、皇家（适合高级功能）
- **蓝** — 专业、信任、安全（跨文化通用）
- **白** — 需谨慎（传统丧事联想，但现代科技用户已习惯）

---

## 三、推荐色彩方案

### 全局强调色升级

**从**：#6c7f92 (灰蓝，闷) → **到**：#5E6AD2 (靛蓝，Linear 风格)

理由：
- 靛蓝传达"冷静的智能"，比灰蓝更有存在感
- 与 Linear/Notion 对齐（目标用户群重叠）
- 在浅色暖底上对比度足够
- 暗色模式下减饱和为 #7B85E0 依然可用

### 中文模式保持暖橙

**保留**：#c87a3c (赤陶橙) — 文化契合，Claude 同色系

**增加副色**：#4A6CF7 (蓝靛) 用于"技术信任"场景（provider 状态、安全、诊断）

### 语义状态色（新增）

| 语义 | 浅色模式 | 暗色模式 | 用途 |
|------|---------|---------|------|
| --color-success | #34C759 | #30D158 | 成功、健康、完成 |
| --color-warning | #FAAD14 | #FFD60A | 警告、注意、待审 |
| --color-error | #E5484D | #E5484D | 错误、失败 |
| --color-info | #5E6AD2 | #7B85E0 | 信息、链接、学习 |
| --color-live | #34C759 | #30D158 | 实时指示器 |

### 暗色模式方案

```css
[data-theme="dark"] {
  /* 背景层级（Material 电梯模型） */
  --color-bg-base: #0F0E0D;            /* 近黑，暖底色 */
  --color-bg-elevated: #1A1917;         /* 卡片 */
  --color-bg-surface: rgba(255,255,255,0.05);  /* 交互面 */
  --color-bg-surface-strong: rgba(255,255,255,0.08);
  --color-bg-chrome: rgba(26,25,23,0.94);      /* 侧栏 */

  /* 文字 */
  --color-ink: #E8E4E0;                /* 暖白 */
  --color-text-primary: #E8E4E0;
  --color-text-secondary: rgba(232,228,224,0.72);
  --color-text-tertiary: rgba(232,228,224,0.54);
  --color-text-faint: rgba(232,228,224,0.34);

  /* 边框 */
  --color-border-soft: rgba(255,255,255,0.08);
  --color-border-strong: rgba(255,255,255,0.14);

  /* 强调色（减饱和 20-30%） */
  --color-accent: #7B85E0;             /* 靛蓝 减饱和 */
  --color-accent-soft: rgba(123,133,224,0.14);
  --color-accent-strong: rgba(123,133,224,0.24);

  /* 阴影（暗色下更微妙） */
  --shadow-card: 0 16px 36px rgba(0,0,0,0.3);
  --shadow-floating: 0 10px 30px rgba(0,0,0,0.2);
}

/* 中文暗色 */
[data-locale="zh"][data-theme="dark"] {
  --color-accent: #D4935A;             /* 赤陶橙 减饱和 */
  --color-accent-soft: rgba(212,147,90,0.14);
}
```

**为什么不用纯黑 #000000**：
- 纯黑 + 白字对比过强，伤眼
- 深灰能表达更多层次和高度
- OLED 屏滚动时纯黑会"拖影"

---

## 四、排版方案

### 字体栈升级

```css
/* 正文（中文优先） */
--font-display: "Inter", "PingFang SC", "Hiragino Sans GB", 
                "Noto Sans SC", "Microsoft YaHei", sans-serif;

/* 代码 */
--font-mono: "Geist Mono", "IBM Plex Mono", "SFMono-Regular", monospace;
```

**为什么加 Inter**：
- Vercel/Linear/Notion 都在用
- 变量字体，单文件多粗细
- 与 Noto Sans SC 几何风格匹配
- 免费，CDN 加载快

### 中英混排关键参数

| 属性 | 英文 | 中文/混排 |
|------|------|----------|
| 正文字号 | 14-15px | **15-16px**（中文笔画密，小了看不清）|
| 行高 | 1.5 | **1.7**（已正确设置 ✅）|
| 字间距（中文正文） | - | **0**（中文不需要 letter-spacing）|
| 字间距（中文标题） | - | **0 ~ 0.02em** |
| 最大行宽 | 80 字符 | **40 个中文字**（信息量相当）|
| 最小可用字号 | 12px | **13-14px** |

### 字重对照

| 层级 | 拉丁 | CJK | 说明 |
|------|------|-----|------|
| 正文 | 400 | 400 | CJK 400 视觉上比拉丁 400 重 |
| 强调 | 500 | 500 | |
| 标题 | 600 | 700 | CJK 需要更重才有标题感 |
| 大标题 | 700 | 800 | 已在 Chinese locale 使用 ✅ |

---

## 五、布局与密度

### 信息密度等级

| 等级 | 代表 | 行高 | 内边距 | 适用 |
|------|------|------|--------|------|
| 最高密度 | Bloomberg | 20-24px | 2-4px | 纯数据 |
| 高密度 | Linear / Gmail 紧凑 | 28-32px | 4-8px | 效率工具 |
| **中高密度** | **Friday 推荐** | **32-40px** | **8-12px** | AI OS |
| 中密度 | Notion | 36-44px | 8-12px | 笔记/文档 |
| 低密度 | Apple | 48-64px | 16-24px | 消费品 |

**推荐**：默认"标准"，中文 locale 默认"紧凑"。
Material Design 的密度模型：每级减少 4px 组件高度，不改水平间距。

### 布局结构

```
┌──────────┬─────────────────────────┬──────────┐
│ 侧栏      │ 主工作区                 │ 上下文面板 │
│ 240px     │ flex-1                  │ 320px    │
│ 可折叠     │ 对话 OR 仪表盘           │ 可关闭    │
│           │                         │ agent活动 │
│ 导航      │                         │ 数据/工件 │
│ agent列表  │                         │ 学习状态  │
└──────────┴─────────────────────────┴──────────┘
```

---

## 六、微交互与动画

### 时序标准

| 场景 | 时长 | 缓动 |
|------|------|------|
| hover/focus | 150-200ms | cubic-bezier(0.4, 0, 0.2, 1) |
| 内容出现 | 200-300ms | cubic-bezier(0, 0, 0.2, 1) 减速 |
| 内容消失 | 150-200ms | cubic-bezier(0.4, 0, 1, 1) 加速 |
| 弹性/回弹 | 300ms | cubic-bezier(0.34, 1.56, 0.64, 1) |

### AI 专属动画

1. **流式文字** — 逐词出现 + 闪烁光标
2. **思考状态** — 渐变 shimmer 横扫（1.5-2s 循环）
3. **Skeleton 加载** — 灰色矩形（100%→85%→60% 宽度递减）+ shimmer
4. **状态转换** — 点色变化 fade 200ms；完成时 scale 1.0→1.05→1.0
5. **卡片悬停** — translateY(-1px) + 阴影加深（已有 ✅）

### 必须尊重

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 七、执行优先级

| 优先级 | 改动 | 影响 | 复杂度 |
|--------|------|------|--------|
| P0 | 新增语义状态色 (success/warning/error/info) | 全局一致性 | 低 |
| P0 | 升级英文强调色 #6c7f92 → #5E6AD2 | 品牌感 | 低 |
| P1 | 实现暗色模式 CSS 变量 | 用户体验 | 中 |
| P1 | 添加 Skeleton 加载组件 | 感知速度 | 中 |
| P1 | 添加 Inter 字体 | 排版质量 | 低 |
| P2 | 信息密度切换（标准/紧凑） | 效率用户 | 中 |
| P2 | AI 思考 shimmer 动画 | 智能感知 | 低 |
| P2 | 右侧上下文面板 | 信息架构 | 高 |
| P3 | 完善 ARIA 无障碍 | 合规 | 中 |
| P3 | prefers-reduced-motion 支持 | 合规 | 低 |

---

## 八、参考来源

- [Why Purple Dominates AI Branding](https://simplyputpsych.co.uk/monday-musings-1/the-rise-of-purple-in-ai-branding)
- [AI UX Color Patterns](https://www.shapeof.ai/patterns/color)
- [Ant Design Color System](https://ant.design/docs/spec/colors/)
- [Material Design Dark Theme](https://m2.material.io/design/color/dark-theme.html)
- [Material Design Density](https://m3.material.io/blog/material-density-web)
- [CJK Typesetting Rules](https://fonts.google.com/knowledge/type_in_china_japan_and_korea/cjk_typesetting_rules)
- [UI Density - Matt Strom](https://mattstromawn.com/writing/ui-density/)
- [Chinese Market Color Perception](https://sampi.co/color-perception-considerations-in-marketing-design-for-chinese-market/)
- [Generative AI Loading States](https://cloudscape.design/patterns/genai/genai-loading-states/)
- [Vercel Geist Design System](https://vercel.com/geist/introduction)
