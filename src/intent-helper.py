#!/usr/bin/env python3
"""Intent analysis helper v6 — SQL-first with Snowflake Cortex Analyst support.
Routes to Neptune+LLM (datalake) or Cortex Analyst API (snowflake) based on Neptune source."""
import sys, json, os, boto3, requests

REGION = 'us-east-1'
GRAPH_ID = os.environ.get('NEPTUNE_GRAPH_ID', '')
DB = 'datalake_demo'

# Snowflake config
SF_ACCOUNT = os.environ.get('SF_ACCOUNT', '')
SF_USER = os.environ.get('SF_USER', '')
SF_PAT = os.environ.get('SF_PAT', '')
SF_DATABASE = 'MANUFACTURING_DEMO'
SF_SCHEMA = 'ANALYTICS'
SF_WAREHOUSE = 'MANUFACTURING_DEMO_WH'
SF_SEMANTIC_VIEWS = {
    'MKT': 'MANUFACTURING_DEMO.ANALYTICS.MARKETING_ANALYTICS',
    'ERP': 'MANUFACTURING_DEMO.ANALYTICS.ERP_OPERATIONS',
}

bedrock = boto3.client('bedrock-runtime', region_name=REGION)
neptune = boto3.client('neptune-graph', region_name=REGION)

def get_embedding(text):
    body = json.dumps({"inputText": text})
    resp = bedrock.invoke_model(modelId="amazon.titan-embed-text-v2:0", body=body, contentType="application/json")
    return json.loads(resp['body'].read())['embedding']

def run_query(q):
    try:
        resp = neptune.execute_query(graphIdentifier=GRAPH_ID, queryString=q, language='OPEN_CYPHER')
        return json.loads(resp['payload'].read()).get('results', [])
    except:
        return []

def get_graph_context(question):
    """Vector search + graph traversal, also returns source info per table."""
    emb = get_embedding(question)
    q = f"CALL neptune.algo.vectors.topK.byEmbedding({{embedding: {json.dumps(emb)}, topK: 5}}) YIELD node, score RETURN labels(node) AS labels, node.name AS name, node.description AS desc, node.tableName AS tbl, node.source AS source, score ORDER BY score ASC"
    results = run_query(q)

    tables = {}  # name -> source
    for r in results:
        src = r.get('source', 'glue')
        if 'Table' in (r.get('labels') or []):
            tables[r.get('name')] = src
        elif r.get('tbl'):
            tables[r.get('tbl')] = src

    context = []
    for tname in tables:
        cols = run_query(f"MATCH (t:Table {{name: '{tname}'}})-[:HAS_COLUMN]->(c:Column) RETURN t.name AS table_name, t.description AS table_desc, collect(c.name + ' (' + coalesce(c.business_name, c.type) + ')') AS columns")
        if cols:
            context.append(cols[0])
        rels = run_query(f"MATCH (t:Table {{name: '{tname}'}})-[r:JOINS_ON*1..2]->(other:Table) RETURN t.name AS from_table, other.name AS to_table, [rel IN r | rel.column] AS join_columns")
        if rels:
            context.extend(rels)

    return context, tables


def get_sf_session_token():
    """Get Snowflake session token via snowflake.connector."""
    try:
        import snowflake.connector
        conn = snowflake.connector.connect(
            account=SF_ACCOUNT, user=SF_USER,
            authenticator='programmatic_access_token', token=SF_PAT,
            database=SF_DATABASE, schema=SF_SCHEMA, warehouse=SF_WAREHOUSE
        )
        token = conn.rest.token
        host = conn.rest._host
        # conn kept alive for token validity
        return token, host
    except Exception as e:
        print(f"[sf-auth] {e}", file=sys.stderr)
        return None, None

