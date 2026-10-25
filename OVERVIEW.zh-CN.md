# Workboard

Workboard 将活跃的 Paseo workspace 和尚未关联 workspace 的想法放在任务看板与分组列表中。一个活跃 workspace 对应一个任务；只有标题的草稿在创建或关联 workspace 前不占用 workspace。任务状态由你决定，Agent 完成一轮回复不会自动将任务标为已完成。

看板可按项目分组，每个项目保留自己的状态列。在卡片上设置高、普通、低优先级，再选择按优先级排序或返回已保存的默认顺序。在设置中可自定义各档名称和颜色，任务的优先级关系保持不变。分组、排序与项目折叠状态按客户端和主机记忆。

移动任务会更新其受管理的 Paseo 状态标签；在 Paseo 中修改这些标签也会更新看板，普通标签保持不变。可选的状态标签互斥功能可在识别出新状态时移除旧标签，无法判断最新状态的冲突仍需手动处理。看板与列表共享任务、筛选和保存的排序。可按项目、待关注状态、Agent 活动、PR/MR 条件或最后对话日期筛选。PR/MR 与 CI 信息由 Paseo 提供，Workboard 不单独查询代码托管平台。

设置中可以调整分组及默认值、将进行中的 workspace 置顶到侧边栏，或启用自动归档。自动归档默认关闭，已完成和已废弃各自有独立开关与等待期限；两个都关闭即停止自动归档。期限控件始终显示，关闭规则时也可保存期限，不会因此开启规则。变更使任务到期时，会先列出全部候选，确认后才保存；取消保留原设置。启用后，每条规则等待最后一次可证明的对话超过对应期限，并在调用 Paseo 原生归档前检查 Agent、terminal、对话和 Git 状态。provider 子 Agent 清单不完整、子 Agent 历史无法证明上界，或已观察的子 Agent 从清单消失时，都会暂停自动归档；卡片仍保留已知的对话显示时间。订阅恢复后，须重新枚举子 Agent 才能归档。未归档父 Agent 的子 Agent 枚举失败后，一分钟后重试。原生归档可能停止 Agent 和 terminal、移除托管 worktree；移除后 Workboard 无法将其恢复。

Workboard 需要 Paseo 0.11.0 或更高版本。daemon 端复用所选宿主的 Paseo 登录会话，读取 workspace、标签、对话证据及 Git 安全状态，保存任务设置，并执行请求的宿主操作。视图偏好与筛选条件按宿主保存在客户端本地。开始任务不会创建 Agent 或发送 prompt。插件在 daemon 宿主上以受信任代码运行。各版本的升级说明见 [GitHub Releases](https://github.com/fxbing/paseo-workboard/releases)；设置与完整用法见 [README](README.zh-CN.md) 和[使用指南](https://github.com/fxbing/paseo-workboard/blob/main/docs/zh-CN/user-guide.md)。
