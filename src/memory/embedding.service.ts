import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

const EMBEDDING_MODEL = 'text-embedding-3-small' as const;
const EMBEDDING_DIMENSIONS = 1536 as const;
const MAX_EMBED_CHARS = 24_000;

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly openai: OpenAI | null;

  constructor() {
    this.openai = process.env.OPENAI_API_KEY?.trim()
      ? new OpenAI()
      : null;
    if (!this.openai) {
      this.logger.warn('OPENAI_API_KEY not set — embeddings disabled');
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.openai) return new Array(EMBEDDING_DIMENSIONS).fill(0);

    const truncated = text.slice(0, MAX_EMBED_CHARS);

    const response = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncated,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    const vector = response.data[0]?.embedding;
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `EmbeddingService: unexpected vector length ${vector?.length ?? 0}`,
      );
    }

    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.openai) return texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0));

    const truncated = texts.map((t) => t.slice(0, MAX_EMBED_CHARS));

    this.logger.debug(`Embedding batch of ${texts.length} texts`);

    const response = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncated,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    return response.data
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
      .map((d: { embedding: number[] }) => d.embedding);
  }

  static toSql(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }
}
