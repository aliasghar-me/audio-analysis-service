import type { FastifyInstance } from 'fastify';
import type { OutlierPolicy } from '../audio/duration.js';
import { AppError } from '../http/errors.js';
import type { FileStore } from '../storage/store.js';
import { toUploadView } from './presenter.js';
import type { UploadsRepository } from './repository.js';
import { listUploadsQuery, uploadIdParams } from './schemas.js';
import type { UploadsService } from './service.js';

export interface UploadRoutesDeps {
  service: UploadsService;
  repository: UploadsRepository;
  store: FileStore;
  outlierPolicy: OutlierPolicy;
}

/** RFC 5987: keep ASCII for old clients, and send UTF-8 for everyone else. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function registerUploadRoutes(
  app: FastifyInstance,
  deps: UploadRoutesDeps,
): Promise<void> {
  const { service, repository, store, outlierPolicy } = deps;

  /**
   * 201 when a row was created, 200 when these bytes were already on record.
   *
   * A duplicate is not an error and not a conflict — it is the successful,
   * idempotent outcome this feature exists to produce — so it carries the full
   * analysis in the same shape as a new upload. A client that ignores the
   * `duplicate` flag still gets a correct, useful answer.
   */
  app.post('/api/upload', async (request, reply) => {
    const part = await request.file();
    if (!part) {
      throw new AppError('NO_FILE', 'No file was included in the request.');
    }

    // `request.file()` hands back the first file part whatever it is called.
    // Naming the expected field turns a silent "why is my upload empty" into a
    // message a client can act on.
    if (part.fieldname !== 'file') {
      throw new AppError(
        'NO_FILE',
        `Expected the file in a form field named "file", but found "${part.fieldname}".`,
        { expectedField: 'file', receivedField: part.fieldname },
      );
    }

    const { created, result } = await service.ingest({
      stream: part.file,
      filename: part.filename,
      mimetype: part.mimetype,
      wasTruncated: () => part.file.truncated,
    });

    if (created) {
      reply.header('location', `/api/uploads/${result.upload.id}`);
    }
    return reply.code(created ? 201 : 200).send(result);
  });

  /** Newest first, keyset-paginated on the index this table actually has. */
  app.get('/api/uploads', async (request, reply) => {
    const { limit, cursor } = listUploadsQuery.parse(request.query);
    const rows = await repository.listPage(limit, cursor);
    const last = rows.at(-1);

    return reply.send({
      items: rows.map((row) => toUploadView(row, outlierPolicy)),
      // Only claim there is more when the page came back full.
      nextCursor: rows.length === limit && last ? last.id : null,
    });
  });

  app.get('/api/uploads/:id', async (request, reply) => {
    const { id } = uploadIdParams.parse(request.params);
    const row = await repository.findById(id);
    if (!row) {
      throw new AppError('UPLOAD_NOT_FOUND', `No upload with id ${id}`);
    }
    return reply.send(toUploadView(row, outlierPolicy));
  });

  /**
   * The stored bytes.
   *
   * ETag is the content hash, which is not a trick — for content-addressed
   * storage the strongest possible validator is free.
   */
  app.get('/api/uploads/:id/file', async (request, reply) => {
    const { id } = uploadIdParams.parse(request.params);
    const row = await repository.findById(id);
    if (!row) {
      throw new AppError('UPLOAD_NOT_FOUND', `No upload with id ${id}`);
    }

    if (!(await store.exists(row.contentHash))) {
      // Deliberately not a 404: the resource did exist, and GET /api/uploads/:id
      // still proves it. This is the honest failure mode of a filesystem plus a
      // database without a transaction spanning both.
      throw new AppError('FILE_GONE', 'The stored audio for this upload is no longer available.');
    }

    return reply
      .header('content-type', 'audio/mpeg')
      .header('content-length', row.sizeBytes)
      .header('content-disposition', contentDisposition(row.originalName))
      .header('etag', `"${row.contentHash}"`)
      .send(store.openRead(row.contentHash));
  });
}
