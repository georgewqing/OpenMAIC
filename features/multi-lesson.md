# 单元多课大纲(多课大纲 / Multi-Lesson)

面向"一个单元多节课"的教学准备:一次生成整单元的课时大纲 → 保存 → 从大纲页进入 →
**逐课、逐页**选择性生成课件,每种页面类型有各自的重新生成表单。

## 入口

- 工作区首页(Pro workspace)composer 下方:**单元多课大纲:一次规划整单元,逐课逐页选择性生成**
- 直接访问 `/multi-lesson/new`(新建)、`/multi-lesson/<folderId>`(课程大纲页)

## 数据映射

| 概念 | 存储 | 说明 |
| --- | --- | --- |
| 单元课程 | `document_folders` 一行 | 容器;标题在 plan 里为准 |
| 课时 | 该 folder 下一个 `document_stages` | stage 名称=课时标题,持有该课大纲与已生成页面 |
| 页面 | `document_scenes` 行 | **没有行 = 尚未生成**;有行 = 已生成 |
| 课时大纲 | `document_outlines`(stage_id) | `SceneOutline[]`,与经典单课大纲同构 |
| 单元索引 | `multi_lesson_courses` 表 | owner_id + folder_id + plan jsonb,记录课时↔stage 绑定 |

`multi_lesson_courses` 是应用自有的小表(惰性建表),因为 folder/stage 没有承载
"单元元数据 + 课时绑定"的字段。

## API

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/multi-lesson/plan` | POST | 需求 → LLM 生成整单元大纲(不落库)。走 `course.outline` 槽位 |
| `/api/multi-lesson/courses` | GET | 列出本 owner 的多课课程 |
| `/api/multi-lesson/courses` | POST | 校验并落库:建 folder + 每课一个 outline-only stage |
| `/api/multi-lesson/courses/[folderId]` | GET | 课程 plan + 每页状态(planned / generated / stale) |
| `/api/multi-lesson/courses/[folderId]` | PUT | 编辑大纲(改标题/类型/顺序/增删页与课)。删已生成页或非空课需 `allowDeleteGenerated`,否则 409 `PLAN_EDIT_CONFLICT` 并列出将被删除的内容 |
| `/api/stages/[id]/scenes/generate` | POST | **直接生成/重生成单页**(不经 agent session) |

### 单页生成路由

复用 agent 工具 `generate_scene` 的同一条链路:

```
generateSceneContent → generateSceneActions → buildCompleteScene → putScene
```

- 请求体:`{ order, type, title, brief, keyPoints?, outlineId?, instruction?(仅 slide),
  quizConfig?, widgetType?, widgetOutline?, pblConfig? }`
- `instruction` 只对 slide 有效:作为"局部修改指令",以现有画布为 baseline 重生成
- 请求 abort **不**绑定给生成过程:慢后端下用户离开页面也不会中断服务端生成,
  回来后靠 manifest/状态接口对账
- 失败语义与 agent 工具一致:内容解析失败返回 `GENERATION_FAILED` 且**不写入**任何内容

## 生成速度(实测,dev 环境,火山后端)

| 页面类型 | 耗时 |
| --- | --- |
| slide | 约 8 分钟(3 次 600s 超时后第 4 次成功) |
| 复杂 interactive(diagram) | 10 分钟以上,常撞代理 600s 上限 |
| minimax 后端 | 同等任务约 194 秒 |

代理侧已按服务配置等待时间(小小学伴 600s)。若要提速,换 minimax/deepseek 后端即可,
前端无需改动。

## 分类型重新生成表单

| 类型 | 可调项 |
| --- | --- |
| slide | 标题 / 教学意图 / 内容要点;已生成时可选"局部修改指令" |
| quiz | 题目数量、难度(易/中/难)、题型(单选/多选/简答) |
| interactive | 5 种形式(仿真模拟/图示流程图/代码挑战/游戏/3D 可视化)+ 核心概念 |
| pbl | 议题数、情景扮演开关、情景简述、目标技能 |

## 已知限制

- 界面文案为中文硬编码,尚未接入 i18n(`lib/i18n/locales/zh-CN.json`)
- "stale"(大纲类型变了但页面还是旧的)只做标记,需用户手动重新生成该页
- 整课生成由前端逐页串行编排(单并发,避开后端突发限流);进程/页面中断后从失败页继续
- 尚未做:素材引用、语音(TTS)、视频导出与多课流程的联动
