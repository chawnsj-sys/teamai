import os
#!/usr/bin/env python3
"""
Neptune Analytics 语义图：创建图、写入语义模型、向量搜索、图遍历、生成SQL、执行查询
全链路测试脚本
"""
import boto3, json, time, subprocess
from datetime import datetime

REGION = 'us-east-1'
ATHENA_S3_BUCKET = os.environ.get('ATHENA_S3_BUCKET', '')
GRAPH_NAME = 'teamai-semantic-graph'
DB = 'datalake_demo'

neptune = boto3.client('neptune-graph', region_name=REGION)
bedrock = boto3.client('bedrock-runtime', region_name=REGION)

# ============ Step 0: Create or get graph ============
def get_or_create_graph():
    graphs = neptune.list_graphs()['graphs']
    for g in graphs:
        if g['name'] == GRAPH_NAME:
            gid = g['id']
            status = g['status']
            print(f"Graph exists: {gid} ({status})")
            if status == 'AVAILABLE':
                return gid
            print("Waiting for graph to be available...")
            while True:
                time.sleep(10)
                g2 = neptune.get_graph(graphIdentifier=gid)
                if g2['status'] == 'AVAILABLE':
                    print(f"Graph ready: {gid}")
                    return gid
                print(f"  status: {g2['status']}")

    print("Creating graph...")
    resp = neptune.create_graph(
        graphName=GRAPH_NAME,
        provisionedMemory=16,
        publicConnectivity=False,
        vectorSearchConfiguration={'dimension': 1024},
        replicaCount=0
    )
    gid = resp['id']
    print(f"Created: {gid}, waiting...")
    while True:
        time.sleep(15)
        g2 = neptune.get_graph(graphIdentifier=gid)
        if g2['status'] == 'AVAILABLE':
            print(f"Graph ready: {gid}")
            return gid
        print(f"  status: {g2['status']}")

# ============ Step 1: Get table metadata from Glue ============
def get_glue_tables():
    glue = boto3.client('glue', region_name=REGION)
    resp = glue.get_tables(DatabaseName=DB)
    return resp['TableList']

# ============ Step 2: Generate embeddings ============
def get_embedding(text):
    body = json.dumps({"inputText": text})
    resp = bedrock.invoke_model(
        modelId="amazon.titan-embed-text-v2:0",
        body=body,
        contentType="application/json"
    )
    result = json.loads(resp['body'].read())
    return result['embedding']

