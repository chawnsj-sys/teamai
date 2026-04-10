#!/usr/bin/env python3
"""
extractMemories v3:
1. Programmatic snapshot extraction (SQL + result from session jsonl)
2. Strict LLM extraction for rule/preference (only from user messages)
"""
import sys, json, re, boto3, urllib.request as ur

REGION = 'us-east-1'
MEM0 = 'http://127.0.0.1:3005'
bedrock = boto3.client('bedrock-runtime', region_name=REGION)

def read_session(session_file, last_ts):
    """Read all entries after lastExtractedAt"""
    entries = []
    try:
        with open(session_file, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    ts = entry.get('timestamp', '')
                    if ts and last_ts and ts <= last_ts:
                        continue
                    entries.append(entry)
                except:
                    continue
    except:
        pass
    return entries

def clean_user_content(content):
    """Clean user message: remove System: prefix, memory context, intent confirmation format.
    Returns the cleaned question text. For intent confirmations, extracts a summary from the items."""
    if isinstance(content, list):
        content = ' '.join(b.get('text','') for b in content if isinstance(b,dict) and b.get('type')=='text')
    if not isinstance(content, str) or len(content) < 5:
        return ''
    
    clean = content
    
    # If has [请回答以下问题], take everything after it
    if '[请回答以下问题]' in clean:
        clean = clean.split('[请回答以下问题]')[-1].strip()
    elif clean.startswith('System:'):
        # Strip System: tool output prefix, find actual content
        if '【需求已确认' in clean:
            clean = clean[clean.index('【需求已确认'):]
        else:
            lines = clean.split('\n')
            found = False
            result_lines = []
            for line in lines:
                if found:
                    result_lines.append(line)
                elif not line.startswith('System:') and not line.startswith('"') and len(line.strip()) > 3:
                    found = True
                    result_lines.append(line)
            clean = '\n'.join(result_lines)
    
    # Strip memory context block
    clean = re.sub(r'\[仅供参考.*?\[请回答以下问题\]\s*', '', clean, flags=re.DOTALL)
    clean = re.sub(r'\[历史记忆\].*?\n\n', '', clean, flags=re.DOTALL)
    clean = re.sub(r'\[知识库\].*?\n\n', '', clean, flags=re.DOTALL)
    clean = re.sub(r'\[meta\].*?\n', '', clean)
    clean = re.sub(r'\[user\]\s*', '', clean)
    
    # For intent confirmations, extract a question summary from the structured items
    # BEFORE removing them
    if '【需求已确认' in clean or '分析对象' in clean:
        items = []
        for label in ['分析对象', '分析指标', '过滤条件', '时间范围', '拆分维度', '分组维度', '排序方式', '结果数量', '涉及数据']:
            m = re.search(label + r'[：:]\s*(.+)', clean)
            if m:
                val = m.group(1).strip()
                if val and len(val) > 1:
                    items.append(val)
        if items:
            return '，'.join(items[:3])  # e.g. "各区域的广告投入产出比，ROI，排除测试渠道"
    
    # Remove intent confirmation prefix and structured items
    clean = re.sub(r'【需求已确认[^】]*】\s*', '', clean)
    clean = re.sub(r'(分析对象|分析指标|过滤条件|时间范围|拆分维度)[：:][^\n]*\n?', '', clean)
    clean = re.sub(r'```sql[\s\S]*?```', '', clean)
    clean = re.sub(r'请执行这条 SQL 并分析结果。?', '', clean)
    clean = re.sub(r'\[message_id:.*?\]', '', clean)
    
    return clean.strip()
def extract_snapshots(entries):
    """Programmatic: find toolCall(SQL) + user question + toolResult"""
    snapshots = []
    last_user_msg = ''
    last_sql = ''
    
    for entry in entries:
        msg = entry.get('message', {})
        role = msg.get('role', '')
        
        if role == 'user':
            cleaned = clean_user_content(msg.get('content', ''))
            if cleaned and len(cleaned) > 3:
                last_user_msg = cleaned[:200]
        
        elif role == 'assistant':
            content = msg.get('content', [])
            if isinstance(content, list):
                for block in content:
                    if block.get('type') == 'toolCall' and block.get('name') == 'exec':
                        cmd = (block.get('arguments') or {}).get('command', '')
                        sql_match = re.search(r'--query-string\s+"([^"]+)"', cmd, re.DOTALL) or \
                                    re.search(r"--query-string\s+'([^']+)'", cmd, re.DOTALL)
                        if sql_match:
                            last_sql = sql_match.group(1).strip()
        
        elif role == 'toolResult':
            # Result can be in details.aggregated or content[0].text
            result_text = ''
            details = msg.get('details', {})
            if details.get('aggregated'):
                result_text = details['aggregated']
            else:
                content_list = msg.get('content', [])
                if isinstance(content_list, list):
                    for block in content_list:
                        if isinstance(block, dict) and block.get('text'):
                            result_text = block['text']
                            break
            is_valid = len(result_text) > 500 and 'error' not in result_text[:100].lower() and 'still running' not in result_text[:80].lower() and ('\t' in result_text or '|' in result_text or 'GetQueryResults' in result_text)
            if last_sql and last_user_msg and is_valid:
                snapshot_text = last_user_msg
                # Dedup: skip if same SQL already captured
                if not any(s['metadata']['sql'] == last_sql for s in snapshots):
                    snapshots.append({
                        'text': snapshot_text,
                        'type': 'snapshot',
                        'metadata': {'sql': last_sql, 'question': last_user_msg}
                    })
                last_sql = ''
    
    return snapshots

def extract_user_messages(entries):
    """Get only user messages for LLM analysis"""
    msgs = []
    for entry in entries:
        msg = entry.get('message', {})
        if msg.get('role') == 'user':
            cleaned = clean_user_content(msg.get('content', ''))
            if cleaned and len(cleaned) > 3:
                msgs.append(cleaned[:300])
    return msgs

def extract_rules_preferences(user_messages):
    """LLM: strict extraction of rule/preference from user messages only"""
    if not user_messages:
        return []
    
    conv = "\n".join(f"- {m}" for m in user_messages)
    
    prompt = f"""分析以下用户消息，提取值得长期记住的规则和偏好。

用户消息：
{conv}

严格标准：
- rule: 只有用户明确说出的业务规则才算（如"以后分析都排除测试渠道""高价值客户是消费>500的"）。用户必须用了"以后""排除""不要""应该"等表达。一次性的分析请求（如"帮我查ROI"）不是规则。
- preference: 只有用户明确表达的展示偏好才算（如"我喜欢先看汇总""用人民币显示"）。Agent 自己选择的展示方式不算。
- 不要提取：一次性分析请求、闲聊、确认语、Agent的技术细节

输出 JSON 数组：
[{{"text": "提炼内容", "type": "rule 或 preference"}}]

如果没有值得记住的规则或偏好，输出 []。
只输出 JSON。"""

    try:
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 500,
            "messages": [{"role": "user", "content": prompt}]
        })
        resp = bedrock.invoke_model(
            modelId="us.anthropic.claude-sonnet-4-20250514-v1:0",
            body=body, contentType="application/json"
        )
        text = json.loads(resp['body'].read())['content'][0]['text'].strip()
        if '```json' in text:
            text = text.split('```json')[1].split('```')[0].strip()
        elif '```' in text:
            text = text.split('```')[1].split('```')[0].strip()
        return json.loads(text)
    except Exception as e:
        print(f"[extract] LLM error: {e}", file=sys.stderr)
        return []

