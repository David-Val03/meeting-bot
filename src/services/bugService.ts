import { NODE_ENV } from '../config';
import { Logger } from 'winston';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

interface UploadOption {
  skipTimestamp?: boolean;
}

const awsUpload = async (file: Buffer, Key: string) => {
  const s3 = new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: process.env.AWS_BUCKET_NAME!,
      Key,
      Body: file,
      ContentType: 'image/png',
    },
  });

  return upload.done();
};

export const uploadDebugImage = async (
  buffer: Buffer,
  fileName: string,
  userId: string,
  logger: Logger,
  botId?: string,
  opts?: UploadOption,
): Promise<string | undefined> => {
  try {
    if (NODE_ENV === 'development') {
      return undefined;
    }

    const bot = botId ?? 'bot';
    const now = opts?.skipTimestamp ? '' : `-${new Date().toISOString()}`;
    const folder = process.env.GCP_MISC_BUCKET_FOLDER ?? 'meeting-bot';
    const key = `${folder}/${userId}/${bot}/${fileName}${now}.png`;

    const uploadedFile = await awsUpload(buffer, key);
    console.log('uploadedFile', uploadedFile);

    if (uploadedFile?.Location) {
      return uploadedFile.Location;
    }

    return undefined;
  } catch (err) {
    logger.error('Error uploading debug image', err);
    return undefined;
  }
};