def call_cortex_analyst(question, semantic_view):
    """Call Snowflake Cortex Analyst REST API to generate SQL."""
    token, host = get_sf_session_token()
    if not token:
        return None, None

    body = {
        "messages": [{"role": "user", "content": [{"type": "text", "text": question}]}],
        "semantic_view": semantic_view
    }
    try:
        resp = requests.post(
            url=f"https://{host}/api/v2/cortex/analyst/message",
            json=body,
            headers={
                "Authorization": f'Snowflake Token="{token}"',
                "Content-Type": "application/json"
            },
            timeout=60
        )
        if resp.status_code < 400:
            data = resp.json()
            sql = ""
            text_explanation = ""
            for block in data.get('message', {}).get('content', []):
                if block.get('type') == 'sql':
                    sql = block.get('statement', '')
                elif block.get('type') == 'text':
                    text_explanation = block.get('text', '')
            return sql, text_explanation
        else:
            print(f"[cortex-analyst] {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
            return None, None
    except Exception as e:
        import traceback; print(f"[cortex-analyst] {e}", file=sys.stderr); traceback.print_exc(file=sys.stderr)
        return None, None

def determine_semantic_view(tables):
    """Based on table names, pick the right Semantic View."""
    for tname in tables:
        if tname.startswith('MKT_'):
            return SF_SEMANTIC_VIEWS['MKT']
        if tname.startswith('ERP_'):
            return SF_SEMANTIC_VIEWS['ERP']
    # Default to marketing
    return SF_SEMANTIC_VIEWS['MKT']

def determine_source(tables):
    """Determine if query should go to datalake, snowflake, or both."""
    sources = set(tables.values())
    if sources == {'snowflake'}:
        return 'snowflake'
    elif sources == {'glue'} or sources == {None}:
        return 'datalake'
    else:
        return 'mixed'


def sql_to_items_with_llm(sql, question, source_type, rules=None):
    """Use LLM to extract 8 dimensions from SQL (works for both datalake and snowflake SQL)."""
    db_label = "Snowflake" if source_type == "snowflake" else "Athena"
    rule_str = ""
    if rules:
        rule_texts = [r['text'] for r in rules if r.get('type') in ('rule', 'preference')]
        if rule_texts:
            rule_str = "\n\n历史业务规则/偏好（如果 SQL 中体现了这些规则，对应 item 的 source 标 rule）：\n" + "\n".join(f"- {t}" for t in rule_texts)
    prompt = f"""你是数据分析需求理解助手。基于以下 SQL，反向提取 8 个维度的需求确认卡片。

用户问题：{question}

生成的 SQL（{db_label}）：
{sql}{rule_str}

从 SQL 中提取以下 8 个维度：

| 维度 | 对应 SQL 子句 |
|------|-------------|
| 分析对象 | WHERE（主体过滤） |
| 分析指标 | SELECT（聚合计算） |
| 过滤条件 | WHERE（附加过滤） |
| 时间范围 | WHERE（时间过滤） |
| 分组维度 | GROUP BY |
| 排序方式 | ORDER BY，默认"无排序" |
| 结果数量 | LIMIT，默认"全量" |
| 涉及数据 | FROM ... JOIN |

标注依据等级（source）：
- source="graph": 🔵 数据字典依据
- source="rule": 🟢 历史经验依据
- source="infer": ⚪ 待用户确认

输出 JSON：
{{
  "items": [
    {{"label": "分析对象", "value": "具体描述", "source": "graph 或 rule 或 infer"}},
    {{"label": "分析指标", "value": "具体描述", "source": "graph 或 rule 或 infer"}},
    {{"label": "过滤条件", "value": "具体描述或（无）", "source": "graph 或 rule 或 infer"}},
    {{"label": "时间范围", "value": "具体描述或（未限定）", "source": "graph 或 infer"}},
    {{"label": "分组维度", "value": "具体描述或（无）", "source": "graph 或 infer"}},
    {{"label": "排序方式", "value": "具体描述或（无排序）", "source": "graph 或 infer"}},
    {{"label": "结果数量", "value": "具体数量或全量", "source": "graph 或 infer"}},
    {{"label": "涉及数据", "value": "表A ↔ 表B（JOIN 关系描述）", "source": "graph"}}
  ]
}}

规则：
- 卡片是 SQL 的业务语言翻译，SQL 里有什么条件卡片就展示什么
- SQL 里没有的条件，对应维度填默认值
- value 用业务语言描述，不出现表名、字段名
只输出 JSON。"""

    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2000,
        "messages": [{"role": "user", "content": prompt}]
    })
    resp = bedrock.invoke_model(modelId="us.anthropic.claude-sonnet-4-20250514-v1:0", body=body, contentType="application/json")
    text = json.loads(resp['body'].read())['content'][0]['text'].strip()
    if '```json' in text:
        text = text.split('```json')[1].split('```')[0].strip()
    elif '```' in text:
        text = text.split('```')[1].split('```')[0].strip()
    return json.loads(text)

