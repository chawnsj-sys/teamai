#!/usr/bin/env python3
"""
定时任务：同步 Snowflake Semantic Views 到知识库
从 Snowflake 读取所有 Semantic Views 的定义（维度、指标、表关系、业务别名）→ 存入 Knowledge Base
不再拉取原始表元数据，只同步语义视图内容。
"""
import subprocess, json, urllib.request, re
from datetime import datetime

AGENT_ID = 'snowflake-expert'
API_URL = f'http://localhost:3001/api/knowledge/{AGENT_ID}'
CORTEX = '/home/ubuntu/.local/bin/cortex'
CONNECTION = 'manufacturing'
DB = 'MANUFACTURING_DEMO'
SCHEMA = 'ANALYTICS'

def run_cortex_sql(sql):
    """通过 Cortex CLI 执行 SQL 并返回结果文本"""
    result = subprocess.run(
        [CORTEX, '-p', f'/sql {sql}', '-c', CONNECTION,
         '--dangerously-allow-all-tool-calls', '--output-format', 'stream-json'],
        capture_output=True, text=True, timeout=120
    )
    # 从 stream-json 输出中提取 result 字段
    for line in result.stdout.split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            if data.get('type') == 'result' and data.get('result'):
                return data['result']
        except json.JSONDecodeError:
            continue
    return result.stdout

def get_semantic_views_list():
    """获取所有 Semantic Views 列表"""
    result = run_cortex_sql(f'SHOW SEMANTIC VIEWS IN SCHEMA {DB}.{SCHEMA}')
    # 解析表格格式的输出，提取视图名称
    views = []
    lines = result.split('\n')
    for line in lines:
        # 匹配 **VIEW_NAME** 格式
        match = re.findall(r'\*\*(\w+)\*\*', line)
        if match:
            name = match[0]
            if name not in ('Name', 'Table', 'name'):  # 排除表头
                views.append(name)
    return views

def get_semantic_view_detail(view_name):
    """获取单个 Semantic View 的详细定义"""
    result = run_cortex_sql(f'DESCRIBE SEMANTIC VIEW {DB}.{SCHEMA}.{view_name}')
    return result

def main():
    print(f"[{datetime.now()}] 开始同步 Snowflake Semantic Views...")

    # 1. 获取所有 Semantic Views
    views = get_semantic_views_list()
    print(f"  发现 {len(views)} 个 Semantic Views: {views}")

    if not views:
        print("  没有找到 Semantic Views，退出")
        return

    # 2. 获取每个 Semantic View 的详细定义
    md = f"# Snowflake Semantic Views\n\n"
    md += f"- Database: {DB}\n"
    md += f"- Schema: {SCHEMA}\n"
    md += f"- Connection: {CONNECTION}\n"
    md += f"- Semantic Views 数量: {len(views)}\n"
    md += f"- 更新时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
    md += "---\n\n"

    for view_name in views:
        print(f"  获取 {view_name} 的定义...")
        try:
            detail = get_semantic_view_detail(view_name)
            md += f"## {view_name}\n\n"
            md += detail + "\n\n"
            md += "---\n\n"
        except Exception as e:
            print(f"  [warn] {view_name}: {e}")
            md += f"## {view_name}\n\n获取失败: {e}\n\n---\n\n"

    # 3. 存入知识库
    data = json.dumps({"filename": "snowflake_semantic_views.md", "content": md}).encode('utf-8')
    req = urllib.request.Request(
        API_URL, data=data,
        headers={'Content-Type': 'application/json'},
        method='PUT'
    )
    resp = urllib.request.urlopen(req)
    result = json.loads(resp.read().decode())
    print(f"  ✅ Semantic Views 已同步到知识库, jobId={result.get('jobId', '')}")

if __name__ == '__main__':
    main()
