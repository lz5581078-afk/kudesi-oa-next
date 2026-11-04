import { INestApplication } from '@nestjs/common';
import { json, urlencoded } from 'express';

/** Register before Nest initializes routes. A scoped jsonParser alone suppresses
 * Nest ExpressAdapter's default parser for every other route. */
export function configureBodyParsers(app: Pick<INestApplication, 'use'>) {
  app.use('/api/collector/file', json({ limit: '6mb' }));
  // Original shop assistant's JPEG fallback uses base64 JSON (max 900000 chars).
  // Keep this allowance local to its authenticated remote-report path.
  app.use('/api/session-manager/agent/remote', json({ limit: '1mb' }));
  app.use('/api/live/scripts/folders/:id/question-article', json({ limit: '768kb' }));
  app.use('/api/live/scripts/versions', json({ limit: '768kb' }));
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: true, limit: '100kb' }));
}