def analyze_datalake(question, graph_context, rules, context=None, previous_items=None):
    """Original datalake flow: Neptune context + LLM generates SQL + items."""
    graph_str = json.dumps(graph_context, indent=2, ensure_ascii=False) if graph_context else "(无相关表)"
    rule_str = "\n".join(f"- [{r['type']}] {r['text']}" for r in rules) if rules else "(无)"

    prev_str = ""
    if previous_items:
        prev_str = "\n之前的分析结果：\n" + "\n".join(f"- {p.get('label','')}: {p.get('value','')} (来源:{p.get('source','')})" for p in previous_items)
    ctx_str = ""
    if context:
        ctx_str = "\n用户的补充说明：\n" + "\n".join(f"- {c}" for c in context)

    prompt = f"""你是数据分析需求理解助手。用户问了一个数据分析问题，请先生成 SQL，再基于 SQL 反向提取需求确认卡片。

用户问题：{question}

语义图上下文（表结构、列、关系）：
{graph_str}

历史业务规则：
{rule_str}
{prev_str}
{ctx_str}

## 步骤

### 步骤 1：生成 SQL
基于语义图上下文和历史规则，生成 Athena SQL（数据库 {DB}，表名带 {DB}. 前缀）。

### 步骤 2：基于 SQL 反向提取 8 个维度
| 维度 | 对应 SQL 子句 |
|------|-------------|
| 分析对象 | WHERE（主体过滤） |
| 分析指标 | SELECT（聚合计算） |
| 过滤条件 | WHERE（附加过滤） |
| 时间范围 | WHERE（时间过滤） |
| 分组维度 | GROUP BY |
| 排序方式 | ORDER BY，默认"无排序" |
| 结果数量 | LIMIT，默认"全量" |
| 涉及数据 | FROM ... JOIN |

### 步骤 3：标注依据等级
- source="graph": 🔵 数据字典依据
- source="rule": 🟢 历史经验依据
- source="infer": ⚪ 待用户确认

## 输出 JSON
{{
  "items": [
    {{"label": "分析对象", "value": "具体描述", "source": "graph 或 rule 或 infer"}},
    {{"label": "分析指标", "value": "具体描述", "source": "graph 或 rule 或 infer"}},
    {{"label": "过滤条件", "value": "具体描述或（无）", "source": "graph 或 rule 或 infer"}},
    {{"label": "时间范围", "value": "具体描述或（未限定）", "source": "graph 或 infer"}},
    {{"label": "分组维度", "value": "具体描述或（无）", "source": "graph 或 infer"}},
    {{"label": "排序方式", "value": "具体描述或（无排序）", "source": "graph 或 infer"}},
    {{"label": "结果数量", "value": "具体数量或全量", "source": "graph 或 infer"}},
    {{"label": "涉及数据", "value": "表A ↔ 表B（JOIN 关系描述）", "source": "graph"}}
  ],
  "sql": "生成的 Athena SQL",
  "feasible": true
}}

规则：
- 卡片是 SQL 的业务语言翻译
- SQL 里没有的条件填默认值
- value 用业务语言描述，不出现表名、字段名
- 如果无法生成 SQL → feasible=false，sql=""
只输出 JSON。"""

    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2000,
        "messages": [{"role": "user", "content": prompt}]
    })
    resp = bedrock.invoke_model(modelId="us.anthropic.claude-sonnet-4-20250514-v1:0", body=body, contentType="application/json")
    text = json.loads(resp['body'].read())['content'][0]['text'].strip()
    if '```json' in text:
        text = text.split('```json')[1].split('```')[0].strip()
    elif '```' in text:
        text = text.split('```')[1].split('```')[0].strip()
    return json.loads(text)


