import { StorageProvider, UploadOptions } from './storage-provider';
import config from '../../config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'fs';
import { Logger } from 'winston';
import { ContentType } from '../../types';

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;

  private getClient(): S3Client {
    const s3Config = config.s3CompatibleStorage;
    const clientConfig: S3ClientConfig = {
      region: s3Config.region!,
      credentials: {
        accessKeyId: s3Config.accessKeyId!,
        secretAccessKey: s3Config.secretAccessKey!,
      },
      forcePathStyle: !!s3Config.forcePathStyle,
    };

    if (s3Config.endpoint) {
      clientConfig.endpoint = s3Config.endpoint;
    }

    return new S3Client(clientConfig);
  }

  validateConfig(): void {
    const s3 = config.s3CompatibleStorage;
    const missing: string[] = [];
    if (!s3.region) missing.push('S3_REGION');
    if (!s3.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
    if (!s3.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
    if (!s3.bucket) missing.push('S3_BUCKET_NAME');
    if (missing.length) {
      throw new Error(
        `S3 compatible storage configuration is not set or incomplete. Missing: ${missing.join(', ')}`,
      );
    }
  }

  async uploadFile(options: UploadOptions): Promise<boolean> {
    this.validateConfig();
    const s3Client = this.getClient();

    try {
      options.logger.info(`Starting upload of ${options.key}`);
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: config.s3CompatibleStorage.bucket!,
          Key: options.key,
          Body: createReadStream(options.filePath),
          ContentType: options.contentType,
        },
        queueSize: options.concurrency || 4,
        partSize: options.partSize || 50 * 1024 * 1024,
      });

      upload.on('httpUploadProgress', (progress) => {
        options.logger.info(
          `Uploaded ${options.key} ${progress.loaded} of ${progress.total || 0} bytes`,
        );
      });

      await upload.done();
      options.logger.info(`Upload of ${options.key} complete.`);
      return true;
    } catch (err) {
      options.logger.error(`Upload for ${options.key} failed.`, err);
      return false;
    }
  }

  async uploadBuffer(
    buffer: Buffer,
    key: string,
    contentType: ContentType,
    logger: Logger,
  ): Promise<boolean> {
    this.validateConfig();
    const s3Client = this.getClient();

    try {
      logger.info(`Starting buffer upload of ${key}`);
      const command = new PutObjectCommand({
        Bucket: config.s3CompatibleStorage.bucket!,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      });

      await s3Client.send(command);
      logger.info(`Buffer upload of ${key} complete.`);
      return true;
    } catch (err) {
      logger.error(`Buffer upload for ${key} failed.`, err);
      return false;
    }
  }

  async getSignedUrl(
    key: string,
    options?: { expiresInSeconds?: number; contentType?: string },
  ): Promise<string> {
    this.validateConfig();
    const s3Client = this.getClient();

    try {
      const command = new GetObjectCommand({
        Bucket: config.s3CompatibleStorage.bucket!,
        Key: key,
        ResponseContentType: options?.contentType,
      });

      return await getSignedUrl(s3Client, command, {
        expiresIn: options?.expiresInSeconds || 3600,
      });
    } catch (err) {
      throw new Error(`Failed to generate signed URL for S3: ${err}`);
    }
  }
}
