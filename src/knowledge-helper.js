// Knowledge Base helper for TeamAI
// Uses Bedrock Knowledge Base with S3 + OpenSearch Serverless

const { BedrockAgentRuntimeClient, RetrieveCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { BedrockAgentClient, StartIngestionJobCommand } = require('@aws-sdk/client-bedrock-agent');
const fs = require('fs');
const path = require('path');

const REGION = 'us-east-1';
const KB_ID = process.env.KB_ID || '';
const DS_ID = process.env.DS_ID || '';
const S3_BUCKET = process.env.KB_S3_BUCKET || '';

const runtimeClient = new BedrockAgentRuntimeClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });
const agentClient = new BedrockAgentClient({ region: REGION });

// Retrieve relevant knowledge for an agent
async function searchKnowledge(agentId, query, topK = 3) {
  try {
    const searchConfig = { numberOfResults: topK };
    // PM searches all agents' knowledge base, others only search their own
    if (agentId !== 'pm') {
      searchConfig.filter = { equals: { key: 'agentId', value: agentId } };
    }
    const response = await runtimeClient.send(new RetrieveCommand({
      knowledgeBaseId: KB_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: { vectorSearchConfiguration: searchConfig }
    }));
    const results = (response.retrievalResults || []).map(r => ({
      text: r.content?.text || '',
      score: r.score || 0,
      source: r.location?.s3Location?.uri || ''
    })).filter(r => r.text && r.score > 0.3);
    if (results.length > 0) {
      console.log('[kb] found ' + results.length + ' results for ' + agentId + ', query=' + query.substring(0, 40));
    }
    return results;
  } catch (e) {
    console.error('[kb] search error:', e.message);
    return [];
  }
}

// Upload a file to S3 for an agent
async function uploadKnowledge(agentId, filename, content) {
  try {
    // Use safe ASCII filename for S3 key, keep original name in metadata
    const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
    const safeFilename = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + ext;
    const key = agentId + '/' + safeFilename;
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: content
    }));
    // Upload metadata with agentId and original filename
    const metaKey = key + '.metadata.json';
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: metaKey,
      Body: JSON.stringify({ metadataAttributes: { agentId: agentId, originalName: filename } }),
      ContentType: 'application/json'
    }));
    console.log('[kb] uploaded ' + key + ' (original: ' + filename + ')');
    return { key, bucket: S3_BUCKET, originalName: filename };
  } catch (e) {
    console.error('[kb] upload error:', e.message);
    throw e;
  }
}

// Delete a file from S3
async function deleteKnowledge(agentId, filename) {
  try {
    const key = agentId + '/' + filename;
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key + '.metadata.json' }));
    console.log('[kb] deleted ' + key);
  } catch (e) {
    console.error('[kb] delete error:', e.message);
  }
}

// List files for an agent
async function listKnowledge(agentId) {
  try {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: agentId + '/'
    }));
    const files = (response.Contents || []).filter(obj => !obj.Key.endsWith('.metadata.json'));
    // Try to read original names from metadata files
    const result = [];
    for (const f of files) {
      let displayName = f.Key.split('/').pop();
      try {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const metaResp = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: f.Key + '.metadata.json' }));
        const metaBody = await metaResp.Body.transformToString();
        const meta = JSON.parse(metaBody);
        if (meta.metadataAttributes?.originalName) displayName = meta.metadataAttributes.originalName;
      } catch (e) {}
      result.push({ filename: f.Key.split('/').pop(), displayName, key: f.Key, size: f.Size, lastModified: f.LastModified });
    }
    return result;
  } catch (e) {
    console.error('[kb] list error:', e.message);
    return [];
  }
}

// Trigger re-ingestion after upload/delete
async function syncKnowledge() {
  try {
    const response = await agentClient.send(new StartIngestionJobCommand({
      knowledgeBaseId: KB_ID,
      dataSourceId: DS_ID
    }));
    console.log('[kb] ingestion started: ' + response.ingestionJob?.ingestionJobId);
    return response.ingestionJob?.ingestionJobId;
  } catch (e) {
    console.error('[kb] sync error:', e.message);
    return null;
  }
}

module.exports = { searchKnowledge, uploadKnowledge, deleteKnowledge, listKnowledge, syncKnowledge, upsertKnowledge, KB_ID, S3_BUCKET };

// Upsert: delete existing file with same originalName, then upload new one
async function upsertKnowledge(agentId, filename, content) {
  try {
    // Find and delete existing file with same originalName
    const existing = await listKnowledge(agentId);
    for (const f of existing) {
      if (f.displayName === filename) {
        await deleteKnowledge(agentId, f.filename);
        console.log('[kb] upsert: deleted old ' + f.filename + ' (' + filename + ')');
      }
    }
    // Upload new
    const result = await uploadKnowledge(agentId, filename, content);
    console.log('[kb] upsert: uploaded new ' + filename);
    return result;
  } catch (e) {
    console.error('[kb] upsert error:', e.message);
    throw e;
  }
}
