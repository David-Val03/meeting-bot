import config from './src/config';
import { S3StorageProvider } from './src/uploader/providers/s3-storage-provider';

console.log('--- S3 Configuration Debug ---');
console.log(`UPLOADER_TYPE: ${process.env.UPLOADER_TYPE || 'default (s3)'}`);
console.log(`Configured Provider: ${config.uploaderType}`);

if (config.uploaderType === 's3') {
  const provider = new S3StorageProvider();
  try {
    provider.validateConfig();
    console.log('✅ S3 Configuration is VALID.');
  } catch (error: any) {
    console.error('❌ S3 Configuration is INVALID:');
    console.error(error.message);
  }
} else {
  console.log(
    `Skipping S3 validation because uploader type is ${config.uploaderType}`,
  );
}
console.log('------------------------------');
