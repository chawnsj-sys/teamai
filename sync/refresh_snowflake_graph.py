#!/usr/bin/env python3
"""
定时任务：同步 Snowflake 表结构到 Neptune Analytics 语义图
从 Snowflake Semantic Views 获取表、列、关系 → 写入图节点和边（先清后写）
和 refresh_datalake_graph.py 共用同一个图，通过 source 属性区分来源
"""
import snowflake.connector, tomllib, boto3, json, os
from datetime import datetime

REGION = 'us-east-1'
GRAPH_ID = os.environ.get('NEPTUNE_GRAPH_ID', '')

neptune = boto3.client('neptune-graph', region_name=REGION)
bedrock = boto3.client('bedrock-runtime', region_name=REGION)

def get_embedding(text):
    body = json.dumps({"inputText": text})
    resp = bedrock.invoke_model(modelId="amazon.titan-embed-text-v2:0", body=body, contentType="application/json")
    return json.loads(resp['body'].read())['embedding']

def run_query(query):
    try:
        resp = neptune.execute_query(graphIdentifier=GRAPH_ID, queryString=query, language='OPEN_CYPHER')
        return json.loads(resp['payload'].read())
    except Exception as e:
        print(f"  Query error: {e}")
        return None

def clear_snowflake_nodes():
    """删除图中 source=snowflake 的节点和边"""
    print("  清除旧的 Snowflake 图数据...")
    run_query("MATCH (n {source: 'snowflake'})-[r]-() DELETE r")
    run_query("MATCH (n {source: 'snowflake'}) DELETE n")
    print("  Snowflake 节点已清空")

