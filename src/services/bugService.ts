import config, { NODE_ENV } from '../config';
import { Logger } from 'winston';
import { getStorageProvider } from '../uploader/providers/factory';

interface UploadOption {
  skipTimestamp?: boolean;
}

// TODO Save to local volume for development
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
      // TODO add disk based file saving
      return undefined;
    }
    logger.info('Begin upload Debug Image', userId);

    const provider = getStorageProvider();

    // Validate config before upload
    try {
      provider.validateConfig();
    } catch (configError) {
      logger.error('Storage provider configuration is invalid:', configError);
      return undefined;
    }

    const bot = botId ?? 'bot';
    const now = opts?.skipTimestamp ? '' : `-${new Date().toISOString()}`;
    // Use the configured misc folder or default to meeting-bot
    const folder = config.miscStorageFolder ?? 'meeting-bot';
    const qualifiedFile = `${folder}/${userId}/${bot}/${fileName}${now}.png`;

    const success = await provider.uploadBuffer(
      buffer,
      qualifiedFile,
      'image/png',
      logger,
    );

    if (success) {
      logger.info(
        `Debug Image File uploaded successfully: ${fileName}`,
        userId,
      );

      // Attempt to get a URL for the uploaded file
      if (provider.getSignedUrl) {
        try {
          return await provider.getSignedUrl(qualifiedFile, {
            expiresInSeconds: 3600 * 24 * 7,
          });
        } catch (e) {
          logger.warn('Failed to get signed URL for debug image:', e);
        }
      }

      // Fallback for GCS if bucket is set (to maintain old behavior for now)
      if (config.miscStorageBucket && (provider as any).name === 'google') {
        return `https://storage.googleapis.com/${config.miscStorageBucket}/${qualifiedFile}`;
      }

      return undefined;
    } else {
      logger.error(`Debug Image File upload failed: ${fileName}`, userId);
      return undefined;
    }
  } catch (err) {
    logger.error('Error uploading debug image:', userId, err);
    return undefined;
  }
};
