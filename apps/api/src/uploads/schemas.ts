import { z } from 'zod';

/** Route params and query strings. The request body is multipart, not JSON. */

export const uploadIdParams = z.object({
  id: z.uuid('must be a UUID'),
});

export const listUploadsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Keyset cursor: the id of the last row of the previous page. */
  cursor: z.uuid().optional(),
});

export type UploadIdParams = z.infer<typeof uploadIdParams>;
export type ListUploadsQuery = z.infer<typeof listUploadsQuery>;
