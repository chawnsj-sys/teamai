# TeamAI — 多专家 Data Agent 协同平台 需求说明

## 项目概述

基于 OpenClaw Gateway 构建的多 Agent 协同数据分析平台。多个领域专家 Agent 在同一个对话界面中协作，通过 PM 编排完成跨领域的企业数据分析任务。

## 技术栈

- **Agent 运行时**：OpenClaw Gateway（开源，部署在 Amazon EC2）
- **前端/中间件**：TeamAI（Node.js + Express + WebSocket）
- **模型推理**：Amazon Bedrock（Claude Sonnet 4.5）
- **长期记忆**：Amazon Bedrock AgentCore Memory
- **知识库**：Amazon Bedrock Knowledge Base + S3 + OpenSearch Serverless
- **数据湖**：Amazon S3 + Athena + Glue Catalog
- **语义图**：Amazon Neptune Analytics（向量搜索 + 图遍历，存储数据湖表关系和语义）
- **数据仓库**：Snowflake + Cortex AI + Semantic Views

## Agent 团队

| Agent | ID | 角色 | 负责领域 | 核心 Skill |
|-------|-----|------|----------|-----------|
| 小克 | main | 通用助理 | 日常问答、信息检索 | exa-web-search-free |
| Alex | pm | 项目经理 | 任务拆解、分发、汇总 | 无（纯编排） |
| Nova | amazon-expert | Amazon 数据专家 | 用户行为分析（数据湖） | aws-cli, datalake_query, gen-semantic-model |
| 凌 | snowflake-expert | Snowflake 数据专家 | 营销效果、产品口碑、供应链 | snowflake-cortex-code |

## 核心功能需求

### F1: 多 Agent 对话界面

- 支持群聊和私聊两种模式
- 群聊支持隐私模式（Agent 只看到 @自己的消息）和开放模式
- 支持 @mention 指定 Agent 回答
- 支持消息转发（将一个 Agent 的回复转给另一个 Agent 评价）
- Markdown 渲染、代码高亮、消息搜索
- 移动端响应式布局

### F2: PM 编排机制

- PM Agent 收到跨领域问题时，自动拆解为多个子任务
- 以 JSON 指令格式输出任务分配：`{action: "delegate", tasks: [{agent, task}], summary_instruction}`
- 系统解析 JSON 指令，将子任务并行分发给对应专家 Agent
- 每个专家在独立的会话通道中执行
- 支持 Agent 间重定向（专家认为问题不在自己领域时建议转给其他专家）
- 所有子任务完成后，系统将结果打包发给 PM 汇总
- PM 生成最终报告返回给用户
- 前端任务看板实时展示子任务状态和耗时
- 支持中途取消任务

### F3: 上下文增强管线

- 每条消息发送给 Agent 之前，系统并行执行：
  - 从 AgentCore Memory 检索该 Agent 的相关历史记忆（topK=3，score>0.4）
  - 从 Bedrock Knowledge Base 检索该 Agent 领域内的知识文档（topK=3，score>0.3）
- 检索结果以前缀形式拼接到原始消息中
- 检索超时 5 秒自动降级（不阻塞对话）

### F4: 长期记忆（AgentCore Memory）

- 每次 Agent 回复后，系统异步将问答对存入 AgentCore Memory（定时任务对话除外）
- 记忆按 Agent 维度隔离（sessionId: teamai-{agentId}）
- PM 可检索所有 Agent 的记忆（namespace: /facts/）
- 其他 Agent 只检索自己的记忆（namespace: /summaries/）
- 支持记忆的 CRUD 操作（列表、创建、更新、删除）
- 支持记忆搜索
- **定期记忆生命周期管理**（每天凌晨）：
  - 第一步：从 TeamAI history 提炼前一天的对话要点，补写入 AgentCore Memory
  - 第二步：由 LLM 自动整理每个 Agent 的记忆 — 合并重复、清理过时、归纳业务规则
