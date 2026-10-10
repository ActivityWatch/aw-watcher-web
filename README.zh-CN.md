# ActivityWatch Web Watcher Plus

这是 `aw-watcher-web` 的一个可配置分支版本，核心目标是让用户在扩展设置页中手动填写 ActivityWatch 服务端地址，而不是只能在构建时写死。

这份 README 只面向当前这个 fork 本身，不再沿用上游项目的说明结构。它主要用于：

- 日常使用这个仓库
- 后续向上游提交 PR 时说明这次改动
- 满足 Firefox 扩展源码提交流程中的构建与审核说明要求

## 这个 Fork 解决了什么问题

上游扩展更偏向固定服务器地址或构建时指定服务器地址的使用方式。这个 fork 的重点改动是：

- 扩展安装后，用户可以直接在设置页里修改 ActivityWatch 服务端地址
- 修改后无需重新打包扩展
- 已保存的运行时地址优先生效
- 仍然保留构建时设置默认服务器地址的能力

这让它更适合：

- 自托管 ActivityWatch
- 内部网络部署
- 需要给不同用户配置不同服务端地址的场景

## 相比上游的主要改动

当前 fork 主要做了这些改动：

- 在设置页新增 `ActivityWatch Server URL`
- 将用户填写的服务器地址保存到浏览器本地存储
- 后台创建 ActivityWatch 客户端时优先读取运行时配置
- 保留 `VITE_ACTIVITYWATCH_BASE_URL` 作为构建时默认值
- 让弹窗中的 Web UI 链接跟随当前配置的服务器地址
- 为 Firefox 补充现代审核需要的
  `browser_specific_settings.gecko.data_collection_permissions`
- 使用 fork 自己的 Firefox 扩展 ID，避免与上游扩展冲突
- 补齐打包时必须存在的静态资源
- 重写文档，明确当前 fork 的构建、发布与审核流程

## 采集的数据

扩展会上报当前活动标签页，并使用 ActivityWatch 的
`web.tab.current` 事件类型。

每条事件包含：

- `url`
- `title`
- `audible`
- `incognito`
- `tabCount`

## 如何配置服务器地址

这个 fork 支持两种方式指定 ActivityWatch 服务端：

1. 在扩展设置页中手动填写
2. 构建时通过 `VITE_ACTIVITYWATCH_BASE_URL` 指定默认值

日常使用时，推荐优先使用第一种，也就是设置页配置。

## 在扩展设置页里配置服务器

安装扩展后：

1. 打开扩展设置页
2. 找到 `ActivityWatch Server URL`
3. 输入服务端地址，例如 `http://localhost:5600`
4. 点击 `Save`
5. 扩展会自动重载并开始使用新的地址

如果用户已经保存了运行时服务器地址，那么它会覆盖构建时默认值。

## 构建时写入默认服务器地址

如果你希望打包出来的扩展自带一个默认服务器地址，可以在构建时传入 `VITE_ACTIVITYWATCH_BASE_URL`。

示例：

```sh
# Chrome
VITE_ACTIVITYWATCH_BASE_URL=http://your-server:5600 \
VITE_TARGET_BROWSER=chrome \
npx vite build

# Firefox
VITE_ACTIVITYWATCH_BASE_URL=http://your-server:5600 \
VITE_TARGET_BROWSER=firefox \
npx vite build
```

## Firefox 审核相关说明

这个 fork 在 Firefox 方向上与上游有几项明确差异：

- 增加了 `data_collection_permissions`
  因为扩展会采集浏览活动并发送到用户配置的 ActivityWatch 服务端
- 使用了 fork 自己的扩展 ID：
  `aw-watcher-web-configurable@local`
- 为了支持“用户可修改任意兼容服务器地址”，当前在 Firefox 中使用了较宽的 host 权限

如果后续要向上游提 PR，这一部分很可能需要和上游作者单独讨论，因为权限策略与 AMO 审核策略有关。

## 构建环境

### 操作系统

推荐环境：

- Linux 或 macOS
- Windows 也可以用于本地开发，但打包 zip 时要注意路径分隔符问题

### 必需工具

- Node.js 23 及以上
- npm 10 及以上

当前仓库使用的主要构建工具版本来自 `package.json`：

- TypeScript `5.7.3`
- Vite `6.0.11`
- `vite-plugin-web-extension` `4.4.3`

## 安装依赖

```sh
npm ci
```

## 构建脚本

仓库内已经包含 `Makefile`，可用目标包括：

- `make install`
- `make compile`
- `make build-chrome`
- `make build-firefox`
- `make build-safari`

如果手动执行，等价命令是：

```sh
# 类型检查
npx tsc --noEmit

# Chrome 构建
VITE_TARGET_BROWSER=chrome npx vite build

# Firefox 构建
VITE_TARGET_BROWSER=firefox npx vite build
```

构建结果会输出到 `build/` 目录。

## Firefox 打包

Firefox 本地测试时，最简单的方式是直接加载：

- `build/manifest.json`

如果要生成 Firefox zip 包，请先构建，再把 `build/` 目录内容打包。

在 Windows 上推荐使用：

```powershell
$env:VITE_TARGET_BROWSER='firefox'
npx vite build
tar.exe -a -c -f artifacts\firefox.zip -C build .
```

为什么不用 `Compress-Archive`：

- 它可能会在 zip 内部写入 Windows 风格的反斜杠路径
- Firefox 会拒绝这种压缩包

## 安装构建后的扩展

### Chrome / Edge

1. 先构建 Chrome 版本
2. 打开 `chrome://extensions`
3. 开启开发者模式
4. 点击“加载已解压的扩展程序”
5. 选择 `build/` 目录

### Firefox

1. 先构建 Firefox 版本
2. 打开 `about:debugging#/runtime/this-firefox`
3. 点击“加载临时附加组件”
4. 选择 `build/manifest.json`

## 提交 Firefox 源代码包时应包含什么

如果你要向 Firefox 提交源码包，这个仓库已经具备基本所需信息，但源码包应尽量保留以下内容：

- 本 README
- `package.json`
- `package-lock.json`
- `Makefile`
- `src/`
- `public/`
- 其他构建所需仓库文件

审核侧最小构建步骤可以写成：

```sh
npm ci
VITE_TARGET_BROWSER=firefox npx vite build
```

预期输出：

- 在 `build/` 下生成 Firefox 扩展
- `build/manifest.json` 为最终生成结果

同时注意：

- 不要把你自己写的源代码只提交转译后或压缩后的版本
- 第三方依赖通过 `npm ci` 安装即可
- 构建说明应写在 README 或审核者备注中

## 方便提 PR 给上游的变更总结

如果后面你要向上游作者提 PR，可以把这个 fork 的改动概括为：

- 增加运行时可配置的 ActivityWatch 服务端地址
- 保留构建时默认服务器地址能力
- 让 popup 与后台客户端统一读取当前配置
- 为 Firefox 审核补齐必要元数据
- 不改变 ActivityWatch 事件格式本身

## English README

See [README.md](./README.md).