# ============ Step 3: Write to graph ============
def write_to_graph(graph_id, tables):
    data_client = boto3.client('neptune-graph', region_name=REGION)

    print("Writing nodes and edges...")

    node_embeddings = []  # Collect (node_id, embedding) pairs for batch upsert

    for table in tables:
        tname = table['Name']
        cols = table.get('StorageDescriptor', {}).get('Columns', [])
        loc = table.get('StorageDescriptor', {}).get('Location', '')
        desc = f"Table {tname} in {DB}, location: {loc}, columns: {', '.join(c['Name'] for c in cols)}"

        # Create Table node
        query = f"""
        MERGE (t:Table {{name: '{tname}'}})
        SET t.database = '{DB}',
            t.location = '{loc}',
            t.description = '{desc.replace("'", "")}'
        RETURN id(t) AS nodeId
        """
        try:
            resp = data_client.execute_query(
                graphIdentifier=graph_id,
                queryString=query,
                language='OPEN_CYPHER'
            )
            result = json.loads(resp['payload'].read())
            node_id = result.get('results', [{}])[0].get('nodeId')
            table_embedding = get_embedding(desc)
            if node_id:
                node_embeddings.append((str(node_id), table_embedding))
            print(f"  Table: {tname} (id: {node_id})")
        except Exception as e:
            print(f"  Table {tname} error: {e}")

        # Create Column nodes
        for col in cols:
            cname = col['Name']
            ctype = col['Type']
            col_desc = f"Column {cname} ({ctype}) in table {tname}"

            query = f"""
            MERGE (c:Column {{name: '{cname}', tableName: '{tname}'}})
            SET c.type = '{ctype}',
                c.description = '{col_desc}'
            WITH c
            MATCH (t:Table {{name: '{tname}'}})
            MERGE (t)-[:HAS_COLUMN]->(c)
            RETURN id(c) AS nodeId
            """
            try:
                resp = data_client.execute_query(
                    graphIdentifier=graph_id,
                    queryString=query,
                    language='OPEN_CYPHER'
                )
                result = json.loads(resp['payload'].read())
                node_id = result.get('results', [{}])[0].get('nodeId')
                col_embedding = get_embedding(col_desc)
                if node_id:
                    node_embeddings.append((str(node_id), col_embedding))
            except Exception as e:
                print(f"    Col {cname} error: {e}")

    # Infer relationships between tables (by matching column names)
    all_cols = {}
    for table in tables:
        tname = table['Name']
        for col in table.get('StorageDescriptor', {}).get('Columns', []):
            cname = col['Name']
            if cname not in all_cols:
                all_cols[cname] = []
            all_cols[cname].append(tname)

    for cname, table_list in all_cols.items():
        if len(table_list) > 1:
            for i in range(len(table_list)):
                for j in range(i + 1, len(table_list)):
                    t1, t2 = table_list[i], table_list[j]
                    query = f"""
                    MATCH (a:Table {{name: '{t1}'}}), (b:Table {{name: '{t2}'}})
                    MERGE (a)-[:JOINS_ON {{column: '{cname}'}}]->(b)
                    """
                    try:
                        data_client.execute_query(
                            graphIdentifier=graph_id,
                            queryString=query,
                            language='OPEN_CYPHER'
                        )
                        print(f"  Relationship: {t1} --[{cname}]--> {t2}")
                    except Exception as e:
                        print(f"  Rel error: {e}")

    # Upsert vectors using vectors.upsert algorithm
    print(f"  Upserting {len(node_embeddings)} vectors...")
    for node_id, embedding in node_embeddings:
        query = f"MATCH (n) WHERE id(n) = '{node_id}' CALL neptune.algo.vectors.upsert(n, {json.dumps(embedding)}) YIELD success RETURN success"
        try:
            data_client.execute_query(
                graphIdentifier=graph_id,
                queryString=query,
                language='OPEN_CYPHER'
            )
        except Exception as e:
            print(f"    Vector upsert error for {node_id}: {e}")

    print("Graph populated.")

# ============ Step 4: Vector search + graph traversal ============
def search_graph(graph_id, question):
    data_client = boto3.client('neptune-graph', region_name=REGION)
    q_embedding = get_embedding(question)

    # Vector search using topK.byEmbedding
    query = f"""
    CALL neptune.algo.vectors.topK.byEmbedding({{embedding: {json.dumps(q_embedding)}, topK: 5}})
    YIELD node, score
    RETURN labels(node) AS labels, node.name AS name, node.description AS description, node.tableName AS tableName, score
    ORDER BY score ASC
    """
    try:
        resp = data_client.execute_query(
            graphIdentifier=graph_id,
            queryString=query,
            language='OPEN_CYPHER'
        )
        results = json.loads(resp['payload'].read())
        print(f"\nVector search results for: '{question}'")
        for r in results.get('results', []):
            print(f"  {r.get('labels')}: {r.get('name')} (score: {r.get('score', 0):.3f})")
        return results.get('results', [])
    except Exception as e:
        print(f"Vector search error: {e}")
        return []

def get_table_context(graph_id, table_names):
    """Get full context for tables: columns, relationships"""
    data_client = boto3.client('neptune-graph', region_name=REGION)
    context = []

    for tname in table_names:
        # Get columns
        query = f"""
        MATCH (t:Table {{name: '{tname}'}})-[:HAS_COLUMN]->(c:Column)
        RETURN t.name AS table_name, t.description AS table_desc,
               collect(c.name + ' (' + c.type + ')') AS columns
        """
        try:
            resp = data_client.execute_query(
                graphIdentifier=graph_id,
                queryString=query,
                language='OPEN_CYPHER'
            )
            result = json.loads(resp['payload'].read())
            if result.get('results'):
                context.append(result['results'][0])
        except Exception as e:
            print(f"  Context error for {tname}: {e}")

        # Get relationships
        query = f"""
        MATCH (t:Table {{name: '{tname}'}})-[r:JOINS_ON]->(other:Table)
        RETURN t.name AS from_table, other.name AS to_table, r.column AS join_column
        """
        try:
            resp = data_client.execute_query(
                graphIdentifier=graph_id,
                queryString=query,
                language='OPEN_CYPHER'
            )
            rels = json.loads(resp['payload'].read())
            if rels.get('results'):
                for rel in rels['results']:
                    context.append(rel)
        except Exception as e:
            pass

    return context

