const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? 'http://ollama.percussionist.svc.cluster.local:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';

export interface EmbeddingResult {
  embedding: number[];
}

export async function getEmbedding(text: string): Promise<Float32Array> {
  const url = `${OLLAMA_BASE_URL}/api/embeddings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama embedding failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { embedding: number[] };
  return new Float32Array(data.embedding);
}
