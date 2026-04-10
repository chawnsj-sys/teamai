#!/usr/bin/env python3
"""Refresh datalake metadata to TeamAI knowledge base via API"""
import subprocess, json, urllib.request
from datetime import datetime

DB = 'datalake_demo'
AGENT_ID = 'aws-expert'
API_URL = f'http://localhost:3001/api/knowledge/{AGENT_ID}'

# 1. Get Glue metadata
result = subprocess.run(
    ['aws', 'glue', 'get-tables', '--database-name', DB, '--region', 'us-east-1', '--output', 'json'],
    capture_output=True, text=True
)
tables = json.loads(result.stdout).get('TableList', [])

# 2. Build markdown
md = f"# Data Lake 元数据\n\n"
md += f"- 数据库: {DB}\n"
md += f"- Region: us-east-1\n"
md += f"- 表数量: {len(tables)}\n"
md += f"- 更新时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"

for t in tables:
    name = t['Name']
    cols = t.get('StorageDescriptor', {}).get('Columns', [])
    loc = t.get('StorageDescriptor', {}).get('Location', '')
    md += f"## {name}\n"
    md += f"- S3 位置: {loc}\n"
    md += f"- 列数: {len(cols)}\n"
    md += "- 字段:\n"
    for c in cols:
        md += f"  - **{c['Name']}** ({c['Type']})\n"
    md += "\n"

# 3. Upsert to knowledge base via API
data = json.dumps({"filename": "datalake_metadata.md", "content": md}).encode('utf-8')
req = urllib.request.Request(API_URL, data=data, headers={'Content-Type': 'application/json'}, method='PUT')
resp = urllib.request.urlopen(req)
result = json.loads(resp.read().decode())
print(f"✅ 元数据已覆盖更新到知识库 ({len(tables)} 张表) jobId={result.get('jobId','')}")
