# TeamAI — 功能需求文档

> 本文档定义 TeamAI 多专家 Data Agent 协同平台的功能需求。  
> 技术栈、项目结构、部署指南见 [README.md](README.md)。

---

## 目录

- [F1: 多 Agent 对话界面](#f1-多-agent-对话界面)
- [F2: PM 编排机制](#f2-pm-编排机制)
- [F3: 语义层](#f3-语义层)
- [F4: 需求理解确认（Human-in-the-Loop）](#f4-需求理解确认human-in-the-loop)
- [F5: 上下文增强管线](#f5-上下文增强管线)
- [F6: 长期记忆（Adaptive Memory）](#f6-长期记忆adaptive-memory)
- [F7: 知识库（RAG）](#f7-知识库rag)
- [F8: Agent 配置体系](#f8-agent-配置体系)
- [F9: 执行可观测性](#f9-执行可观测性)
- [F10: 频道管理](#f10-频道管理)
- [F11: 定时任务](#f11-定时任务)
- [安全与权限](#安全与权限)
- [变更记录](#变更记录)

---

## F1: 多 Agent 对话界面

- 支持群聊（多 Agent）和私聊（单 Agent）两种模式
- 群聊支持隐私模式（Agent 只看到 @自己的消息）和开放模式
- 支持 @mention 指定 Agent 回答
- 支持消息转发（将一个 Agent 的回复转给另一个 Agent 评价）
- Markdown 渲染、代码高亮、SQL 代码块配色、消息搜索
- 移动端响应式布局

## F2: PM 编排机制

- PM Agent 收到跨领域问题时，自动拆解为多个子任务
- 以 JSON 指令格式输出任务分配：
  ```json
  {"action": "delegate", "tasks": [{"agent": "aws-expert", "task": "..."}], "summary_instruction": "..."}
  ```
- 系统解析 JSON 指令，将子任务并行分发给对应专家 Agent
- 每个专家在独立的会话通道中执行，互不干扰
- 所有子任务完成后，系统将结果打包发给 PM 汇总
- PM 生成结构化归因报告返回用户
- 前端任务看板实时展示子任务状态和耗时
- 支持中途取消任务
- 支持 Agent 间重定向（专家认为问题不在自己领域时建议转给其他专家）

## F3: 语义层

### F3.1: 数据湖侧 — Neptune Analytics 语义图

- 定时任务从 Glue Catalog 获取所有表结构
- 在 Neptune Analytics 图中创建 Table 和 Column 节点，建立 HAS_COLUMN 和 JOINS_ON 边
- 通过 Bedrock Titan Embed v2 生成向量，写入图节点
- 查询时：用户问题 → 向量搜索找到相关表/列 → 图遍历获取完整上下文（列定义、JOIN 关系）→ 生成 SQL → Athena 执行
- 图结构天然表达表间关系，多表 JOIN 查询比 YAML + RAG 方案更准确

### F3.2: Snowflake 侧 — Semantic Views 同步

- 定时任务从 Snowflake 读取所有 Semantic Views 的 JSON 定义
- 解析表、维度、指标、关系，写入 Neptune Analytics 图（`source=snowflake`）
- 先清后写模式：每次同步前删除 `source=snowflake` 的旧节点，再重新写入
- 与数据湖侧共用同一个 Neptune 图实例，PM 查图可看到全部数据源

### F3.3: 按需生成语义模型

- 用户可对 Agent 说"帮我生成 xxx 表的语义模型"
- Agent 从 Glue Catalog 获取 DDL + 示例数据，按 YAML 模板生成语义模型
- 输出到对话框，用户可编辑后保存到知识库

### F3.4: Snowflake Cortex Analyst API 集成

- 凌的需求确认阶段通过 Cortex Analyst REST API（`POST /api/v2/cortex/analyst/message`）生成 SQL
- 使用 `semantic_view` 参数引用 Snowflake Semantic View
- 认证：通过 snowflake-connector 获取 session token，再用 `Snowflake Token` 认证
- 生成的 SQL 不执行，只用于需求确认卡片展示和用户确认后的直接执行
- 确认后通过 snowflake-connector 直接执行 SQL（不走 cortex CLI）

![语义视图](images/semantic-view.png)

## F4: 需求理解确认（Human-in-the-Loop）

### 触发条件

- 用户提问 ≥ 8 字且非闲聊时，前端拦截消息，调用 intent-helper 进行需求分析
- 闲聊、确认语、简短回复不触发；用户可点"跳过，直接查"绕过确认

### SQL-first 流程

1. intent-helper 查询 Neptune 语义图（向量搜索 + 图遍历）获取数据上下文
2. 结合历史记忆中的 rule/preference
3. LLM 基于语义图上下文生成 SQL
4. 从 SQL 反向提取 8 维度确认卡片（卡片是 SQL 的业务语言翻译）

### 8 维度需求确认模板

每个维度对应 SQL 的一个子句：

| 维度 | SQL 子句 | 默认值 |
|------|----------|--------|
| 分析对象 | WHERE 主体 | — |
| 分析指标 | SELECT 聚合 | — |
| 过滤条件 | WHERE 附加 | （无） |
| 时间范围 | WHERE 时间 | （未限定） |
| 分组维度 | GROUP BY | — |
| 排序方式 | ORDER BY | 无排序 |
| 结果数量 | LIMIT | 全量 |
| 涉及数据 | FROM / JOIN | — |

### 三种依据等级

| 标记 | 含义 | 来源 |
|------|------|------|
| 🔵 数据字典依据 | 语义图里直接匹配到的字段定义 | Neptune 语义图 |
| 🟢 历史经验依据 | 语义图 + 用户之前确认过的规则/偏好 | Neptune + OpenSearch 记忆 |
| ⚪ 待用户确认 | 语义图有字段但用户没明确说过怎么用，Agent 推断的 | LLM 推断 |

### 多轮确认与记忆闭环

- 用户补充信息后重新调用 intent-helper，卡片实时更新
- 确认后将确认的 SQL + 原始提问一起发给 Agent 执行（不重新生成）
- extract-helper 对比原始提问和最终确认的 items，用户补充的条件自动提炼为 preference 存入记忆
- 下次同类问题自动应用为 🟢 历史经验依据

### PM 群聊合并卡片

- @pm 提问时，intent-helper 同时调 datalake（Neptune + LLM）和 snowflake（Cortex Analyst）生成两段 SQL
- 合并为一张卡片展示 Nova 和凌两个子卡片
- 确认后 TeamAI 直接通过 API 将确认的 SQL 分别发给 Nova 和凌执行（不经过 PM 的 WebSocket delegate）
- 两边结果回来后发给 PM 汇总

## F5: 上下文增强管线

每条消息发送给 Agent 之前，系统并行执行：

| 检索源 | 方式 | 参数 |
|--------|------|------|
| 历史记忆 | OpenSearch kNN 搜索 | topK=3, score>0.4, 按类型权重 × 时间衰减排序 |
| 知识库 | Bedrock Knowledge Base RAG | topK=3, score>0.3, 按 Agent 隔离 |

- 检索结果以前缀形式拼接到原始消息中
- 检索超时 5 秒自动降级（不阻塞对话）

## F6: 长期记忆（Adaptive Memory）

### 存储

- Amazon OpenSearch Serverless 向量索引（Bedrock Titan Embed v2，1024 维）
- 直接 kNN 搜索，无第三方 Memory 框架依赖
- 记忆按 Agent 维度隔离（user_id 字段过滤）

### 记忆类型体系（v4）

纯规则分类，零 LLM 调用写入：

| 类型 | 含义 | 权重 | 衰减 |
|------|------|------|------|
| 📌 rule | 业务规则、指标定义、业务逻辑澄清 | 1.8 | 永不 |
| ❤️ preference | 展示风格、格式偏好 | 1.0 | 永不 |
| 📸 snapshot | 查询需求描述 + SQL | 0.8 | 30 天 |
| 💬 other | 兜底 | 0.5 | 7 天 |

### 写入路径

extract-helper 定期从对话日志提取（fire-and-forget）：

- 程序化提取 snapshot：从 session jsonl 的 toolCall + toolResult 中直接提取需求描述和 SQL，不需要 LLM
- LLM 提炼 rule/preference：从用户消息中严格筛选业务规则和偏好，一次性分析请求不提取
- 所有类型直接 embed + 写入 OpenSearch（`/add-raw`），不经过 LLM fact extraction
- 定时任务对话标记 `scheduled=true`，跳过提取

### 读取路径

```
用户提问 → Bedrock Titan Embed → kNN 搜索 OpenSearch
  → finalScore = vectorScore × typeWeight × decayFactor
  → rule/preference 始终注入，snapshot 按相关性和衰减排序
  → 注入到用户消息前缀
```

### MEMORY.md（精选记忆）

每个 Agent 可维护一份精选知识文件，合并到 SOUL.md 中每次对话自动加载。用于固化核心业务规则。

### Auto Dream（记忆整理）

- 定时任务（每天凌晨 2 点）对每个 Agent 的记忆做整理
- LLM 分析所有记忆，执行：
  - 合并重复（相同内容合并为一条）
  - 升级类型（出现 3 次以上的 preference → rule）
  - 清理噪音（无实际价值的记忆删除）
  - 精炼文本
- 参考 Claude Code 的 AutoDream 设计，适配 Data Agent 的单 session 长期运行模式

### 管理界面

- 按类型 / 按领域双 Tab 视图
- 类型视图：展示四种类型，显示权重和衰减配置
- 记忆详情展开：完整文本、SQL 代码块、创建时间
- 支持记忆的 CRUD 操作

![记忆治理](images/memory-governance.png)

## F7: 知识库（RAG）

- 每个 Agent 有独立的知识空间（S3 前缀: `{agentId}/`）
- 通过元数据过滤实现 Agent 间知识隔离
- PM 可检索所有 Agent 的知识（不加过滤条件）
- 支持文件上传（最大 150MB）、删除、列表
- 支持 API 覆盖更新（upsert）— 用于定时任务自动刷新
- 上传/删除后自动触发 Knowledge Base 重新向量化
- 中文文件名支持（latin1 → utf8 转码）

## F8: Agent 配置体系

每个 Agent 通过一组 Markdown 文件定义：

| 文件 | 用途 |
|------|------|
| `SOUL_PRIVATE.md` | 人设、推理风格、协作行为、领域知识 |
| `IDENTITY.md` | 名字、角色、emoji、签名 |
| `TOOLS.md` | 工具定义 |
| `MEMORY.md` | 精选记忆，合并到 SOUL.md 中每次对话自动加载 |
| `skills/` | 符号链接到全局 Skill 库 |

- 支持三层 SOUL 合并：GLOBAL_SOUL.md（全局共享）+ SOUL_PRIVATE.md（专家独有）+ MEMORY.md（精选记忆）
- 支持在线编辑 SOUL / IDENTITY / TOOLS / MEMORY / 模型 / Skills（通过 Web 界面）
- 支持动态创建和删除 Agent（通过 API）

## F9: 执行可观测性

每次 Agent 回复时，展示本次执行的元信息：

| 指标 | 说明 |
|------|------|
| memory | 命中的历史记忆条数 |
| bedrock kb | 检索的知识库文档条数 |
| tool | 调用的工具次数 |
| 耗时 | 总执行时间（秒） |

用户可直观看到 Agent 的回答基于什么上下文得出。

## F10: 频道管理

- 支持群聊频道（多 Agent）和私聊频道（单 Agent）
- 群聊支持隐私模式和开放模式切换
- 支持频道的创建、重命名、删除
- 支持频道成员管理（添加/移除 Agent）
- 对话历史按频道持久化（JSONL 格式）
- 支持清空频道历史

## F11: 定时任务

- 支持 Cron 表达式调度
- 定时向指定 Agent 发送消息触发任务
- 定时任务对话标记 `scheduled=true`，不触发记忆提取
- 支持创建、编辑、启用/禁用、手动触发、删除

当前定时任务：

| 频率 | 任务 | 说明 |
|------|------|------|
| 每天 | 数据湖语义图同步 | Glue Catalog → Neptune 图节点/边 + 向量 |
| 每天 | Snowflake 语义图同步 | Semantic Views → Neptune（先清后写） |
| 每 60s | 记忆提取 | extract-helper 扫描对话日志，提取 snapshot + rule/preference |
| 每天 2:00 | Auto Dream | 对 aws-expert、snowflake-expert、main 执行记忆合并、升级、清理 |

## 安全与权限

> **注意**：本项目为 Demo 演示用途，未在安全层面做生产级加固。如需部署到生产环境，请自行补充 HTTPS、OAuth、网络隔离、审计日志等安全措施。

| 层级 | 认证方式 | 说明 |
|------|----------|------|
| TeamAI Web 界面 | HTTP Basic Auth | 用户名/密码通过环境变量配置 |
| OpenClaw Gateway | Bearer Token | 环境变量 `GATEWAY_TOKEN` |
| 知识库 | S3 前缀 + 元数据过滤 | 按 Agent 隔离 |
| 记忆 | user_id 字段过滤 | 按 Agent 隔离 |
| 本地 API | 免认证 | 仅 127.0.0.1 访问 |
| Snowflake | Programmatic Access Token | 环境变量 `SF_PAT` |

所有凭证通过 `.env` 文件注入，不硬编码在代码中。

## 附件

- [AWS 基础设施配置指南](requirements-aws-infra.md) — IAM 角色、Bedrock 模型开通、Neptune Analytics、S3、EC2 部署
- [前端交互规范](requirements-frontend.md) — 页面结构、组件设计、交互流程、视觉规范

---

## 变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-04-10 | v1.3 | 新增 F3.4 Cortex Analyst API；F4 新增 PM 合并卡片和直接 API 分发；F6 新增 Auto Dream；F11 新增 Auto Dream 定时任务 |
| 2026-04-08 | v1.2 | F4 升级为 SQL-first 流程 + 8 维度确认模板 + 三种依据等级 + 记忆闭环 |
| 2026-04-06 | v1.1 | F6 记忆类型体系升级为 v4（纯规则分类，零 LLM 写入）；新增 extract-helper 写入路径 |
| 2026-04-03 | v1.0 | 初始版本，F1-F11 功能定义 |