def main():
    print(f"[{datetime.now()}] 同步 Snowflake 表结构到语义图...")

    # 连接 Snowflake
    with open("/home/ubuntu/.snowflake/connections.toml", "rb") as f:
        cfg = tomllib.load(f)["connections"]["manufacturing"]
    conn = snowflake.connector.connect(**cfg)
    cur = conn.cursor()

    # 先清后写
    clear_snowflake_nodes()

    # 获取 Semantic Views 列表
    cur.execute("SHOW SEMANTIC VIEWS IN MANUFACTURING_DEMO.ANALYTICS")
    sv_names = [row[1] for row in cur]
    print(f"  发现 {len(sv_names)} 个 Semantic Views: {sv_names}")

    node_embeddings = []
    all_tables = set()

    for sv_name in sv_names:
        print(f"  处理 {sv_name}...")
        cur.execute(f"DESCRIBE SEMANTIC VIEW {sv_name}")
        rows = cur.fetchall()

        # 第一行是 EXTENSION，包含完整 JSON 定义
        sv_json = None
        for row in rows:
            if row[0] == "EXTENSION" and row[3] == "VALUE" and row[4]:
                try:
                    sv_json = json.loads(row[4])
                except:
                    pass
                break

        if not sv_json or "tables" not in sv_json:
            # Fallback: 从逐行数据中提取表名
            for row in rows:
                if row[0] == "TABLE" and row[3] == "BASE_TABLE_NAME" and row[4]:
                    tname = row[4]
                    all_tables.add(tname)
                    desc = f"Snowflake table {tname} in MANUFACTURING_DEMO.ANALYTICS, semantic view: {sv_name}"
                    result = run_query(f"MERGE (t:Table {{name: '{tname}', source: 'snowflake'}}) SET t.database = 'MANUFACTURING_DEMO', t.schema = 'ANALYTICS', t.semantic_view = '{sv_name}', t.description = '{desc}' RETURN id(t) AS nodeId")
                    if result and result.get('results'):
                        nid = result['results'][0].get('nodeId')
                        if nid:
                            node_embeddings.append((str(nid), get_embedding(desc)))
                    print(f"    Table: {tname}")
            continue

        # 从 JSON 解析表、维度、指标、关系
        tables_in_sv = sv_json.get("tables", [])
        relationships = sv_json.get("relationships", [])

        # Extract table COMMENTs from row-level data
        table_comments = {}
        for row in rows:
            if row[0] == "TABLE" and row[3] == "COMMENT" and row[4]:
                table_comments[row[1]] = row[4].replace("'", "").split("\n")[0][:80]

        for tbl in tables_in_sv:
            tname = tbl["name"]
            all_tables.add(tname)
            dims = [d["name"] for d in tbl.get("dimensions", [])]
            measures = [m["name"] for m in tbl.get("measures", [])]
            # Use Chinese COMMENT if available, otherwise fallback
            comment = table_comments.get(tname, "")
            desc = comment if comment else f"Snowflake table {tname}, {sv_name}"

            result = run_query(f"MERGE (t:Table {{name: '{tname}', source: 'snowflake'}}) SET t.database = 'MANUFACTURING_DEMO', t.schema = 'ANALYTICS', t.semantic_view = '{sv_name}', t.description = '{desc[:200].replace(chr(39), '')}' RETURN id(t) AS nodeId")
            if result and result.get('results'):
                nid = result['results'][0].get('nodeId')
                if nid:
                    node_embeddings.append((str(nid), get_embedding(desc)))
            print(f"    Table: {tname} ({len(dims)} dims, {len(measures)} measures)")

            # Column nodes for dimensions
            for dim in dims:
                col_desc = f"Dimension {dim} in Snowflake table {tname}"
                result = run_query(f"MERGE (c:Column {{name: '{dim}', tableName: '{tname}', source: 'snowflake'}}) SET c.type = 'dimension', c.semantic_type = 'dimension', c.description = '{col_desc}' WITH c MATCH (t:Table {{name: '{tname}', source: 'snowflake'}}) MERGE (t)-[:HAS_COLUMN]->(c) RETURN id(c) AS nodeId")
                if result and result.get('results'):
                    nid = result['results'][0].get('nodeId')
                    if nid:
                        node_embeddings.append((str(nid), get_embedding(col_desc)))

            # Column nodes for measures
            for m in tbl.get("measures", []):
                mname = m["name"]
                mdesc = m.get("description", mname)
                col_desc = f"Measure {mname} ({mdesc}) in Snowflake table {tname}"
                bname = mdesc.replace("'", "") if mdesc != mname else ""
                result = run_query(f"MERGE (c:Column {{name: '{mname}', tableName: '{tname}', source: 'snowflake'}}) SET c.type = 'measure', c.semantic_type = 'measure', c.business_name = '{bname}', c.description = '{col_desc.replace(chr(39), '')}' WITH c MATCH (t:Table {{name: '{tname}', source: 'snowflake'}}) MERGE (t)-[:HAS_COLUMN]->(c) RETURN id(c) AS nodeId")
                if result and result.get('results'):
                    nid = result['results'][0].get('nodeId')
                    if nid:
                        node_embeddings.append((str(nid), get_embedding(col_desc)))

        # Relationships from semantic view JSON
        for rel in relationships:
            rel_name = rel.get("name", "")
            # Parse relationship: find from/to tables in the row-level data
            from_table = None
            to_table = None
            join_col = None
            for row in rows:
                if row[0] == "RELATIONSHIP" and row[1] and row[1].upper() == rel_name.upper():
                    if row[3] == "TABLE":
                        from_table = row[4]
                    elif row[3] == "REF_TABLE":
                        to_table = row[4]
                    elif row[3] == "FOREIGN_KEY":
                        try:
                            join_col = json.loads(row[4])[0]
                        except:
                            join_col = row[4]
            if from_table and to_table:
                run_query(f"MATCH (a:Table {{name: '{from_table}', source: 'snowflake'}}), (b:Table {{name: '{to_table}', source: 'snowflake'}}) MERGE (a)-[:JOINS_ON {{column: '{join_col or rel_name}'}}]->(b)")
                print(f"    Rel: {from_table} --[{join_col or rel_name}]--> {to_table}")

    # Upsert vectors
    print(f"  Upserting {len(node_embeddings)} vectors...")
    for node_id, emb in node_embeddings:
        run_query(f"MATCH (n) WHERE id(n) = '{node_id}' CALL neptune.algo.vectors.upsert(n, {json.dumps(emb)}) YIELD success RETURN success")

    # LLM annotation for dimensions (add Chinese business names)
    print("  为 Snowflake dimensions 生成中文标注...")
    for tname in all_tables:
        result = run_query(f"MATCH (c:Column {{tableName: '{tname}', source: 'snowflake', type: 'dimension'}}) WHERE c.business_name IS NULL OR c.business_name = '' RETURN c.name AS name")
        if not result or not result.get('results'):
            continue
        dim_names = [r['name'] for r in result['results']]
        if not dim_names:
            continue
        prompt = f"For Snowflake table {tname}, generate Chinese business names for these dimension columns: {', '.join(dim_names)}. Output JSON only: {{\"columns\": [{{\"name\": \"COL\", \"business_name\": \"中文名\"}}]}}"
        body = json.dumps({"anthropic_version": "bedrock-2023-05-31", "max_tokens": 1000, "messages": [{"role": "user", "content": prompt}]})
        try:
            resp = bedrock.invoke_model(modelId="us.anthropic.claude-sonnet-4-20250514-v1:0", body=body, contentType="application/json")
            text = json.loads(resp['body'].read())['content'][0]['text'].strip()
            if '```json' in text: text = text.split('```json')[1].split('```')[0].strip()
            elif '```' in text: text = text.split('```')[1].split('```')[0].strip()
            annotations = json.loads(text)
            for col in annotations.get('columns', []):
                bname = col.get('business_name', '').replace("'", "")
                if bname:
                    run_query(f"MATCH (c:Column {{name: '{col['name']}', tableName: '{tname}', source: 'snowflake'}}) SET c.business_name = '{bname}' RETURN c.name")
            print(f"    {tname}: {len(dim_names)} dims 已标注")
        except Exception as e:
            print(f"    {tname} 标注失败: {e}")

    conn.close()
    print(f"[{datetime.now()}] Snowflake 语义图同步完成 ({len(all_tables)} 张表)")

if __name__ == '__main__':
    main()
