#!/usr/bin/env python3
"""Auto Dream: consolidate agent memories — merge duplicates, upgrade types, clean noise"""
import json, sys, boto3, urllib.request as ur

REGION = 'us-east-1'
MEM0 = 'http://127.0.0.1:3005'
bedrock = boto3.client('bedrock-runtime', region_name=REGION)

def list_memories(agent_id, limit=50):
    resp = ur.urlopen(f'{MEM0}/list?agentId={agent_id}&limit={limit}', timeout=10)
    data = json.loads(resp.read().decode())
    return data.get('records', [])

def delete_memory(memory_id):
    import subprocess
    subprocess.run(["curl", "-s", "-X", "DELETE", f"{MEM0}/delete/{memory_id}"], timeout=10)
    return

def _old_delete_memory(memory_id):
    req = ur.Request(f'{MEM0}/delete', data=json.dumps({"id": memory_id}).encode(),
                     method="DELETE")
    ur.urlopen(req, timeout=10)

def add_memory(agent_id, text, mem_type):
    import subprocess
    payload = json.dumps({"agentId": agent_id, "text": text, "metadata": {"type": mem_type, "source": "auto-dream"}})
    subprocess.run(["curl", "-s", "-X", "POST", f"{MEM0}/add-raw", "-H", "Content-Type: application/json", "-d", payload], timeout=20)
    return

def _old_add_memory(agent_id, text, mem_type):
    payload = json.dumps({
        "agentId": agent_id,
        "text": text,
        "metadata": {"type": mem_type, "source": "auto-dream"}
    }).encode()
    req = ur.Request(f'{MEM0}/add-raw', data=payload,
                     method="DELETE")
    ur.urlopen(req, timeout=20)

def consolidate_with_llm(memories):
    """Ask LLM to analyze and consolidate memories"""
    mem_list = []
    for i, m in enumerate(memories):
        t = m.get('metadata', {}).get('type', '?')
        ts = m.get('createdAt', '')[:10]
        mem_list.append(f"{i+1}. [{t}] {m['text'][:200]} ({ts})")
    
    mem_str = '\n'.join(mem_list)
    
    prompt = f"""你是 Data Agent 的记忆整理助手。以下是一个 Agent 的所有记忆，请整理。

## 当前记忆
{mem_str}

## 整理规则
1. **合并重复**：内容相同或高度相似的记忆合并为一条，保留最新日期
2. **升级类型**：出现 3 次以上的 preference → 升级为 rule（说明用户一直这么用）
3. **清理噪音**：没有实际价值的记忆标记删除（如"时间范围为未限定"、空内容、无意义的默认值）
4. **精炼文本**：合并后的记忆用简洁的业务语言描述，去掉"用户偏好："前缀
5. **保留 snapshot**：snapshot 类型的记忆不合并，只清理明显重复的

## 输出 JSON 数组
每条记忆必须有一个 action：
- "keep": 保留不变
- "merge": 合并多条为一条（提供 merged_text 和 new_type）
- "delete": 删除

格式：
[
  {{"action": "keep", "ids": [7], "reason": "唯一的 snapshot"}},
  {{"action": "merge", "ids": [1,2,3], "merged_text": "查询时默认过滤中国区域", "new_type": "rule", "reason": "出现3次，升级为规则"}},
  {{"action": "delete", "ids": [6], "reason": "无实际价值"}}
]

注意：ids 是上面记忆列表的序号（从1开始）。每条记忆必须出现在某个 action 中，不能遗漏。
只输出 JSON 数组。"""

    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2000,
        "messages": [{"role": "user", "content": prompt}]
    })
    resp = bedrock.invoke_model(modelId="us.anthropic.claude-sonnet-4-20250514-v1:0",
                                body=body, contentType="application/json")
    text = json.loads(resp['body'].read())['content'][0]['text'].strip()
    if '```json' in text:
        text = text.split('```json')[1].split('```')[0].strip()
    elif '```' in text:
        text = text.split('```')[1].split('```')[0].strip()
    return json.loads(text)

def execute_plan(agent_id, memories, plan, dry_run=False):
    """Execute the consolidation plan"""
    results = []
    
    for action in plan:
        ids = action.get('ids', [])
        act = action.get('action', '')
        reason = action.get('reason', '')
        
        if act == 'keep':
            results.append(f"  KEEP [{','.join(str(i) for i in ids)}]: {reason}")
        
        elif act == 'delete':
            for idx in ids:
                mem = memories[idx - 1]
                if dry_run:
                    results.append(f"  DELETE [{idx}]: {mem['text'][:60]}... ({reason})")
                else:
                    try:
                        delete_memory(mem['id'])
                        results.append(f"  DELETED [{idx}]: {mem['text'][:60]}... ({reason})")
                    except Exception as e:
                        results.append(f"  DELETE FAILED [{idx}]: {e}")
        
        elif act == 'merge':
            merged_text = action.get('merged_text', '')
            new_type = action.get('new_type', 'preference')
            
            if dry_run:
                results.append(f"  MERGE [{','.join(str(i) for i in ids)}] → [{new_type}] {merged_text} ({reason})")
            else:
                # Delete old memories
                for idx in ids:
                    mem = memories[idx - 1]
                    try:
                        delete_memory(mem['id'])
                    except: pass
                # Add merged memory
                try:
                    add_memory(agent_id, merged_text, new_type)
                    results.append(f"  MERGED [{','.join(str(i) for i in ids)}] → [{new_type}] {merged_text} ({reason})")
                except Exception as e:
                    results.append(f"  MERGE FAILED: {e}")
    
    return results

if __name__ == '__main__':
    agent_id = sys.argv[1] if len(sys.argv) > 1 else 'aws-expert'
    dry_run = '--dry-run' in sys.argv
    
    print(f"{'[DRY RUN] ' if dry_run else ''}Auto Dream for {agent_id}")
    print("=" * 60)
    
    # Step 1: List all memories
    memories = list_memories(agent_id)
    print(f"Found {len(memories)} memories")
    
    if len(memories) < 3:
        print("Too few memories, skipping")
        sys.exit(0)
    
    # Step 2: Ask LLM to consolidate
    print("\nAsking LLM to analyze...")
    plan = consolidate_with_llm(memories)
    print(f"Plan: {len(plan)} actions")
    
    # Step 3: Execute plan
    print(f"\n{'Plan (dry run):' if dry_run else 'Executing:'}")
    results = execute_plan(agent_id, memories, plan, dry_run)
    for r in results:
        print(r)
    
    # Step 4: Summary
    if not dry_run:
        new_memories = list_memories(agent_id)
        print(f"\nBefore: {len(memories)} → After: {len(new_memories)}")
