# TeamAI — AWS 基础设施配置指南

本文档描述 TeamAI 平台所需的 AWS 资源及配置步骤。所有资源建议部署在同一 Region（如 us-east-1）。

## 1. EC2 实例

### 规格建议
- 实例类型：t3.medium 或以上（2 vCPU, 4GB RAM）
- 操作系统：Ubuntu 22.04 LTS
- 存储：30GB gp3
- 安全组入站规则：
  - SSH (22)：限制为管理员 IP
  - HTTP (3000)：OpenClaw Gateway（建议仅内网或通过 ALB 暴露）
  - HTTP (3001)：TeamAI 服务（建议仅内网或通过 ALB 暴露）

### 软件依赖
```bash
# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Python 3.10+
sudo apt-get install -y python3 python3-pip

# AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install

# Snowflake Cortex CLI（如需 Snowflake 集成）
pip3 install snowflake-connector-python
```

### OpenClaw Gateway 安装
参考官方文档：[Introducing OpenClaw on Amazon Lightsail](https://aws.amazon.com/blogs/aws/introducing-openclaw-on-amazon-lightsail-to-run-your-autonomous-private-ai-agents/)

```bash
# 安装 OpenClaw
npm install -g @anthropic/clawdbot

# 初始化（生成 ~/.clawdbot/ 目录结构）
clawdbot init
```

## 2. IAM 角色

### EC2 实例角色

创建 IAM Role 并附加到 EC2 实例，包含以下策略：

#### 策略 1：Bedrock 访问
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:*::foundation-model/*"
    },
    {
      "Sid": "BedrockAgentCore",
      "Effect": "Allow",
      "Action": [
        "bedrock:CreateAgentCoreMemory",
        "bedrock:GetAgentCoreMemory",
        "bedrock:ListAgentCoreMemories",
        "bedrock:DeleteAgentCoreMemory",
        "bedrock:UpdateAgentCoreMemory",
        "bedrock:RetrieveMemoryRecords",
        "bedrock:ListMemoryRecords",
        "bedrock:DeleteMemoryRecord",
        "bedrock:BatchUpdateMemoryRecords",
        "bedrock:BatchCreateMemoryRecords",
        "bedrock:CreateEvent"
      ],
      "Resource": "*"
    },
    {
      "Sid": "BedrockKnowledgeBase",
      "Effect": "Allow",
      "Action": [
        "bedrock:Retrieve",
        "bedrock:StartIngestionJob",
        "bedrock:GetIngestionJob",
        "bedrock:ListIngestionJobs"
      ],
      "Resource": "arn:aws:bedrock:*:*:knowledge-base/*"
    }
  ]
}
```

#### 策略 2：数据湖访问
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AthenaAccess",
      "Effect": "Allow",
      "Action": [
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:StopQueryExecution",
        "athena:ListQueryExecutions",
        "athena:ListWorkGroups",
        "athena:GetWorkGroup"
      ],
      "Resource": "*"
    },
    {
      "Sid": "GlueCatalogAccess",
      "Effect": "Allow",
      "Action": [
        "glue:GetDatabases",
        "glue:GetDatabase",
        "glue:GetTables",
        "glue:GetTable",
        "glue:GetPartitions",
        "glue:GetPartition"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3DataAccess",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::<your-athena-results-bucket>",
        "arn:aws:s3:::<your-athena-results-bucket>/*",
        "arn:aws:s3:::<your-datalake-bucket>",
        "arn:aws:s3:::<your-datalake-bucket>/*",
        "arn:aws:s3:::<your-kb-bucket>",
        "arn:aws:s3:::<your-kb-bucket>/*"
      ]
    }
  ]
}
```

#### 策略 3：Neptune Analytics 访问
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NeptuneAnalytics",
      "Effect": "Allow",
      "Action": "neptune-graph:*",
      "Resource": "arn:aws:neptune-graph:*:*:graph/*"
    }
  ]
}
```

### 信任策略
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

## 3. Amazon Bedrock

### 模型开通
在 Bedrock 控制台 → Model access 中申请开通以下模型：
- **Claude Sonnet 4.5**（us.anthropic.claude-sonnet-4-20250514-v1:0）— Agent 推理
- **Titan Text Embeddings V2**（amazon.titan-embed-text-v2:0）— 向量生成（Neptune 图 + Knowledge Base）

### AgentCore Memory
```bash
# 创建 Memory 实例（通过 SDK 或控制台）
# 记录返回的 Memory ID，格式如：KiroSharedMemory-xxxxxxxxxx
# 配置到 TeamAI 的 memory-helper.js 中
```

### Knowledge Base
1. 创建 S3 存储桶用于知识库文档
2. 创建 OpenSearch Serverless Collection（向量搜索类型）
3. 创建 Bedrock Knowledge Base：
   - 数据源：S3 存储桶
   - 嵌入模型：Titan Text Embeddings V2
   - 向量存储：OpenSearch Serverless
   - 分块策略：Fixed size（300 tokens, 20% overlap）
4. 记录 Knowledge Base ID，配置到 TeamAI 的 server.js 中

## 4. Neptune Analytics

### 创建图实例
```bash
aws neptune-graph create-graph \
  --graph-name teamai-semantic-graph \
  --provisioned-memory 16 \
  --public-connectivity false \
  --vector-search-configuration dimension=1024 \
  --replica-count 0 \
  --region <your-region>
```

参数说明：
- `provisioned-memory`：16GB 适合中小规模（<100 张表），大规模可调至 32/64
- `dimension`：1024，与 Titan Embed v2 输出维度一致
- `public-connectivity`：建议 false，通过 VPC 内网访问

### 图数据结构
```
节点类型：
  - Table（name, database, location, description）
  - Column（name, type, tableName, description）

边类型：
  - HAS_COLUMN：Table → Column
  - JOINS_ON：Table → Table（属性：column — 关联字段名）

向量：
  - 每个节点通过 neptune.algo.vectors.upsert 写入 1024 维向量
  - 查询时通过 neptune.algo.vectors.topK.byEmbedding 进行语义搜索
```

## 5. S3 存储桶

| 用途 | 命名建议 | 说明 |
|------|----------|------|
| Athena 查询结果 | `teamai-athena-results-<account-id>` | Athena 输出位置 |
| 数据湖数据 | `teamai-datalake-<account-id>` | 原始数据存储 |
| 知识库文档 | `teamai-kb-<account-id>` | Bedrock KB 数据源 |
| 文件上传 | `teamai-uploads-<account-id>` | 用户上传的文件 |

## 6. Glue Catalog

### 创建数据库
```bash
aws glue create-database \
  --database-input '{"Name": "datalake_demo"}' \
  --region <your-region>
```

### 创建表（示例）
通过 Athena DDL 或 Glue Crawler 自动发现 S3 数据创建表。表结构会被定时任务自动同步到 Neptune Analytics 语义图。

## 7. Systemd 服务

### OpenClaw Gateway
```ini
# /etc/systemd/system/clawdbot-gateway.service
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
ExecStart=/usr/bin/npx clawdbot start --port 3000
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### TeamAI 服务
```ini
# /etc/systemd/system/multi-chat.service
[Unit]
Description=TeamAI Multi-Chat Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/multi-chat
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3001

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable clawdbot-gateway multi-chat
sudo systemctl start clawdbot-gateway multi-chat
```

## 8. 配置清单

部署前需要确认并填写以下配置项：

| 配置项 | 文件位置 | 说明 |
|--------|----------|------|
| Bedrock Region | server.js | 模型调用区域 |
| Memory ID | memory-helper.js | AgentCore Memory 实例 ID |
| Knowledge Base ID | server.js | Bedrock KB ID |
| Neptune Graph ID | skills/datalake_query/SKILL.md | Neptune Analytics 图 ID |
| Athena 结果桶 | skills/datalake_query/SKILL.md | S3 输出路径 |
| KB S3 桶 | server.js | 知识库文档存储桶 |
| Gateway Token | server.js | OpenClaw Gateway 认证 Token |
| Web Auth | server.js | TeamAI Web 界面的 Basic Auth 凭证 |