# ============ Step 5: Generate SQL with LLM ============
def generate_sql(question, graph_context):
    context_str = json.dumps(graph_context, indent=2, ensure_ascii=False)
    prompt = f"""Based on the following database schema context, generate an Athena SQL query to answer the question.

Schema context (from knowledge graph):
{context_str}

Database: {DB}
Important: Time/date fields are stored as VARCHAR strings (e.g. '2026-03-20 08:15:23'), use CAST or date_parse for date operations.
Question: {question}

Output only the SQL query, nothing else."""

    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1000,
        "messages": [{"role": "user", "content": prompt}]
    })
    resp = bedrock.invoke_model(
        modelId="us.anthropic.claude-sonnet-4-20250514-v1:0",
        body=body,
        contentType="application/json"
    )
    result = json.loads(resp['body'].read())
    sql = result['content'][0]['text'].strip()
    if '```sql' in sql:
        sql = sql.split('```sql')[1].split('```')[0].strip()
    elif '```' in sql:
        sql = sql.split('```')[1].split('```')[0].strip()
    return sql

# ============ Step 6: Execute SQL via Athena ============
def execute_athena(sql):
    athena = boto3.client('athena', region_name=REGION)
    resp = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={'Database': DB},
        ResultConfiguration={'OutputLocation': 's3://' + ATHENA_S3_BUCKET + '/'}
    )
    qid = resp['QueryExecutionId']
    print(f"  Athena query: {qid}")

    for _ in range(20):
        time.sleep(2)
        status = athena.get_query_execution(QueryExecutionId=qid)
        state = status['QueryExecution']['Status']['State']
        if state in ('SUCCEEDED', 'FAILED', 'CANCELLED'):
            break

    if state != 'SUCCEEDED':
        error = status['QueryExecution']['Status'].get('StateChangeReason', '')
        print(f"  Query {state}: {error}")
        return None

    results = athena.get_query_results(QueryExecutionId=qid)
    rows = results['ResultSet']['Rows']
    if len(rows) > 1:
        headers = [c.get('VarCharValue', '') for c in rows[0]['Data']]
        data = []
        for row in rows[1:6]:  # First 5 rows
            data.append({h: d.get('VarCharValue', '') for h, d in zip(headers, row['Data'])})
        return data
    return []

# ============ Main: Full pipeline test ============
def main():
    print(f"[{datetime.now()}] Neptune Analytics 全链路测试\n")

    # Step 0
    print("== Step 0: Get/Create graph ==")
    graph_id = get_or_create_graph()

    # Step 1
    print("\n== Step 1: Get Glue tables ==")
    tables = get_glue_tables()
    print(f"  Found {len(tables)} tables: {[t['Name'] for t in tables]}")

    # Step 2-3
    print("\n== Step 2-3: Write to graph ==")
    write_to_graph(graph_id, tables)

    # Step 4
    print("\n== Step 4: Vector search ==")
    question = "北美用户转化率趋势"
    search_results = search_graph(graph_id, question)

    # Extract table names from search results
    table_names = set()
    for r in search_results:
        if 'Table' in (r.get('labels') or []):
            table_names.add(r.get('name'))
        elif r.get('tableName'):
            table_names.add(r.get('tableName'))
    if not table_names:
        table_names = {t['Name'] for t in tables}
    print(f"  Relevant tables: {table_names}")

    # Get full context
    context = get_table_context(graph_id, table_names)
    print(f"  Context items: {len(context)}")

    # Step 5
    print("\n== Step 5: Generate SQL ==")
    sql = generate_sql(question, context)
    print(f"  SQL: {sql}")

    # Step 6
    print("\n== Step 6: Execute via Athena ==")
    results = execute_athena(sql)
    if results:
        print(f"  Results ({len(results)} rows):")
        for r in results:
            print(f"    {r}")
    else:
        print("  No results or query failed")

    print(f"\n[{datetime.now()}] 全链路测试完成")
    print(f"Graph ID: {graph_id}")

if __name__ == '__main__':
    main()
