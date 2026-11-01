import { INestApplication } from '@nestjs/common';
import { json, urlencoded } from 'express';

/** Register before Nest initializes routes. A scoped jsonParser alone suppresses
 * Nest ExpressAdapter's default parser for every other route. */
export function configureBodyParsers(app: Pick<INestApplication, 'use'>) {
  app.use('/api/collector/file', json({ limit: '6mb' }));
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: true, limit: '100kb' }));
}