def store_to_mem0(agent_id, memories):
    """Write memories directly to OpenSearch via /add-raw (no LLM, no Mem0)."""
    stored = []
    for mem in memories:
        try:
            metadata = {"type": mem.get('type', 'other'), "source": "extract-agent"}
            if mem.get('metadata'):
                metadata.update(mem['metadata'])
            
            payload = json.dumps({
                "agentId": agent_id,
                "text": mem['text'],
                "metadata": metadata
            }).encode()
            req = ur.Request(f"{MEM0}/add-raw", data=payload, headers={"Content-Type": "application/json"}, method="POST")
            resp = ur.urlopen(req, timeout=20)
            result = json.loads(resp.read().decode())
            stored.append({"text": mem['text'][:60], "type": metadata.get('type', '?'), "ok": result.get('ok', False)})
        except Exception as e:
            stored.append({"text": mem['text'][:60], "error": str(e)})
    return stored



def extract_intent_preferences(entries):
    """Extract preferences by diffing original question vs confirmed items.
    When user supplements conditions during intent confirmation loop,
    those supplements should be extracted as preferences."""
    preferences = []
    for entry in entries:
        msg = entry.get('message', {})
        if msg.get('role') != 'user':
            continue
        content = msg.get('content', '')
        if isinstance(content, list):
            content = ' '.join(b.get('text','') for b in content if isinstance(b,dict) and b.get('type')=='text')
        if not isinstance(content, str):
            continue
        
        # Only process intent confirmation messages
        if '【需求已确认' not in content or '原始提问：' not in content:
            continue
        
        # Extract original question
        orig_match = re.search(r'原始提问：(.+?)\n', content)
        if not orig_match:
            continue
        original = orig_match.group(1).strip().lower()
        
        # Extract confirmed items
        items = {}
        for label in ['过滤条件', '时间范围', '分组维度', '排序方式', '结果数量']:
            m = re.search(label + r'[：:]\s*(.+)', content)
            if m:
                val = m.group(1).strip()
                # Skip default/empty values
                if val and val not in ['（无）', '（未限定）', '（无排序）', '全量', '无', '无排序']:
                    items[label] = val
        
        # Diff: if a confirmed item's value is NOT mentioned in the original question,
        # it was supplemented by the user during the confirmation loop
        for label, val in items.items():
            # Simple check: are key words from the value present in original question?
            val_lower = val.lower()
            key_words = [w for w in re.split(r'[，、,\s]+', val_lower) if len(w) > 1]
            mentioned = any(kw in original for kw in key_words)
            if not mentioned:
                pref_text = f"用户偏好：{label}为{val}"
                preferences.append({"text": pref_text, "type": "preference"})
    
    return preferences

