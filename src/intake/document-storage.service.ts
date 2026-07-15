import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class DocumentStorageService {
  private readonly bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'project-documents';

  private get config(): { url: string; key: string } {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) {
      throw new ServiceUnavailableException(
        'Document storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      );
    }
    return { url, key };
  }

  async upload(storageKey: string, buffer: Buffer, mimeType: string): Promise<void> {
    const { url, key } = this.config;
    const response = await fetch(`${url}/storage/v1/object/${this.bucket}/${storageKey}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        'Content-Type': mimeType,
        'x-upsert': 'false',
      },
      // Node's Buffer is accepted by undici at runtime, but its DOM type is
      // narrower than Buffer in this project configuration.
      body: buffer as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new BadRequestException(`Unable to store document: ${await response.text()}`);
    }
  }

  async download(storageKey: string): Promise<Buffer> {
    const { url, key } = this.config;
    const response = await fetch(`${url}/storage/v1/object/${this.bucket}/${storageKey}`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });
    if (!response.ok) {
      throw new BadRequestException(`Unable to retrieve document: ${await response.text()}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
