# TeamAI — Multi-Expert Data Agent Platform

基于 [OpenClaw](https://github.com/aws-samples/openclaw) 构建的多 Agent 协同数据分析平台。多个领域专家 Agent 在同一对话界面中协作，通过 PM 编排完成跨数据平台的企业级分析任务。

![架构图](images/architecture.png)

## 核心能力

| 能力 | 说明 |
|------|------|
| Multi-Expert Collaboration | PM Agent 拆解跨领域问题，并行分发给专家，汇总归因报告 |
| Human-in-the-Loop | SQL-first 需求确认：LLM 生成 SQL → 反推 8 维度卡片 → 用户确认后执行 |
| Adaptive Memory | 跨 session 长期记忆，按类型分级（rule/preference/snapshot），权重 × 衰减排序 |
| Semantic Knowledge Graph | Neptune Analytics 语义图：向量搜索定位表 → 图遍历发现 JOIN 路径 |
| Auto Dream | 定时记忆整理：LLM 分析 → 合并重复 → 升级类型 → 清理噪音 |

![Demo](images/demo-screenshot.png)

## Agent 团队

| Agent | 角色 | 数据平台 | SQL 生成方式 |
|-------|------|----------|-------------|
| Alex (PM) | 项目经理 | — | 纯编排，不查数据 |
| Nova (aws-expert) | 数据湖分析师 | Amazon S3 + Athena | Neptune 语义图 + LLM |
| 凌 (snowflake-expert) | 数据仓库分析师 | Snowflake | Cortex Analyst API |
| 小克 (main) | 通用助理 | — | — |

## 技术栈

- **Agent 运行时**：OpenClaw Gateway（EC2）
- **模型推理**：Amazon Bedrock（Claude Sonnet 4.5）
- **长期记忆**：Amazon OpenSearch Serverless + Bedrock Titan Embed v2
- **知识库**：Amazon Bedrock Knowledge Base + S3
- **语义图**：Amazon Neptune Analytics（向量搜索 + 图遍历）
- **数据湖**：Amazon S3 + Athena + Glue Catalog
- **数据仓库**：Snowflake + Cortex AI + Semantic Views
- **前端**：原生 HTML/JS，WebSocket 实时通信

## 项目结构

```
teamai/
├── src/                          # 核心代码
│   ├── server.js                 # TeamAI 后端（Express + WebSocket + PM 编排）
│   ├── intent-helper.py          # 需求确认（SQL-first + 8 维度卡片 + Cortex Analyst）
│   ├── extract-helper.py         # 记忆提取（snapshot 程序化 + LLM rule/preference）
│   ├── auto-dream.py             # 记忆整理（合并/升级/清理）
│   ├── memory-service.py         # 记忆服务（OpenSearch + Bedrock Embed）
│   ├── memory-helper.js          # 记忆客户端（server.js 依赖）
│   ├── knowledge-helper.js       # 知识库客户端（Bedrock KB + S3）
│   └── neptune_semantic_graph.py # Neptune 语义图操作库
├── public/
│   └── index.html                # 前端（多 Agent 对话 + 需求确认卡片 + 记忆管理）
├── sync/                         # 数据同步定时任务
│   ├── refresh_datalake_graph.py       # Glue Catalog → Neptune 语义图
│   ├── refresh_snowflake_graph.py      # Snowflake Semantic Views → Neptune 语义图
│   ├── refresh_datalake_metadata.py    # 数据湖元数据刷新
│   ├── refresh_snowflake_metadata.py   # Snowflake 元数据刷新
│   ├── refresh_datalake_semantic_model.py  # 语义模型生成
│   └── refresh_snowflake_semantic_views.py # Semantic Views 同步
├── agents/                       # Agent 配置（Markdown 即配置）
│   ├── aws-expert/               # Nova — SOUL_PRIVATE.md, MEMORY.md, IDENTITY.md, TOOLS.md
│   ├── snowflake-expert/         # 凌
│   ├── pm/                       # Alex
│   └── main/                     # 小克
├── images/                       # 架构图、截图
├── .env.example                  # 环境变量模板
├── .gitignore
├── package.json
├── requirements-teamai-data-agent.md   # 功能需求文档（F1-F11）
├── requirements-aws-infra.md           # AWS 基础设施配置指南
└── requirements-frontend.md            # 前端交互规范
```

## 快速开始

### 前置条件

- Amazon EC2 实例（已部署 OpenClaw Gateway）
- Amazon Bedrock 模型访问权限（Claude Sonnet 4.5, Titan Embed v2）
- Amazon OpenSearch Serverless 集合
- Amazon Neptune Analytics 图实例
- Snowflake 账号 + Programmatic Access Token（可选，仅凌需要）

### 部署

```bash
# 1. 克隆代码
git clone https://github.com/chawnsj-sys/teamai.git
cd teamai

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入实际值

# 3. 安装依赖
cd src && npm install

# 4. 启动服务
node src/server.js          # TeamAI 后端 :3001
python3 src/memory-service.py  # 记忆服务 :3005

# 5. 访问
open http://localhost:3001
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `GATEWAY_TOKEN` | OpenClaw Gateway 认证 Token |
| `AUTH_USER` / `AUTH_PASS` | TeamAI Web 界面 Basic Auth |
| `NEPTUNE_GRAPH_ID` | Neptune Analytics 图实例 ID |
| `SF_ACCOUNT` / `SF_USER` / `SF_PAT` | Snowflake 连接凭证 |
| `KB_ID` / `DS_ID` / `KB_S3_BUCKET` | Bedrock Knowledge Base 配置 |
| `ATHENA_S3_BUCKET` | Athena 查询结果 S3 存储桶 |

## 架构概览

```
用户 → TeamAI 前端（WebSocket）
         │
         ├── 需求确认（intent-helper）
         │     ├── Neptune 语义图（向量搜索 + 图遍历）
         │     ├── Cortex Analyst API（Snowflake 侧）
         │     └── 历史记忆（OpenSearch kNN）
         │
         ├── 上下文增强
         │     ├── 记忆检索（OpenSearch）
         │     └── 知识库检索（Bedrock KB）
         │
         ├── OpenClaw Gateway → Agent Runtime
         │     ├── SOUL.md + MEMORY.md + TOOLS.md
         │     ├── LLM 推理（Bedrock Claude）
         │     └── 工具执行（Athena / Snowflake / AWS CLI）
         │
         └── 后台任务
               ├── extract-helper（记忆提取，每 60s）
               ├── auto-dream（记忆整理，每天 2:00）
               └── sync（语义图同步，每天）
```

## 需求确认流程（Human-in-the-Loop）

```
用户提问 → intent-helper 查语义图 + 记忆
  → LLM 生成 SQL
  → 从 SQL 反推 8 维度确认卡片
  → 每项标注依据等级：🔵 数据字典 / 🟢 历史经验 / ⚪ 待确认
  → 用户确认或补充
  → 确认后执行 SQL
  → 用户补充的条件自动提炼为记忆
  → 下次同类问题自动应用
```

## 记忆类型体系

| 类型 | 权重 | 衰减 | 说明 |
|------|------|------|------|
| 📌 rule | 1.8 | 永不 | 业务规则、指标口径 |
| ❤️ preference | 1.0 | 永不 | 展示偏好、默认条件 |
| 📸 snapshot | 0.8 | 30 天 | 查询 SQL + 需求描述 |
| 💬 other | 0.5 | 7 天 | 兜底，不确定的先存着 |

召回排序：`finalScore = vectorScore × typeWeight × decayFactor`

## 文档

- [功能需求文档](requirements-teamai-data-agent.md) — F1-F11 完整功能定义
- [AWS 基础设施指南](requirements-aws-infra.md) — IAM、Bedrock、Neptune、S3、EC2 配置
- [前端交互规范](requirements-frontend.md) — 页面结构、组件设计、视觉规范

## 相关项目

- [OpenClaw](https://github.com/aws-samples/openclaw) — 多 Agent 运行时
- [Snowflake Cortex AI](https://www.snowflake.com/en/developers/guides/getting-started-with-snowflake-cortex-ai/) — Snowflake 原生 AI
- [Kiro](https://kiro.dev) — AI IDE，本项目的开发工具

## 安全说明

本项目为 Demo 演示用途，未在安全层面做生产级加固。如需部署到生产环境，请自行补充 HTTPS、OAuth、网络隔离、审计日志等安全措施。

## License

MIT