if __name__ == '__main__':
    data = json.loads(sys.stdin.read())
    agent_id = data.get('agentId', 'unknown')
    session_file = data.get('sessionFile', '')
    last_ts = data.get('lastExtractedAt', '')

    entries = read_session(session_file, last_ts)
    if not entries:
        print(json.dumps({"extracted": [], "newTimestamp": last_ts, "reason": "no new entries"}))
        sys.exit(0)

    # 1. Programmatic snapshot extraction
    snapshots = extract_snapshots(entries)
    
    # 2. LLM rule/preference extraction (user messages only)
    user_msgs = extract_user_messages(entries)
    rules_prefs = extract_rules_preferences(user_msgs)
    
    # 3. Intent confirmation diff (user supplements → preference)
    intent_prefs = extract_intent_preferences(entries)
    
    # Combine
    all_memories = snapshots + rules_prefs + intent_prefs
    
    if not all_memories:
        new_ts = entries[-1].get('timestamp', '') if entries else last_ts
        print(json.dumps({"extracted": [], "newTimestamp": new_ts, "reason": "nothing worth remembering"}))
        sys.exit(0)

    # Store
    stored = store_to_mem0(agent_id, all_memories)
    new_ts = entries[-1].get('timestamp', '') if entries else last_ts
    
    print(json.dumps({"extracted": stored, "newTimestamp": new_ts}, ensure_ascii=False))
