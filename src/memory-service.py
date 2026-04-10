#!/usr/bin/env python3
"""Memory Service — Direct OpenSearch + Bedrock (no Mem0)"""
from flask import Flask, request, jsonify
import boto3, json, os, traceback, uuid
from datetime import datetime
from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth

app = Flask(__name__)

REGION = "us-east-1"
AOSS_HOST = "oct9h9hbemkyv6h7l9b4.us-east-1.aoss.amazonaws.com"
INDEX_NAME = "mem0-teamai"
EMBED_MODEL = "amazon.titan-embed-text-v2:0"
EMBED_DIMS = 1024

# Initialize clients
credentials = boto3.Session().get_credentials()
auth = AWSV4SignerAuth(credentials, REGION, "aoss")

os_client = OpenSearch(
    hosts=[{"host": AOSS_HOST, "port": 443}],
    http_auth=auth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    pool_maxsize=20
)

bedrock = boto3.client("bedrock-runtime", region_name=REGION)
print("[memory] Initialized with OpenSearch + Bedrock (no Mem0)")


def get_embedding(text):
    """Get embedding from Bedrock Titan"""
    resp = bedrock.invoke_model(
        modelId=EMBED_MODEL,
        body=json.dumps({"inputText": text[:8000]}),
        contentType="application/json"
    )
    return json.loads(resp["body"].read())["embedding"]




# ============================================================
# API Endpoints
# ============================================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "backend": "opensearch-direct"})


@app.route("/store", methods=["POST"])
def store():
    """Store a memory record. Embeds text and writes directly to OpenSearch (no LLM)."""
    try:
        data = request.json
        agent_id = data.get("agentId", "unknown")
        user_msg = data.get("userMessage", "")
        channel = data.get("channel", "unknown")
        metadata = data.get("metadata", {})
        metadata["channel"] = channel
        metadata["source"] = metadata.get("source", "conversation")

        # Filter trivial
        if len(user_msg.strip()) < 5 or user_msg.strip() in ['你好','谢谢','hi','thanks','ok','好的','嗯']:
            return jsonify({"ok": True, "stored": False, "reason": "trivial"})

        # Type comes from caller (extract-helper sets it); default to 'other'
        if "type" not in metadata:
            metadata["type"] = "other"
        if data.get("sql"):
            metadata["sql"] = data["sql"][:2000]
        if data.get("resultData"):
            rd = data["resultData"]
            metadata["resultData"] = rd if isinstance(rd, str) else json.dumps(rd, ensure_ascii=False)[:3000]

        # Embed and write
        mem_id = str(uuid.uuid4())
        embedding = get_embedding(user_msg)
        doc = {
            "vector_field": embedding,
            "id": mem_id,
            "payload": {
                "memory": user_msg,
                "user_id": agent_id,
                "metadata": metadata,
                "created_at": datetime.utcnow().isoformat() + "Z"
            }
        }
        os_client.index(index=INDEX_NAME, body=doc)
        print(f"[memory] store: id={mem_id} agent={agent_id} type={metadata.get('type','?')} text={user_msg[:50]}")
        return jsonify({"ok": True, "id": mem_id, "type": metadata.get("type", "")})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/add-raw", methods=["POST"])
def add_raw():
    """Direct write: embed + insert, no classification. Used by extract-helper."""
    try:
        data = request.json
        text = data.get("text", "")
        agent_id = data.get("agentId", "unknown")
        metadata = data.get("metadata", {})
        if not text:
            return jsonify({"ok": False, "error": "text required"}), 400

        mem_id = str(uuid.uuid4())
        embedding = get_embedding(text)
        doc = {
            "vector_field": embedding,
            "id": mem_id,
            "payload": {
                "memory": text,
                "user_id": agent_id,
                "metadata": metadata,
                "created_at": datetime.utcnow().isoformat() + "Z"
            }
        }
        os_client.index(index=INDEX_NAME, body=doc)
        print(f"[memory] add-raw: id={mem_id} agent={agent_id} type={metadata.get('type','?')} text={text[:50]}")
        return jsonify({"ok": True, "id": mem_id, "type": metadata.get("type", "")})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/search", methods=["GET"])
