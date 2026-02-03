/**
 * Manus File Upload Utilities
 * Handles uploading files to Manus via the Files API
 */

const MANUS_API_URL = process.env.MANUS_API_URL || 'https://api.manus.ai';
const MANUS_API_KEY = process.env.MANUS_API_KEY;

if (!MANUS_API_KEY) {
  throw new Error('MANUS_API_KEY environment variable is required');
}

interface ManusFile {
  id: string;
  object: string;
  filename: string;
  status: string;
  upload_url: string;
  upload_expires_at: string;
  created_at: string;
}

/**
 * Upload a file to Manus
 * Returns the file ID that can be used in task attachments
 */
export async function uploadFileToManus(
  fileBuffer: Buffer,
  filename: string
): Promise<string> {
  try {
    // Step 1: Create file record and get presigned URL
    const createResponse = await fetch(`${MANUS_API_URL}/v1/files`, {
      method: 'POST',
      headers: {
        'API_KEY': MANUS_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename }),
    });

    if (!createResponse.ok) {
      const error = await createResponse.text();
      throw new Error(`Failed to create file record: ${error}`);
    }

    const fileRecord = await createResponse.json() as ManusFile;

    // Step 2: Upload file content to presigned URL
    const uploadResponse = await fetch(fileRecord.upload_url, {
      method: 'PUT',
      body: fileBuffer,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload file content: ${uploadResponse.statusText}`);
    }

    console.log(`✅ Uploaded file to Manus: ${filename} (ID: ${fileRecord.id})`);
    return fileRecord.id;
  } catch (error) {
    console.error('Failed to upload file to Manus:', error);
    throw error;
  }
}

/**
 * Upload multiple files to Manus
 * Returns array of file IDs
 */
export async function uploadFilesToManus(
  files: Array<{ buffer: Buffer; filename: string }>
): Promise<string[]> {
  const fileIds: string[] = [];

  for (const file of files) {
    try {
      const fileId = await uploadFileToManus(file.buffer, file.filename);
      fileIds.push(fileId);
    } catch (error) {
      console.error(`Failed to upload ${file.filename}:`, error);
      // Continue with other files
    }
  }

  return fileIds;
}
