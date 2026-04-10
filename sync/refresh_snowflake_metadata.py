#!/usr/bin/env python3
"""Refresh Snowflake metadata to TeamAI knowledge base via API"""
import subprocess, json, urllib.request
from datetime import datetime

AGENT_ID = 'snowflake-expert'
API_URL = f'http://localhost:3001/api/knowledge/{AGENT_ID}'
CORTEX = '/home/ubuntu/.local/bin/cortex'

# 1. Get Snowflake metadata via cortex search
result = subprocess.run(
    [CORTEX, 'search', 'object', 'tables in ANALYTICS', '-c', 'manufacturing'],
    capture_output=True, text=True, timeout=30
)

try:
    data = json.loads(result.stdout)
    raw = data.get('results', '')
except:
    raw = result.stdout

# 2. Parse into structured markdown
md = f"# Snowflake 元数据\n\n"
md += f"- Database: MANUFACTURING_DEMO\n"
md += f"- Schema: ANALYTICS\n"
md += f"- Connection: manufacturing\n"
md += f"- 更新时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"

# Parse the cortex search output
lines = raw.split('\n')
current_table = None
for line in lines:
    line = line.strip()
    if not line:
        continue
    # Match table entries like "2. MANUFACTURING_DEMO.ANALYTICS.ORDERS (TABLE)"
    if line and line[0].isdigit() and '.' in line and ('TABLE' in line or 'VIEW' in line):
        parts = line.split('. ', 1)
        if len(parts) > 1:
            table_info = parts[1]
            table_name = table_info.split(' (')[0].split('.')[-1]
            table_type = 'VIEW' if 'VIEW' in table_info else 'TABLE'
            # Only include ANALYTICS schema tables, skip INFORMATION_SCHEMA
            if 'INFORMATION_SCHEMA' not in table_info and 'ANALYTICS' in table_info:
                current_table = table_name
                md += f"## {table_name} ({table_type})\n"
    elif line.startswith('Columns') and current_table:
        # Extract column info
        col_part = line.replace('Columns ', '').replace('(', '').replace(')', '')
        # Try to extract count and names
        if ':' in line:
            col_list = line.split(': ', 1)[1] if ': ' in line else ''
            md += f"- 字段: {col_list}\n"
    elif line.startswith('Comment') and current_table:
        comment = line.replace('Comment: ', '')
        md += f"- 说明: {comment}\n"
        md += "\n"
        current_table = None

# If parsing didn't work well, include raw output
if md.count('##') < 2:
    md += "\n## 原始元数据\n\n"
    md += "```\n" + raw[:3000] + "\n```\n"

# 3. Upsert to knowledge base via API
payload = json.dumps({"filename": "snowflake_metadata.md", "content": md}).encode('utf-8')
req = urllib.request.Request(API_URL, data=payload, headers={'Content-Type': 'application/json'}, method='PUT')
resp = urllib.request.urlopen(req)
result = json.loads(resp.read().decode())
print(f"OK snowflake metadata updated, jobId={result.get('jobId','')}")
