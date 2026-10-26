# 隔离 Paseo 集成测试

English: [English](README.md)

宿主和 UI 套件独立于 `npm test`，要求 `PATH` 中的 `paseo` CLI 版本满足 `paseo-plugin.json`。

## 本地运行 CI 检查

执行 `npm ci` 后运行：

```sh
npm run test:host
```

runner 会打包当前 checkout，将解包后的 tarball（不含开发依赖）安装到新建且带 marker 的 home，并运行集成套件。它自动选择 loopback 端口、禁用 relay，结束后停止 daemon 并删除 home。停止失败时保留 home 用于排查，不使用任何已有的 Paseo home 或 daemon。

集成套件之后，runner 还会检查 Workboard 不会唤醒空闲 Agent（`scripts/check-idle-wake.mjs`）：创建空闲的 fixture Agent，重启 daemon 使它们都未加载，让 Workboard 启动并完成一次定时刷新，然后在 daemon 日志里出现 `clientId: plugin:paseo-workboard` 的 `Agent resumed from persistence` 时判定失败。脚本自己发出的对照请求必须记录一次这样的恢复，所以措辞不同的宿主会失败，而不是悄悄通过。fixture provider 没有 provider 子 Agent，空闲 parent 的子 Agent 只由单元测试覆盖；套件的 Agent 总是刚创建的，所以在真实时钟下也无法端到端归档空闲 fixture。

因此 runner 随后会以 `WORKBOARD_TEST_CLOCK_OFFSET_MS`（40 天）重启 daemon，再运行一遍套件（此模式只运行端到端归档组），带 `--ui` 时再运行浏览器测试。偏移只影响 Workboard 自己的时钟，使空闲 fixture 被视为旧对话；它只在 Paseo home 是带 `.paseo-workboard-integration` 标记的临时目录时生效，否则静默使用真实时钟。要在自己带标记的测试 home 里运行该组，请用该变量启动 daemon，并为 `npm run test:integration` 导出同一变量；不要对个人 daemon 设置它。

runner 在偏移运行中还设置 `WORKBOARD_TEST_CLOCK_FILE=1`。此模式可在同一个带标记的临时 home 内写入固定文件 `.workboard-clock-offset-ms`，内容为非负整数毫秒偏移。时钟只接受向前的变化；文件缺失、内容无效或偏移减小时保留上次有效值。服务端时钟和快照偏移使用同一当前值。因此套件可以先观察零 Agent，再创建并删除真实 Agent，验证自动归档等待新的空观测期限，无需重启插件或修改持久化证据。未显式启用该测试模式时，不读取时钟文件。

同时使用无头 Chromium 操作真实 Paseo Web UI：

```sh
npx playwright install --only-shell chromium
npm run test:host -- --ui
```

Linux 可用 `npx playwright install --with-deps --only-shell chromium` 一并安装所需系统库。CI 会在 `.github/workflows/ci.yml` 中 `host` 矩阵列出的每个 Paseo 版本上执行这套检查。冒烟测试使用虚构任务和确定性的 fixture provider，覆盖视图切换与归档设置交互，遇到未捕获的页面错误会失败。不覆盖所有布局、主题、无障碍、移动客户端或 provider。

日志和失败截图、trace 写入 runner 打印的临时产物目录；可通过 `WORKBOARD_HOST_ARTIFACTS` 指定位置。CI 在失败时上传该目录，单独运行浏览器套件默认使用已忽略的 `test-results/`。

## 使用已运行的测试宿主

针对性调试时，`npm run test:integration` 会在按以下步骤准备、已运行的隔离 daemon 上执行 `*.integration.ts` 文件。

下列 shell 示例使用 POSIX 语法。harness 使用系统临时目录，并在 `/tmp` 存在时兼容该别名，不要求它必须存在。fixture 的 Git 命令使用隔离配置，不依赖个人签名、hook 或忽略规则。

## 准备临时 home

在系统临时目录下创建一次性 home，并写入只监听 loopback 的 daemon 配置。若 `6768` 已被占用，可改为另一个未占用的本地端口。

```sh
WORKBOARD_INTEGRATION_HOME="$(mktemp -d "${TMPDIR:-/tmp}/paseo-workboard.XXXXXX")"
export WORKBOARD_INTEGRATION_HOME
printf '%s\n' paseo-workboard-integration-v1 > "$WORKBOARD_INTEGRATION_HOME/.paseo-workboard-integration"
printf '%s\n' '{"daemon":{"listen":"127.0.0.1:6768","relay":{"enabled":false}},"pluginsEnabled":true}' > "$WORKBOARD_INTEGRATION_HOME/config.json"
```

以该 home 设置 `PASEO_HOME` 后启动目标 Paseo 版本，在其中安装当前 checkout，并确认插件正在运行：

```sh
PASEO_HOME="$WORKBOARD_INTEGRATION_HOME" paseo daemon start --home "$WORKBOARD_INTEGRATION_HOME"
paseo plugin install --home "$WORKBOARD_INTEGRATION_HOME" .
paseo status --home "$WORKBOARD_INTEGRATION_HOME" --json
```

在仓库根目录运行：

```sh
npm run test:integration
```

harness 会拒绝系统临时目录外的 home、缺失或错误的 marker、非 loopback 监听、未报告版本的 daemon，以及未运行的 Workboard 插件。测试运行期间，它不会启动、停止或回退到其它 daemon。

准备阶段会只在这个带 marker 的 home 中安装 `fixture-provider`。该 provider 提供确定性的历史和响应，绝不请求模型。套件会创建测试 workspace 并修改 fixture-provider 状态，绝不能使用个人或共享 daemon home。

## 停止并删除临时 home

删除 home 前必须先停止隔离 daemon。停止命令失败时，应保留目录用于排查；daemon 仍可能使用目录时不要删除。

```sh
if paseo daemon stop --home "$WORKBOARD_INTEGRATION_HOME"; then
  rm -rf "$WORKBOARD_INTEGRATION_HOME"
fi
```