def search():
    """Vector search via kNN"""
    try:
        agent_id = request.args.get("agentId", "_all")
        query = request.args.get("q", "")
        top_k = int(request.args.get("topK", "3"))
        if not query:
            return jsonify({"records": []})

        embedding = get_embedding(query)
        knn_query = {"knn": {"vector_field": {"vector": embedding, "k": top_k * 2}}}

        if agent_id and agent_id not in ("_all", "pm"):
            body = {"size": top_k * 2, "query": {"bool": {"must": knn_query, "filter": [{"term": {"payload.user_id.keyword": agent_id}}]}}}
        else:
            body = {"size": top_k * 2, "query": knn_query}

        resp = os_client.search(index=INDEX_NAME, body=body)
        records = []
        for hit in resp["hits"]["hits"][:top_k]:
            payload = hit["_source"].get("payload", {})
            records.append({
                "id": payload.get("id", hit["_id"]),
                "text": payload.get("memory", ""),
                "score": hit.get("_score", 0),
                "metadata": payload.get("metadata", {})
            })
        return jsonify({"records": records})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"records": [], "error": str(e)})


@app.route("/list", methods=["GET"])
def list_memories():
    """List all memories for an agent"""
    try:
        agent_id = request.args.get("agentId")
        limit = int(request.args.get("limit", "50"))

        if agent_id:
            body = {"size": limit, "query": {"bool": {"filter": [{"term": {"payload.user_id.keyword": agent_id}}]}}}
        else:
            body = {"size": limit, "query": {"match_all": {}}}

        resp = os_client.search(index=INDEX_NAME, body=body)
        records = []
        for hit in resp["hits"]["hits"]:
            payload = hit["_source"].get("payload", {})
            records.append({
                "id": payload.get("id", hit["_id"]),
                "text": payload.get("memory", ""),
                "metadata": payload.get("metadata", {}),
                "createdAt": payload.get("created_at", "")
            })
        return jsonify({"records": records, "nextToken": None})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"records": [], "nextToken": None, "error": str(e)})


@app.route("/create", methods=["POST"])
def create():
    """Create a memory record directly (alias for add-raw)"""
    try:
        data = request.json
        text = data.get("text", "")
        agent_id = data.get("agentId", "unknown")
        metadata = data.get("metadata", {})

        mem_id = str(uuid.uuid4())
        embedding = get_embedding(text)
        doc = {
            "vector_field": embedding,
            "id": mem_id,
            "payload": {
                "memory": text,
                "user_id": agent_id,
                "metadata": metadata,
                "created_at": datetime.utcnow().isoformat() + "Z"
            }
        }
        os_client.index(index=INDEX_NAME, body=doc)
        return jsonify({"ok": True, "id": mem_id})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/update/<memory_id>", methods=["PUT"])
def update(memory_id):
    """Update a memory record"""
    try:
        data = request.json
        text = data.get("text")
        metadata = data.get("metadata")

        update_body = {}
        if text:
            # Re-embed and update
            embedding = get_embedding(text)
            update_body["payload.memory"] = text
            update_body["vector_field"] = embedding
        if metadata:
            # Merge metadata
            try:
                existing = os_client.get(index=INDEX_NAME, id=memory_id)
                old_meta = existing["_source"].get("payload", {}).get("metadata", {})
                old_meta.update(metadata)
                update_body["payload.metadata"] = old_meta
            except:
                update_body["payload.metadata"] = metadata

        if update_body:
            os_client.update(index=INDEX_NAME, id=memory_id, body={"doc": update_body})
        return jsonify({"ok": True})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/delete/<memory_id>", methods=["DELETE"])
def delete(memory_id):
    """Delete a memory record"""
    try:
        os_client.delete(index=INDEX_NAME, id=memory_id)
        return jsonify({"ok": True})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500



if __name__ == "__main__":
    app.run(host="127.0.0.1", port=3005, debug=False)
