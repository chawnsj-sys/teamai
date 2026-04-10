#!/usr/bin/env python3
"""
定时任务：同步数据湖表结构到 Neptune Analytics 语义图
从 Glue Catalog 获取表结构 → 生成 embedding → 写入图节点和边
"""
import boto3, json, os, time
from datetime import datetime

REGION = 'us-east-1'
GRAPH_ID = os.environ.get('NEPTUNE_GRAPH_ID', '')
DB = 'datalake_demo'

neptune = boto3.client('neptune-graph', region_name=REGION)
bedrock = boto3.client('bedrock-runtime', region_name=REGION)
glue = boto3.client('glue', region_name=REGION)

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

def clear_graph():
    """删除图中 source=datalake 的节点和边"""
    print("  清除旧的数据湖图数据...")
    run_query("MATCH (n {source: 'datalake'})-[r]-() DELETE r")
    run_query("MATCH (n {source: 'datalake'}) DELETE n")
    print("  数据湖节点已清空")

def main():
    print(f"[{datetime.now()}] 同步数据湖表结构到语义图...")

    # 先清后写：删除旧数据，确保和 Glue 保持一致
    clear_graph()

    tables = glue.get_tables(DatabaseName=DB)['TableList']
    print(f"  发现 {len(tables)} 张表")

    node_embeddings = []

    for table in tables:
        tname = table['Name']
        cols = table.get('StorageDescriptor', {}).get('Columns', [])
        loc = table.get('StorageDescriptor', {}).get('Location', '')
        desc = f"Table {tname} in {DB}, location: {loc}, columns: {', '.join(c['Name'] for c in cols)}"

        # Table node
        result = run_query(f"MERGE (t:Table {{name: '{tname}', source: 'datalake'}}) SET t.database = '{DB}', t.location = '{loc}', t.description = '{desc.replace(chr(39), '')}' RETURN id(t) AS nodeId")
        if result and result.get('results'):
            node_id = result['results'][0].get('nodeId')
            if node_id:
                node_embeddings.append((str(node_id), get_embedding(desc)))
            print(f"  Table: {tname}")

        # Column nodes
        for col in cols:
            cname = col['Name']
            ctype = col['Type']
            col_desc = f"Column {cname} ({ctype}) in table {tname}"
            result = run_query(f"MERGE (c:Column {{name: '{cname}', tableName: '{tname}', source: 'datalake'}}) SET c.type = '{ctype}', c.description = '{col_desc}' WITH c MATCH (t:Table {{name: '{tname}', source: 'datalake'}}) MERGE (t)-[:HAS_COLUMN]->(c) RETURN id(c) AS nodeId")
            if result and result.get('results'):
                node_id = result['results'][0].get('nodeId')
                if node_id:
                    node_embeddings.append((str(node_id), get_embedding(col_desc)))

    # Infer relationships (only by ID/key columns, not dimension columns)
    join_key_suffixes = ['_id', '_key', '_code']
    all_cols = {}
    for table in tables:
        for col in table.get('StorageDescriptor', {}).get('Columns', []):
            cname = col['Name']
            if any(cname.endswith(s) for s in join_key_suffixes):
                if cname not in all_cols:
                    all_cols[cname] = []
                all_cols[cname].append(table['Name'])

    for cname, tlist in all_cols.items():
        if len(tlist) > 1:
            for i in range(len(tlist)):
                for j in range(i + 1, len(tlist)):
                    run_query(f"MATCH (a:Table {{name: '{tlist[i]}', source: 'datalake'}}), (b:Table {{name: '{tlist[j]}', source: 'datalake'}}) MERGE (a)-[:JOINS_ON {{column: '{cname}'}}]->(b)")
                    print(f"  Rel: {tlist[i]} --[{cname}]--> {tlist[j]}")

    # Upsert vectors
    print(f"  Upserting {len(node_embeddings)} vectors...")
    for node_id, emb in node_embeddings:
        run_query(f"MATCH (n) WHERE id(n) = '{node_id}' CALL neptune.algo.vectors.upsert(n, {json.dumps(emb)}) YIELD success RETURN success")

    # LLM semantic annotation (only for tables without confirmed status)
    annotate_semantics(tables)

    # Cross-source relationships: link datalake tables to snowflake tables by matching column names
    print("  检查跨数据源关系...")
    cross_cols = ['channel_id', 'campaign_id', 'customer_id']
    for table in tables:
        tname = table['Name']
        dl_cols = [c['Name'] for c in table.get('StorageDescriptor', {}).get('Columns', [])]
        for cc in cross_cols:
            if cc in dl_cols:
                # Find snowflake tables with same column
                result = run_query(f"MATCH (sc:Column {{name: '{cc.upper()}', source: 'snowflake'}}) RETURN DISTINCT sc.tableName AS sTable")
                if result and result.get('results'):
                    for r in result['results']:
                        st = r.get('sTable')
                        if st:
                            run_query(f"MATCH (a:Table {{name: '{tname}', source: 'datalake'}}), (b:Table {{name: '{st}', source: 'snowflake'}}) MERGE (a)-[:JOINS_ON {{column: '{cc}', cross_source: true}}]->(b)")
                            print(f"    跨源: {tname} --[{cc}]--> {st}")

    print(f"[{datetime.now()}] 语义图同步完成")

