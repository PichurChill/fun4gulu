# Tetris 开发进度

## 2026-09-30 · v0.0.14 新增俄罗斯方块（已完成）

按 plan.md 全部要求完成，构建与浏览器实测通过。

### 改动文件

| 文件 | 改动 |
|---|---|
| `ui/src/views/TetrisView.vue` | 新建。掌机风格俄罗斯方块完整实现 |
| `ui/src/router/index.ts` | 新增路由 `/tetris` |
| `ui/src/views/HomeView.vue` | games 数组新增 tetris 入口；图标（内联 SVG data URI）；footer 版本号 v0.0.13 → v0.0.14 |
| `ui/src/i18n.ts` | zh/en/ja/ko/fr 五语言新增 `games.tetris` 与 `tetrisView` 词条 |

### 功能实现（对照 plan.md 要求）

- **掌机风格**：黄色机身（黑色像素描边 + 硬阴影）、深色屏幕总成、右侧信息面板（得分 / 等级 / 行数 / 下一个预览 / 道具位）、底部触屏控制（◀ ▼ ▶ 方向键 + 大红旋转键 + 暂停键）、喇叭格栅等装饰，与项目现有像素复古风一致。
- **完整游戏逻辑**：
  - 7 种方块（I/O/T/S/Z/J/L，NES 配色），7-bag 随机
  - 旋转（矩阵顺时针）+ 墙踢（偏移序列 0/±1/上1/±2，I 型依赖 ±2）
  - 消行计分：100/300/500/800 × 等级；每 10 行升级，下落间隔 780ms 起步、每级 -65ms（下限 90ms）
  - 下一个预览（独立 canvas，bounding box 居中）、暂停（P 键 / 按钮 / 点击遮罩）、游戏结束（锁定溢出或出生重叠 → 结算面板 + 再来一局）
  - WebAudio 方波音效：移动 / 旋转 / 锁定 / 消行 / 结束
- **移动端优先**：触屏按钮 pointer 事件（长按连发移动、按住软降，`touch-action: none` 防误滚动）；桌面键盘 ←→↓↑ + P；375×667 视口整机一屏无裁切。
- **未做**（YAGNI，plan 未要求）：硬降、锁定延迟、道具系统实装（信息面板道具位为空槽展示，与参考截图一致）、消行动画。

### 验证记录

- `pnpm build`（vue-tsc type-check + vite build）通过，EXIT=0。
- Playwright 浏览器实测（dev server）：
  - 桌面 1280×720 与移动 375×667 布局完整、按钮齐全无裁切；
  - 像素级验证：键盘左移（L 型 x 3→2）、顺时针旋转（与矩阵推演一致）、自然下落锁定（I 型落底 row19）、触屏左移（S 型 x 3→2）、按住软降连落多块、触屏旋转生效；
  - 暂停 → 恢复（P 键 + overlay 点击）；游戏结束 → 结算面板 → 再来一局重置棋盘；
  - 首页卡片（/tetris 链接 + SVG 图标加载）与 footer v0.0.14；游戏全程 console 无错误。

### 开发中修复的问题

1. **消行漏行 bug**：初版 `clearLines` 倒序 for 循环中 `splice + unshift` 使行号下移，连续多行满时会漏消（如 19、18 两行同满只消一行）。改为 while 不递减索引写法。
2. **垂直溢出**：初版画布高度 `min(58vh, 480px)` 在 720px 高视口下控制键被截到一屏外。改为 `min(46vh, 480px)`（移动端 `42vh`），整机一屏放下。

### 备注

- 首页 tetris 图标用内联 SVG data URI 而非 win98 图标站外链：Windows 98 无自带俄罗斯方块图标，且该站点对非浏览器请求一律 403 无法验证文件存在，内联方案可靠且零外部依赖。
- 本机 pnpm 需 `unset npm_config_prefix` 后经 nvm node 22 + pnpm 10 跑（corepack 会拦到 pnpm 11 并要求清空 node_modules，勿用）。