if __name__ == '__main__':
    data = json.loads(sys.stdin.read())
    question = data.get('question', '')
    rules = data.get('rules', [])
    context = data.get('context', [])
    previous_items = data.get('previousItems', [])
    agent_id = data.get('agentId', 'aws-expert')

    # Step 1: Get graph context and determine data source
    try:
        graph, tables = get_graph_context(question)
    except Exception as e:
        graph, tables = [], {}

    source = determine_source(tables)

    # Step 2: Route based on source and agent
    try:
        if agent_id == 'snowflake-expert':
            # Snowflake path: Cortex Analyst API
            semantic_view = determine_semantic_view(tables)
            # Append historical rules/preferences + user supplements to question
            full_question = question
            if rules:
                rule_parts = [r['text'] for r in rules if r.get('type') in ('rule', 'preference')]
                if rule_parts:
                    full_question += '\n历史偏好：' + '；'.join(rule_parts)
            if context:
                full_question += '\n补充条件：' + '，'.join(context)
            if previous_items:
                prev_ctx = [f"{p.get('label','')}: {p.get('value','')}" for p in previous_items if p.get('value') and p.get('value') not in ['（无）','（未限定）','全量','（无排序）']]
                if prev_ctx:
                    full_question += '\n之前确认的条件：' + '，'.join(prev_ctx)
            sql, explanation = call_cortex_analyst(full_question, semantic_view)
            if sql:
                items_result = sql_to_items_with_llm(sql, question, 'snowflake', rules)
                analysis = {
                    "items": items_result.get("items", []),
                    "sql": sql,
                    "feasible": True,
                    "source": "snowflake",
                    "semantic_view": semantic_view,
                    "explanation": explanation
                }
            else:
                analysis = {"items": [{"label": "分析需求", "value": question, "source": "infer"}], "sql": "", "feasible": False, "source": "snowflake"}

        elif agent_id == 'pm':
            # PM mode: call both datalake and snowflake, return merged result
            datalake_result = None
            snowflake_result = None
            dl_tables = {k:v for k,v in tables.items() if v != 'snowflake'}
            sf_tables = {k:v for k,v in tables.items() if v == 'snowflake'}
            if dl_tables:
                dl_graph = [g for g in graph if g.get('table_name','') in dl_tables or g.get('from_table','') in dl_tables]
                try:
                    datalake_result = analyze_datalake(question, dl_graph if dl_graph else graph, rules, context, previous_items)
                    datalake_result['source'] = 'datalake'
                except: pass
            if sf_tables:
                semantic_view = determine_semantic_view(sf_tables)
                full_q = question
                if rules:
                    rule_parts = [r['text'] for r in rules if r.get('type') in ('rule', 'preference')]
                    if rule_parts: full_q += '\n历史偏好：' + '；'.join(rule_parts)
                try:
                    sql, explanation = call_cortex_analyst(full_q, semantic_view)
                    if sql:
                        items_result = sql_to_items_with_llm(sql, question, 'snowflake', rules)
                        snowflake_result = {"items": items_result.get("items", []), "sql": sql, "feasible": True, "source": "snowflake"}
                except: pass
            if datalake_result or snowflake_result:
                analysis = {"mode": "pm", "datalake": datalake_result, "snowflake": snowflake_result, "feasible": True, "source": "merged"}
            else:
                analysis = {"items": [{"label": "分析需求", "value": question, "source": "infer"}], "sql": "", "feasible": False, "source": "unknown"}

        elif agent_id == 'aws-expert':
            # Nova: always datalake
            analysis = analyze_datalake(question, graph, rules, context, previous_items)
            analysis["source"] = "datalake"

        elif source == 'mixed':
            # Mixed: flag it, suggest PM
            analysis = {
                "items": [{"label": "⚠️ 跨数据源", "value": "这个问题涉及数据湖和 Snowflake 的数据，建议转到 PM 群聊由 Alex 协调", "source": "infer"}],
                "sql": "",
                "feasible": False,
                "source": "mixed"
            }

        else:
            # Datalake path: Neptune + LLM (original flow)
            analysis = analyze_datalake(question, graph, rules, context, previous_items)
            analysis['source'] = 'datalake'

        analysis['graphContext'] = graph
        analysis['raw'] = question

    except Exception as e:
        analysis = {"items": [{"label": "分析需求", "value": question, "source": "infer"}], "sql": "", "feasible": False, "raw": question}

    print(json.dumps(analysis, ensure_ascii=False))
