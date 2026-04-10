import os
#!/usr/bin/env python3
"""
定时任务：自动为数据湖表生成语义模型并更新到知识库
从 Glue Catalog 获取表 DDL → 用 Bedrock LLM 生成 YAML 语义模型 → 覆盖更新到 Knowledge Base
"""
import subprocess, json, urllib.request, os
from datetime import datetime

AGENT_ID = 'aws-expert'
API_URL = f'http://localhost:3001/api/knowledge/{AGENT_ID}'
DB = 'datalake_demo'
REGION = 'us-east-1'
ATHENA_S3_BUCKET = os.environ.get('ATHENA_S3_BUCKET', '')
ATHENA_OUTPUT = f's3://{ATHENA_S3_BUCKET}/'

def get_tables():
    """获取 Glue Catalog 中所有表的详细结构"""
    result = subprocess.run(
        ['aws', 'glue', 'get-tables', '--database-name', DB, '--region', REGION, '--output', 'json'],
        capture_output=True, text=True, timeout=30
    )
    return json.loads(result.stdout).get('TableList', [])

def get_sample_data(table_name, limit=5):
    """通过 Athena 获取表的示例数据"""
    try:
        sql = f"SELECT * FROM {DB}.{table_name} LIMIT {limit}"
        qid_result = subprocess.run(
            ['aws', 'athena', 'start-query-execution',
             '--query-string', sql,
             '--query-execution-context', f'Database={DB}',
             '--result-configuration', f'OutputLocation={ATHENA_OUTPUT}',
             '--region', REGION, '--output', 'text'],
            capture_output=True, text=True, timeout=15
        )
        qid = qid_result.stdout.strip()
        if not qid:
            return None

        # 等待查询完成
        import time
        for _ in range(10):
            time.sleep(2)
            state_result = subprocess.run(
                ['aws', 'athena', 'get-query-execution',
                 '--query-execution-id', qid,
                 '--region', REGION,
                 '--query', 'QueryExecution.Status.State',
                 '--output', 'text'],
                capture_output=True, text=True, timeout=10
            )
            state = state_result.stdout.strip()
            if state in ('SUCCEEDED', 'FAILED', 'CANCELLED'):
                break

        if state != 'SUCCEEDED':
            return None

        # 获取结果
        result = subprocess.run(
            ['aws', 'athena', 'get-query-results',
             '--query-execution-id', qid,
             '--region', REGION, '--output', 'json'],
            capture_output=True, text=True, timeout=15
        )
        return json.loads(result.stdout)
    except Exception as e:
        print(f"  [warn] sample data for {table_name}: {e}")
        return None

def build_llm_prompt(tables_info):
    """构建 LLM prompt 生成语义模型"""
    tables_desc = ""
    for t in tables_info:
        name = t['Name']
        cols = t.get('StorageDescriptor', {}).get('Columns', [])
        loc = t.get('StorageDescriptor', {}).get('Location', '')
        cols_str = "\n".join([f"    - {c['Name']} ({c['Type']})" for c in cols])
        sample_str = ""
        if t.get('_samples'):
            sample_str = f"\n  示例数据: {json.dumps(t['_samples'][:3], ensure_ascii=False)}"
        tables_desc += f"\n表名: {name}\nS3位置: {loc}\n字段:\n{cols_str}{sample_str}\n"

    return f"""请为以下数据湖表生成一个完整的 YAML 语义模型。

数据库: {DB}
Region: {REGION}

表结构:
{tables_desc}

要求:
1. 为每个字段生成业务含义描述和中英文别名(synonyms)
2. 识别维度(dimensions)和指标(metrics)
3. 识别时间维度(time_dimensions)
4. 推断表之间的关系(relationships)，通过字段名匹配
5. 生成常用过滤条件(filters)
6. 指标需要包含 SQL 聚合表达式
7. 只输出 YAML 内容，不要其他说明文字

YAML 格式:
```yaml
name: 模型名称
description: 一句话描述
database: {DB}
region: {REGION}

tables:
  - name: 表名
    description: 表的业务含义
    location: S3路径
    columns:
      - name: 字段名
        type: 数据类型
        description: 业务含义
        synonyms: [别名列表]
        sample_values: [示例值]

dimensions:
  - name: 维度名称
    column: 表名.字段名
    description: 维度说明
    synonyms: [别名]

time_dimensions:
  - name: 时间维度名称
    column: 表名.字段名
    granularity: DAY
    description: 说明

metrics:
  - name: 指标名称
    expression: SQL聚合表达式
    description: 指标含义和计算口径
    synonyms: [别名]
    default_aggregation: sum/count/avg

relationships:
  - from: 表名.字段名
    to: 表名.字段名
    type: many_to_one
    description: 关系说明

filters:
  - name: 过滤条件名称
    expression: SQL WHERE表达式
    description: 说明
    synonyms: [别名]
```"""

def call_bedrock_llm(prompt):
    """调用 Bedrock Claude 生成语义模型"""
    import boto3
    client = boto3.client('bedrock-runtime', region_name=REGION)

    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 8000,
        "messages": [{"role": "user", "content": prompt}]
    })

    response = client.invoke_model(
        modelId="us.anthropic.claude-sonnet-4-20250514-v1:0",
        body=body,
        contentType="application/json"
    )

    result = json.loads(response['body'].read())
    text = result['content'][0]['text']

    # 提取 YAML 内容
    if '```yaml' in text:
        yaml_content = text.split('```yaml')[1].split('```')[0].strip()
    elif '```' in text:
        yaml_content = text.split('```')[1].split('```')[0].strip()
    else:
        yaml_content = text.strip()

    return yaml_content

def upsert_to_kb(filename, content):
    """覆盖更新到知识库"""
    data = json.dumps({"filename": filename, "content": content}).encode('utf-8')
    req = urllib.request.Request(
        API_URL, data=data,
        headers={'Content-Type': 'application/json'},
        method='PUT'
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read().decode())

def main():
    print(f"[{datetime.now()}] 开始生成数据湖语义模型...")

    # 1. 获取所有表结构
    tables = get_tables()
    print(f"  发现 {len(tables)} 张表")

    if not tables:
        print("  没有找到表，退出")
        return

    # 2. 获取示例数据
    for t in tables:
        samples = get_sample_data(t['Name'])
        if samples and 'ResultSet' in samples:
            rows = samples['ResultSet'].get('Rows', [])
            if len(rows) > 1:
                headers = [c.get('VarCharValue', '') for c in rows[0].get('Data', [])]
                t['_samples'] = [
                    {h: d.get('VarCharValue', '') for h, d in zip(headers, row.get('Data', []))}
                    for row in rows[1:4]
                ]
        print(f"  {t['Name']}: {len(t.get('_samples', []))} 条示例")

    # 3. 用 LLM 生成语义模型
    prompt = build_llm_prompt(tables)
    print("  调用 Bedrock LLM 生成语义模型...")
    yaml_content = call_bedrock_llm(prompt)

    # 添加头部注释
    header = f"# 数据湖语义模型 - 自动生成\n# 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n# 数据库: {DB}\n# Region: {REGION}\n# 表数量: {len(tables)}\n\n"
    full_content = header + yaml_content

    # 4. 存入知识库
    result = upsert_to_kb('datalake_semantic_model.yaml', full_content)
    print(f"  ✅ 语义模型已更新到知识库, jobId={result.get('jobId', '')}")

if __name__ == '__main__':
    main()