def annotate_semantics(tables):
    """Call LLM to generate semantic annotations for datalake tables"""
    print("  生成语义标注...")
    for table in tables:
        tname = table['Name']
        cols = table.get('StorageDescriptor', {}).get('Columns', [])
        col_list = ', '.join(f"{c['Name']} ({c['Type']})" for c in cols)

        prompt = f"""For the data lake table "{tname}" with columns: {col_list}

Generate a JSON with:
1. table_description: one-line business description in Chinese
2. columns: for each column, provide:
   - name: column name
   - semantic_type: "dimension" or "measure"
   - business_name: Chinese business name
   - description: Chinese business description (one line)

Output only valid JSON, no other text.
Example: {{"table_description": "广告点击流明细表", "columns": [{{"name": "region", "semantic_type": "dimension", "business_name": "投放区域", "description": "广告投放的目标市场区域"}}]}}"""

        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2000,
            "messages": [{"role": "user", "content": prompt}]
        })
        try:
            resp = bedrock.invoke_model(modelId="us.anthropic.claude-sonnet-4-20250514-v1:0", body=body, contentType="application/json")
            result = json.loads(resp['body'].read())
            text = result['content'][0]['text'].strip()
            if '```json' in text:
                text = text.split('```json')[1].split('```')[0].strip()
            elif '```' in text:
                text = text.split('```')[1].split('```')[0].strip()
            annotations = json.loads(text)

            # Update table description
            tdesc = annotations.get('table_description', '').replace("'", "")
            if tdesc:
                run_query(f"MATCH (t:Table {{name: '{tname}', source: 'datalake'}}) SET t.description = '{tdesc}', t.status = 'auto' RETURN t.name")

            # Update column annotations
            for col_ann in annotations.get('columns', []):
                cname = col_ann.get('name', '')
                stype = col_ann.get('semantic_type', '')
                bname = col_ann.get('business_name', '').replace("'", "")
                cdesc = col_ann.get('description', '').replace("'", "")
                sets = []
                if stype: sets.append(f"c.semantic_type = '{stype}'")
                if bname: sets.append(f"c.business_name = '{bname}'")
                if cdesc: sets.append(f"c.description = '{cdesc}'")
                if sets:
                    run_query(f"MATCH (c:Column {{name: '{cname}', tableName: '{tname}', source: 'datalake'}}) SET {', '.join(sets)} RETURN c.name")

            print(f"    {tname}: {len(annotations.get('columns', []))} 列已标注")
        except Exception as e:
            print(f"    {tname} 标注失败: {e}")

if __name__ == '__main__':
    main()
