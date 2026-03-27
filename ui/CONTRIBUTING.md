# 贡献指南

## 包管理器

**本项目强制使用 `pnpm` 作为包管理器。**

### 为什么使用 pnpm？

- 更快的安装速度
- 更节省磁盘空间
- 严格的依赖管理，避免幽灵依赖
- 更好的 monorepo 支持

### 安装依赖

```bash
# 使用 pnpm 安装依赖
pnpm install
```

### 如果尝试使用 npm 或 yarn

项目配置了强制检查机制，如果使用 npm 或 yarn 会报错：

```
Error: This project requires using pnpm as the package manager.
```

### 全局安装 pnpm（如果尚未安装）

```bash
npm install -g pnpm
# 或
corepack enable
```

## 开发环境要求

- Node.js: `^20.19.0 || >=22.12.0`
- pnpm: `>=10.0.0`