- **定时任务对话不写入 Memory**：scheduled 标记的对话跳过 storeMemory，避免刷新记录污染记忆
- **MEMORY.md（精选记忆）**：每个 Agent 可维护一份精选知识文件，合并到 SOUL.md 中每次对话自动加载。支持在 Agent Profile 面板的设置 Tab 中在线编辑

### F5: 知识库（Bedrock Knowledge Base + RAG）

- 每个 Agent 有独立的知识空间（S3 前缀: {agentId}/）
- 通过元数据过滤实现 Agent 间知识隔离
- PM 可检索所有 Agent 的知识（不加过滤条件）
- 支持文件上传（最大 150MB）、删除、列表
- 支持 API 覆盖更新（upsert）— 用于定时任务自动刷新
- 上传/删除后自动触发 Knowledge Base 重新向量化（StartIngestionJob）
- 中文文件名支持（latin1 → utf8 转码）

### F6: 语义层

#### F6.1: Snowflake 侧 — Semantic Views 同步
- 定时任务（每小时）从 Snowflake 读取所有 Semantic Views 的定义
- 通过 Cortex CLI 执行 `DESCRIBE SEMANTIC VIEW` 获取详细内容
- 将维度、指标、表关系、业务别名等语义信息同步到知识库
- 存储为 `snowflake_semantic_views.md`

#### F6.2: 数据湖侧 — Neptune Analytics 语义图
- 定时任务（每天）从 Glue Catalog 获取所有表结构
- 在 Neptune Analytics 图中创建 Table 和 Column 节点，建立 HAS_COLUMN 和 JOINS_ON 边
- 通过 Titan Embed v2 生成向量，写入图节点（vectors.upsert）
- 查询时：用户问题 → 向量搜索找到相关表/列 → 图遍历获取完整上下文（列定义、JOIN 关系）→ 生成 SQL → Athena 执行
- 相比 YAML + RAG 方案，图结构天然表达表间关系，多表 JOIN 查询更准确

#### F6.3: 按需生成语义模型（gen-semantic-model Skill）
- 用户可以对 Amazon 专家说"帮我生成 xxx 表的语义模型"
- Agent 从 Glue Catalog 获取 DDL + 示例数据
- 按 YAML 模板生成语义模型
- 输出到对话框，用户可编辑后保存到知识库

### F7: Agent 配置体系

- 每个 Agent 通过一组文件定义：
  - **SOUL_PRIVATE.md** — 人设、推理风格、协作行为、领域知识
  - **IDENTITY.md** — 名字、角色、emoji、签名
  - **TOOLS.md** — 工具定义
  - **MEMORY.md** — 精选记忆（业务规则、必须记住的知识点），合并到 SOUL.md 中每次自动加载
  - **skills/** — 符号链接到全局 Skill 库
- 支持三层 SOUL 合并：GLOBAL_SOUL.md（全局共享）+ SOUL_PRIVATE.md（专家独有）+ MEMORY.md（精选记忆），运行时自动合并
- 支持在线编辑 SOUL/IDENTITY/TOOLS/MEMORY/模型/Skills（通过 Web 界面）
- 支持动态创建和删除 Agent（通过 API）

### F8: Skill 体系

- 每个 Skill 是一个独立目录，包含 SKILL.md（frontmatter + 使用说明）
- 全局 Skill 库，通过符号链接按需挂载给不同 Agent
- 当前 Skill 列表：
  - agent-browser — 浏览器控制
  - agentcore-memory — 长期记忆操作
  - aws-cli — Amazon CLI 操作
  - datalake_query — 数据湖智能查询（Neptune 图查询 → SQL 生成 → Athena 执行）
  - gen-semantic-model — 数据湖语义模型生成
  - snowflake-cortex-code — Snowflake Cortex 操作
  - gpu-management — GPU 集群管理
  - exa-web-search-free — 网页搜索
  - task-status — 任务状态管理
  - kiro-cli — Kiro CLI 集成

### F9: 频道管理

- 支持群聊频道（多 Agent）和私聊频道（单 Agent）
- 群聊支持隐私模式和开放模式切换
- 支持频道的创建、重命名、删除
- 支持频道成员管理（添加/移除 Agent）
- 对话历史按频道持久化（JSONL 格式）
- 支持清空频道历史

### F10: 定时任务

- 支持 Cron 表达式调度
- 定时向指定 Agent 发送消息触发任务
- 定时任务对话标记 scheduled=true，不写入 AgentCore Memory
- 支持创建、编辑、启用/禁用、手动触发、删除
- 当前定时任务：
  - 每天：同步数据湖表结构到 Neptune Analytics 语义图（Glue → 图节点/边 + 向量）
  - 每天：同步 Snowflake 语义视图到知识库
  - 每天 2:00：记忆生命周期管理（提炼前一天对话 + 整理 Memory）
  - 每天 8:00：天气查询

### F11: 文件上传

- 支持图片（jpg/png/gif/webp）、视频（mp4/mov/webm）、文档（pdf/doc/docx/txt/csv/xlsx/zip）
- 最大 150MB
- 上传后返回 URL，可在对话中引用

### F12: 流式事件推送

- Agent 推理过程通过 WebSocket 实时推送
- 事件类型：思考中（lifecycle.start）、工具调用（tool）、内容流（content/assistant）、完成（lifecycle.end）
- 前端可展示 Agent 当前状态（thinking / working / online / offline）
- 支持查看 Agent 的工具调用历史（session 文件解析）

## 数据领域

### 数据湖（Amazon 专家负责）
- 数据库：datalake_demo
- 表：app_sessions（用户会话）、app_user_events（用户行为事件）
- 查询方式：Neptune Analytics 语义图查询 → SQL 生成 → Athena 执行
- 语义层：Neptune Analytics 图（Table/Column 节点 + JOINS_ON 边 + Titan Embed 向量）
- Graph ID：<your-graph-id>（建议 us-east-1，16GB，向量维度 1024）

### Snowflake 数据仓库（Snowflake 专家负责）
- 数据库：MANUFACTURING_DEMO，Schema：ANALYTICS
- 业务领域：
  - **营销效果分析**：渠道 × 活动 × 市场维度的花费、收入、ROI、转化和渠道归因（MKT_* 表）
  - **产品口碑分析**：品类 × 市场维度的用户评价，含情感标签（MKT_PRODUCT_REVIEWS）
  - **供应链管理**：供应商信息，含国别、质量评分、准时率（ERP_* 表）
- Semantic Views：MARKETING_ANALYTICS、ERP_OPERATIONS、SALES_ORDER_BUSINESS
- 查询方式：Cortex CLI（cortex search / query / complete）+ Cortex Agent（QUICKSUITE）

## 安全与权限

- TeamAI Web 界面：Basic Auth
- OpenClaw Gateway：Bearer Token
- 知识库：按 Agent 隔离（S3 前缀 + 元数据过滤）
- 记忆：按 Agent 隔离（sessionId）
- 本地 API 调用免认证（127.0.0.1）

## 部署架构

- Amazon EC2 实例
- TeamAI 服务：端口 3001（systemd: multi-chat.service）
- OpenClaw Gateway：端口 3000（systemd: clawdbot-gateway.service）
- Agent 配置：~/clawd/agents/（SOUL.md / IDENTITY.md / TOOLS.md / skills/）
- 全局 Skill 库：~/clawd/skills/
- 数据目录：~/multi-chat/history/（对话历史 + 频道配置 + 任务 + 定时任务）

## 附件

- [AWS 基础设施配置指南](requirements-aws-infra.md) — IAM 角色、Bedrock 模型开通、Neptune Analytics 图实例、S3 存储桶、EC2 部署等
- [前端交互规范](requirements-frontend.md) — 页面结构、组件设计、交互流程、响应式布局、视觉规范
